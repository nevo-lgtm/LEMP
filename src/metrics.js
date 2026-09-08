// Site-metrics provider.
//
// This is the one module you MUST swap before trusting the quality gate
// with real money/reputation. It exposes a single async function,
// fetchMetrics(domain), that always resolves to:
//   { dr: 0-100, spamScore: 0-100, trafficEstimate: number, source: string }
//
// dr          ~ "how strong is this site" (Ahrefs-DR-like, 0-100)
// spamScore   ~ "how risky/spammy does this site look" (0-100, higher = worse)
// trafficEstimate ~ rough monthly organic visits
//
// Two providers are implemented:
//   - mock: deterministic fake numbers, no API key needed. Lets you run
//     and demo the entire product today. Every mock value is tagged
//     source: 'mock' and the UI renders a visible "מדומה" (simulated)
//     badge next to it -- never silently shown as if it were real.
//   - external: a thin template for a real provider (Moz Links API is
//     used as the example). Auth schemes on third-party SEO APIs change
//     over time, so treat the fetch call below as a starting point to
//     verify against that provider's current docs, not as pre-verified
//     production code.

const PROVIDER = (process.env.METRICS_PROVIDER || 'mock').toLowerCase();

function hashString(str) {
  // Small, fast, deterministic string hash (djb2). Not cryptographic --
  // we only need "same domain -> same fake numbers every run".
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

// Deterministic PRNG seeded from the hash, so repeated calls for the same
// domain are stable across process restarts (important: otherwise a
// site's DR would jitter every time matching re-runs).
function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function mockMetrics(domain) {
  const rand = mulberry32(hashString(domain));
  const dr = Math.round(rand() * 65 + 3); // 3-68
  // Spam score skewed low (most sites are fine), with an occasional spike,
  // so the review queue and the reject path both get exercised in testing.
  const spamRoll = rand();
  const spamScore = Math.round(spamRoll < 0.85 ? spamRoll * 25 : 40 + spamRoll * 60);
  const trafficEstimate = Math.round(rand() * 20000 + 20);
  return {
    dr,
    spamScore: Math.min(spamScore, 100),
    trafficEstimate,
    source: 'mock',
  };
}

async function externalMetrics(domain) {
  const accessId = process.env.MOZ_ACCESS_ID;
  const secretKey = process.env.MOZ_SECRET_KEY;
  if (!accessId || !secretKey) {
    throw new Error(
      'METRICS_PROVIDER=external but MOZ_ACCESS_ID / MOZ_SECRET_KEY are not set in .env'
    );
  }

  // TEMPLATE ONLY -- verify request shape/auth against the provider's
  // current API docs before relying on this in production. Left
  // deliberately explicit (no SDK) so it's obvious what to change if the
  // provider or the auth scheme changes.
  const auth = Buffer.from(`${accessId}:${secretKey}`).toString('base64');
  const res = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ targets: [domain] }),
  });

  if (!res.ok) {
    throw new Error(`Metrics provider request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const result = Array.isArray(data.results) ? data.results[0] : data;

  // Field names below are indicative -- map them to whatever the real
  // response actually contains once you've tested against a live key.
  return {
    dr: Math.round(result.domain_authority ?? 0),
    spamScore: Math.round((result.spam_score ?? 0) * (100 / 17)), // Moz's classic scale is 0-17
    trafficEstimate: Math.round(result.estimated_traffic ?? 0),
    source: 'external',
  };
}

async function fetchMetrics(domain) {
  if (PROVIDER === 'external') {
    return externalMetrics(domain);
  }
  return mockMetrics(domain);
}

module.exports = { fetchMetrics, PROVIDER };
