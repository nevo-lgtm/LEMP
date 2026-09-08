// A daily job runner, in-process -- no cron dependency, no external
// scheduler service (keeps the "clone and npm start anywhere" property).
// A single setInterval checks every CHECK_INTERVAL_MS whether 24h have
// passed since each job last ran (persisted in
// data/scheduler-state.json, so a restart doesn't reset the clock or
// double-fire), and runs it if so. Admin can also trigger either job
// immediately from the admin panel.
//
// Two jobs:
//   1. Drip matching -- one runMatching() pass (only ever touches sites
//      that are currently free, see matching.js), then emails both
//      sides of every newly-created match.
//   2. Verification sweep -- checks placement URLs for matches that have
//      them, flags no-shows (revealed too long without a placement URL),
//      and re-checks previously-verified links to catch removal.

const fs = require('fs');
const path = require('path');

const db = require('./db');
const matching = require('./matching');
const { sendEmail } = require('./emailer');
const { checkLinkOnPage } = require('./verifier');

const STATE_FILE = path.join(__dirname, '..', 'data', 'scheduler-state.json');
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check hourly whether a daily job is due
const DAY_MS = 24 * 60 * 60 * 1000;

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

const NO_SHOW_DAYS = numEnv('NO_SHOW_DAYS', 5);
const RECHECK_DAYS = numEnv('VERIFICATION_RECHECK_DAYS', 7);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function daysAgo(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / DAY_MS;
}

function siteLine(site) {
  return `${site.domain} (${site.niche}, DR ${site.dr})`;
}

async function notifyNewMatch(site, partner) {
  const base = process.env.BASE_URL || '';
  const link = site.submissionId
    ? `${base}/s/${site.secretToken}`
    : `${base}/me/${site.secretToken}`;
  const subject = `הצעת קישור חדשה עבור ${site.domain}`;
  const body = [
    `שלום,`,
    ``,
    `נמצאה עבור ${siteLine(site)} הצעת החלפת קישור עם אתר בתחום ${partner.niche} (ציון דומה).`,
    `כדי לאשר או לדחות את ההצעה, היכנסו לדשבורד שלכם:`,
    link,
    ``,
    `פרטי האתר השני יתגלו רק אחרי ששני הצדדים יאשרו.`,
  ].join('\n');
  try {
    await sendEmail(site.email, subject, body);
  } catch (err) {
    console.error(`[scheduler] failed to notify ${site.email}:`, err.message);
  }
}

async function runDrip() {
  const report = matching.runMatching();
  for (const match of report.created) {
    const a = db.getSite(match.siteAId);
    const b = db.getSite(match.siteBId);
    if (a && b) {
      await notifyNewMatch(a, b);
      await notifyNewMatch(b, a);
    }
  }
  writeState({ ...readState(), lastDripRunAt: new Date().toISOString() });
  return report;
}

// Matches stuck in 'revealed' for too long without both placement URLs
// are treated as no-shows: the non-compliant side's reliability takes a
// hit, and the match is freed up (declined) so both sites can be
// re-matched instead of staying blocked on a partner who never showed.
function sweepNoShows() {
  const matches = db.listMatches().filter((m) => m.status === 'revealed');
  let declined = 0;
  for (const m of matches) {
    if (daysAgo(m.revealedAt) < NO_SHOW_DAYS) continue;
    if (!m.placementUrlA) db.bumpReliability(m.siteAId, { noShow: 1 });
    if (!m.placementUrlB) db.bumpReliability(m.siteBId, { noShow: 1 });
    if (!m.placementUrlA || !m.placementUrlB) {
      db.updateMatch(m.id, { status: 'declined', declinedBy: 'system_no_show' });
      declined += 1;
    }
  }
  return { declined };
}

// Verifies matches that have both placement URLs and either have never
// been checked, or are due for a recheck. Flags previously-verified
// links that have since disappeared.
async function sweepVerification() {
  const matches = db
    .listMatches()
    .filter((m) => m.placementUrlA && m.placementUrlB && m.status !== 'declined');

  let checked = 0;
  for (const m of matches) {
    if (m.status === 'completed' && daysAgo(m.lastCheckedAt) < RECHECK_DAYS) continue;

    const siteA = db.getSite(m.siteAId);
    const siteB = db.getSite(m.siteBId);
    if (!siteA || !siteB) continue;

    const [resultA, resultB] = await Promise.all([
      checkLinkOnPage(m.placementUrlA, siteB.domain),
      checkLinkOnPage(m.placementUrlB, siteA.domain),
    ]);
    checked += 1;

    const wasFullyVerified = m.status === 'completed';
    const nowFullyVerified = resultA.found && resultB.found;

    const patch = {
      verifiedA: resultA.found,
      verifiedB: resultB.found,
      anchorTextA: resultA.anchorText || m.anchorTextA,
      anchorTextB: resultB.anchorText || m.anchorTextB,
      relA: resultA.rel ?? m.relA,
      relB: resultB.rel ?? m.relB,
      lastCheckedAt: new Date().toISOString(),
    };

    if (nowFullyVerified && !wasFullyVerified) {
      patch.status = 'completed';
      patch.firstVerifiedAt = m.firstVerifiedAt || new Date().toISOString();
      db.bumpReliability(siteA.id, { verified: 1 });
      db.bumpReliability(siteB.id, { verified: 1 });
    } else if (wasFullyVerified && !nowFullyVerified) {
      // placementUrlA is site A's own page, carrying the link it gave to
      // B -- so resultA.found going false means A is the one who took
      // the link down. Penalize whichever side actually broke their end.
      patch.status = 'link_removed';
      patch.brokenSince = new Date().toISOString();
      if (!resultA.found) db.bumpReliability(siteA.id, { removedAfterReciprocation: 1 });
      if (!resultB.found) db.bumpReliability(siteB.id, { removedAfterReciprocation: 1 });
    }

    db.updateMatch(m.id, patch);
  }
  writeState({ ...readState(), lastVerificationRunAt: new Date().toISOString() });
  return { checked };
}

async function runDailyJobsIfDue() {
  const state = readState();
  if (daysAgo(state.lastDripRunAt) >= 1) {
    try {
      await runDrip();
    } catch (err) {
      console.error('[scheduler] drip run failed:', err.message);
    }
  }
  if (daysAgo(state.lastVerificationRunAt) >= 1) {
    try {
      sweepNoShows();
      await sweepVerification();
    } catch (err) {
      console.error('[scheduler] verification run failed:', err.message);
    }
  }
}

function startScheduler() {
  runDailyJobsIfDue(); // catch up immediately on boot if a day was missed
  setInterval(runDailyJobsIfDue, CHECK_INTERVAL_MS);
}

module.exports = {
  startScheduler,
  runDrip,
  sweepNoShows,
  sweepVerification,
  readState,
};
