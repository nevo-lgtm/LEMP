require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');

const db = require('./src/db');
const { fetchMetrics, PROVIDER } = require('./src/metrics');
const qualityGate = require('./src/qualityGate');
const matching = require('./src/matching');
const scheduler = require('./src/scheduler');
const { recentMockEmails, PROVIDER: EMAIL_PROVIDER } = require('./src/emailer');
const { NICHES } = require('./src/niches');
const { normalizeUrl, domainOf, isValidEmail, parseDomainList, basicAuthOk } = require('./src/util');
const { processSubmissionInBackground } = require('./src/pipeline');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_DOMAINS_PER_SUBMISSION = Number(process.env.MAX_DOMAINS_PER_SUBMISSION) || 100;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- labels ----------

function siteStatusLabelHe(status) {
  const map = {
    processing: 'מנתחים את האתר...',
    awaiting_owner_review: 'ממתין לאישורך',
    pending_review: 'ממתין לבדיקה ידנית שלנו',
    approved: 'פעיל, ממתין להתאמות',
    rejected: 'נדחה',
  };
  return map[status] || status;
}

function matchStatusLabelHe(m) {
  const map = {
    proposed: 'הצעת התאמה חדשה',
    confirmed_a: 'צד אחד אישר',
    confirmed_b: 'צד אחד אישר',
    revealed: 'פרטי הקשר נחשפו',
    completed: 'מאומת — הקישורים חיים',
    link_removed: 'אחד הקישורים הוסר',
    declined: 'ההתאמה בוטלה',
  };
  return map[m.status] || m.status;
}

function sideOf(match, siteId) {
  if (match.siteAId === siteId) return 'a';
  if (match.siteBId === siteId) return 'b';
  return null;
}

function otherSiteId(match, siteId) {
  return sideOf(match, siteId) === 'a' ? match.siteBId : match.siteAId;
}

function isRevealedTo(match) {
  return ['revealed', 'completed', 'link_removed'].includes(match.status);
}

// Builds the view-model for one match from the perspective of `site`.
function describeMatch(match, site) {
  const mySide = sideOf(match, site.id);
  const revealed = isRevealedTo(match);
  const partner = revealed ? db.getSite(otherSiteId(match, site.id)) : null;

  const iHaveConfirmed =
    revealed ||
    (match.status === 'confirmed_a' && mySide === 'a') ||
    (match.status === 'confirmed_b' && mySide === 'b');
  const canRespond = match.status !== 'declined' && !revealed && !iHaveConfirmed;

  const myPlacementUrl = mySide === 'a' ? match.placementUrlA : match.placementUrlB;
  const partnerPlacementUrl = mySide === 'a' ? match.placementUrlB : match.placementUrlA;
  const myVerified = mySide === 'a' ? match.verifiedA : match.verifiedB;
  const partnerVerified = mySide === 'a' ? match.verifiedB : match.verifiedA;
  const canSubmitPlacement = revealed && match.status !== 'declined' && !myPlacementUrl;

  return {
    ...match,
    mySide,
    revealed,
    partner,
    canRespond,
    canSubmitPlacement,
    myPlacementUrl,
    partnerPlacementUrl,
    myVerified: !!myVerified,
    partnerVerified: !!partnerVerified,
    statusLabel: matchStatusLabelHe(match),
  };
}

// ---------- public: bulk signup ----------

app.get('/', (req, res) => {
  res.render('index', { error: null, values: {} });
});

app.post('/submit', upload.single('domainsFile'), async (req, res) => {
  const { email } = req.body;
  const textDomains = req.body.domainsText || '';
  const fileText = req.file ? req.file.buffer.toString('utf8') : '';

  if (!isValidEmail(email)) {
    return res.status(400).render('index', {
      error: 'נא למלא כתובת מייל תקינה.',
      values: { email, domainsText: textDomains },
    });
  }

  const domains = parseDomainList(`${textDomains}\n${fileText}`).slice(0, MAX_DOMAINS_PER_SUBMISSION);
  if (domains.length === 0) {
    return res.status(400).render('index', {
      error: 'לא זיהינו אף דומיין תקין — הדביקו רשימה או העלו קובץ CSV עם עמודת דומיינים.',
      values: { email, domainsText: textDomains },
    });
  }

  const submission = db.insertSubmission({ email: email.trim(), domainCount: domains.length });

  const siteIds = [];
  const skipped = [];
  for (const domain of domains) {
    const existing = db.findSiteByDomain(domain);
    if (existing) {
      skipped.push(domain);
      continue;
    }
    const urlObj = normalizeUrl(domain);
    const site = db.insertSite({
      submissionId: submission.id,
      email: email.trim(),
      url: urlObj ? urlObj.toString() : `https://${domain}`,
      domain,
      niche: 'אחר',
      status: 'processing',
    });
    siteIds.push(site.id);
  }

  if (skipped.length > 0) {
    db.updateSubmission(submission.id, { skippedDomains: skipped });
  }

  processSubmissionInBackground(siteIds);

  res.redirect(`/s/${submission.secretToken}`);
});

