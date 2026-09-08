// v1 matching: pairwise only (no A->B->C->A cycles yet -- that needs more
// liquidity than an early Israeli-market pulse test will have). Two
// approved sites are compatible if they share a niche and their DR is
// within DR_MATCH_TOLERANCE of each other. Each site holds at most one
// active match at a time, so re-running matching after exchanges
// complete/decline is what feeds new rounds -- deliberately simple and
// easy to reason about from the admin screen.

const db = require('./db');

function tolerance() {
  const v = Number(process.env.DR_MATCH_TOLERANCE);
  return Number.isFinite(v) && v > 0 ? v : 0.3;
}

function isCompatible(a, b, tol) {
  if (a.niche !== b.niche) return false;
  const diff = Math.abs(a.dr - b.dr);
  const base = Math.max(a.dr, b.dr, 1);
  return diff / base <= tol;
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

      // Find the closest-DR compatible partner that isn't used yet.
      let best = null;
      let bestDiff = Infinity;
      for (let j = 0; j < group.length; j += 1) {
        if (i === j) continue;
        const b = group[j];
        if (used.has(b.id)) continue;
        if (!isCompatible(a, b, tol)) continue;
        const diff = Math.abs(a.dr - b.dr);
        if (diff < bestDiff) {
          best = b;
          bestDiff = diff;
        }
      }

      if (best) {
        used.add(a.id);
        used.add(best.id);
        const match = db.insertMatch({ siteAId: a.id, siteBId: best.id, niche });
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
