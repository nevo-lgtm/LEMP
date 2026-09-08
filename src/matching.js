// v1 matching: pairwise only (no A->B->C->A cycles yet -- that needs more
// liquidity than an early Israeli-market pulse test will have). Two
// approved sites are compatible if they share a niche and their DR is
// within DR_MATCH_TOLERANCE of each other; among compatible candidates,
// shared detected phrases (see categorize.js) break ties toward the more
// topically-relevant partner. Phrase overlap is a BONUS signal only --
// it never overrides the niche+DR requirement, because phrase detection
// is rough (dictionary/frequency based) and shouldn't be trusted to gate
// a match on its own.
//
// Each site holds at most one active match at a time. Calling
// runMatching() again only ever touches sites that are currently free,
// so running it once a day (see scheduler.js) is what turns this into
// the "one new offer per site per day" drip rather than a flood on
// signup -- no separate per-site function needed.

const db = require('./db');

function tolerance() {
  const v = Number(process.env.DR_MATCH_TOLERANCE);
  return Number.isFinite(v) && v > 0 ? v : 0.3;
}

function isCompatible(a, b, tol) {
  // Never match two sites under the same owner -- a "swap" with yourself
  // isn't a real link exchange and would silently waste a match slot
  // (and, worse, sail straight through the quality gate since both sides
  // are "trusted"). Compare by email rather than submissionId so this
  // still holds across two separate submissions from the same person.
  if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) return false;
  if (a.niche !== b.niche) return false;
  const diff = Math.abs(a.dr - b.dr);
  const base = Math.max(a.dr, b.dr, 1);
  return diff / base <= tol;
}

function phraseOverlapCount(a, b) {
  const setA = new Set(a.detectedPhrases || []);
  if (setA.size === 0) return 0;
  let count = 0;
  for (const phrase of b.detectedPhrases || []) {
    if (setA.has(phrase)) count += 1;
  }
  return count;
}

// Lower is better: normalized DR distance, minus a small bonus per
// shared phrase (capped so phrase overlap can only ever break a
// near-tie, never overrule a much closer DR match).
function candidateScore(a, b) {
  const drDistance = Math.abs(a.dr - b.dr) / Math.max(a.dr, b.dr, 1);
  const overlapBonus = Math.min(phraseOverlapCount(a, b), 3) * 0.03;
  return drDistance - overlapBonus;
}

// Runs one matching pass. Returns a report describing what happened, and
// persists any new match records.
function runMatching() {
  const tol = tolerance();
  const sites = db.listSites().filter((s) => s.status === 'approved');
  const eligible = sites.filter((s) => !db.activeMatchExistsFor(s.id));

  const byNiche = new Map();
  for (const site of eligible) {
    if (!byNiche.has(site.niche)) byNiche.set(site.niche, []);
    byNiche.get(site.niche).push(site);
  }

  const created = [];
  const unmatched = [];

  for (const [niche, group] of byNiche.entries()) {
    group.sort((a, b) => a.dr - b.dr);
    const used = new Set();

    for (let i = 0; i < group.length; i += 1) {
      const a = group[i];
      if (used.has(a.id)) continue;

      let best = null;
      let bestScore = Infinity;
      for (let j = 0; j < group.length; j += 1) {
        if (i === j) continue;
        const b = group[j];
        if (used.has(b.id)) continue;
        if (!isCompatible(a, b, tol)) continue;
        const score = candidateScore(a, b);
        if (score < bestScore) {
          best = b;
          bestScore = score;
        }
      }

      if (best) {
        used.add(a.id);
        used.add(best.id);
        const match = db.insertMatch({ siteAId: a.id, siteBId: best.id, niche });
        db.bumpReliability(a.id, { offered: 1 });
        db.bumpReliability(best.id, { offered: 1 });
        created.push(match);
      }
    }

    for (const site of group) {
      if (!used.has(site.id)) unmatched.push({ ...site, niche });
    }
  }

  return { created, unmatched, tolerance: tol };
}

module.exports = { runMatching, isCompatible, tolerance };