// ---------- public: submission dashboard (secret-link auth) ----------

app.get('/s/:token', (req, res) => {
  const submission = db.getSubmissionByToken(req.params.token);
  if (!submission) {
    return res.status(404).send('קישור לא נמצא. ודא שהעתקת את הכתובת המלאה ששמרת בהרשמה.');
  }

  const sites = db.sitesForSubmission(submission.id).sort((a, b) => a.domain.localeCompare(b.domain));
  const stillProcessing = sites.some((s) => s.status === 'processing');

  const awaitingReview = sites.filter((s) => s.status === 'awaiting_owner_review');
  const rejected = sites.filter((s) => s.status === 'rejected');
  const live = sites.filter((s) => s.status === 'approved' || s.status === 'pending_review');

  const liveWithMatches = live.map((site) => ({
    site,
    matches: db
      .matchesForSite(site.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((m) => describeMatch(m, site)),
  }));

  res.render('submission', {
    submission,
    stillProcessing,
    awaitingReview,
    rejected,
    liveWithMatches,
    niches: NICHES,
    error: req.query.error || null,
    flash: req.query.flash || null,
  });
});

app.post('/s/:token/confirm', (req, res) => {
  const submission = db.getSubmissionByToken(req.params.token);
  if (!submission) return res.status(404).send('קישור לא נמצא.');

  const sites = db.sitesForSubmission(submission.id).filter((s) => s.status === 'awaiting_owner_review');
  for (const site of sites) {
    const chosenNiche = req.body[`niche_${site.id}`];
    const niche = NICHES.includes(chosenNiche) ? chosenNiche : site.niche;
    db.updateSite(site.id, { niche, status: site.gateVerdict });
  }

  res.redirect(`/s/${req.params.token}?flash=${encodeURIComponent('האתרים אושרו ונכנסו לתור ההתאמות.')}`);
});

// ---------- public: match actions (scoped to the caller's own site) ----------

function loadMatchForSubmission(token, matchId) {
  const submission = db.getSubmissionByToken(token);
  if (!submission) return { error: 'not_found' };
  const match = db.getMatch(matchId);
  if (!match) return { error: 'not_found' };

  const mySiteIds = new Set(db.sitesForSubmission(submission.id).map((s) => s.id));
  const siteId = mySiteIds.has(match.siteAId) ? match.siteAId : mySiteIds.has(match.siteBId) ? match.siteBId : null;
  if (!siteId) return { error: 'forbidden' };

  return { submission, match, site: db.getSite(siteId) };
}

app.post('/s/:token/matches/:matchId/confirm', (req, res) => {
  const { match, site, error } = loadMatchForSubmission(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');

  const side = sideOf(match, site.id);
  let nextStatus = match.status;
  if (match.status === 'proposed') {
    nextStatus = side === 'a' ? 'confirmed_a' : 'confirmed_b';
  } else if (
    (match.status === 'confirmed_a' && side === 'b') ||
    (match.status === 'confirmed_b' && side === 'a')
  ) {
    nextStatus = 'revealed';
  }

  const patch = { status: nextStatus };
  if (nextStatus === 'revealed') patch.revealedAt = new Date().toISOString();
  db.updateMatch(match.id, patch);
  res.redirect(`/s/${req.params.token}`);
});

app.post('/s/:token/matches/:matchId/decline', (req, res) => {
  const { match, site, error } = loadMatchForSubmission(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');
  db.updateMatch(match.id, { status: 'declined', declinedBy: site.id });
  res.redirect(`/s/${req.params.token}`);
});

app.post('/s/:token/matches/:matchId/placement', (req, res) => {
  const { match, site, error } = loadMatchForSubmission(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');

  const urlObj = normalizeUrl(req.body.placementUrl);
  if (!isRevealedTo(match) || match.status === 'declined') {
    return res.redirect(`/s/${req.params.token}`);
  }
  if (!urlObj) {
    return res.redirect(
      `/s/${req.params.token}?error=${encodeURIComponent('כתובת העמוד שהזנת לא תקינה.')}`
    );
  }

  const side = sideOf(match, site.id);
  const patch =
    side === 'a'
      ? { placementUrlA: urlObj.toString(), placedAtA: new Date().toISOString() }
      : { placementUrlB: urlObj.toString(), placedAtB: new Date().toISOString() };
  db.updateMatch(match.id, patch);
  res.redirect(`/s/${req.params.token}`);
});

// ---------- admin ----------

app.use('/admin', (req, res, next) => {
  if (basicAuthOk(req, ADMIN_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).send('נדרש אימות.');
});

app.get('/admin', (req, res) => {
  const sites = db.listSites();
  const matches = db.listMatches();

  const stats = {
    totalSites: sites.length,
    processing: sites.filter((s) => s.status === 'processing' || s.status === 'awaiting_owner_review').length,
    approved: sites.filter((s) => s.status === 'approved').length,
    pendingReview: sites.filter((s) => s.status === 'pending_review').length,
    rejected: sites.filter((s) => s.status === 'rejected').length,
    matchesProposed: matches.length,
    matchesRevealed: matches.filter((m) => isRevealedTo(m)).length,
    matchesCompleted: matches.filter((m) => m.status === 'completed').length,
    matchesBroken: matches.filter((m) => m.status === 'link_removed').length,
    matchesDeclined: matches.filter((m) => m.status === 'declined').length,
  };

  const reviewQueue = sites
    .filter((s) => s.status === 'pending_review')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const reliabilityRows = sites
    .filter((s) => s.status === 'approved' || (s.reliability && s.reliability.offered > 0))
    .map((s) => ({
      domain: s.domain,
      niche: s.niche,
      ...{ offered: 0, verified: 0, noShow: 0, removedAfterReciprocation: 0 },
      ...(s.reliability || {}),
    }))
    .sort((a, b) => b.offered - a.offered);

  const matchRows = matches
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((m) => ({
      ...m,
      siteA: db.getSite(m.siteAId),
      siteB: db.getSite(m.siteBId),
      statusLabel: matchStatusLabelHe(m),
    }));

  res.render('admin', {
    stats,
    reviewQueue,
    sites: sites.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    matchRows,
    reliabilityRows,
    notifications: recentMockEmails(20),
    metricsProvider: PROVIDER,
    emailProvider: EMAIL_PROVIDER,
    thresholds: qualityGate.getThresholds(),
    tolerance: matching.tolerance(),
    schedulerState: scheduler.readState(),
    flash: req.query.flash || null,
  });
});

app.post('/admin/sites/:id/approve', (req, res) => {
  db.updateSite(req.params.id, { status: 'approved', reviewedAt: new Date().toISOString() });
  res.redirect('/admin?flash=' + encodeURIComponent('האתר אושר.'));
});

app.post('/admin/sites/:id/reject', (req, res) => {
  db.updateSite(req.params.id, { status: 'rejected', reviewedAt: new Date().toISOString() });
  res.redirect('/admin?flash=' + encodeURIComponent('האתר נדחה.'));
});

app.post('/admin/run-drip', async (req, res) => {
  const report = await scheduler.runDrip();
  const msg = `נוצרו ${report.created.length} התאמות חדשות (התראות נשלחו). ${report.unmatched.length} אתרים נשארו ללא זוג בסבב הזה.`;
  res.redirect('/admin?flash=' + encodeURIComponent(msg));
});

app.post('/admin/run-verification', async (req, res) => {
  const noShows = scheduler.sweepNoShows();
  const verification = await scheduler.sweepVerification();
  const msg = `נבדקו ${verification.checked} התאמות, ${noShows.declined} סומנו כ-no-show ובוטלו.`;
  res.redirect('/admin?flash=' + encodeURIComponent(msg));
});

app.listen(PORT, () => {
  console.log(`Link-exchange MVP running at ${BASE_URL} (metrics: ${PROVIDER}, email: ${EMAIL_PROVIDER})`);
  console.log(`Admin panel: ${BASE_URL}/admin (password from ADMIN_PASSWORD in .env)`);
  scheduler.startScheduler();
});
