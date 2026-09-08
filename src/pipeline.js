// Turns a freshly-inserted 'processing' site record into one ready for
// the owner's batch-approval screen: crawl it, guess its niche/phrases,
// fetch its DR/spam/traffic metrics, and run the quality gate -- all
// without blocking the HTTP request that created the record (see
// server.js, which fires this and redirects immediately).
//
// The quality gate's verdict is computed and stored (`gateVerdict`) but
// NOT applied to `status` yet for anything other than a hard reject --
// approving/pending-review still waits on the owner confirming (or
// correcting) the detected niche on the submission page. A hard reject
// needs no owner action, so it's applied immediately and shown to them
// read-only for transparency.

const db = require('./db');
const { crawlSite } = require('./crawler');
const { guessNiche, extractPhrases } = require('./categorize');
const { fetchMetrics } = require('./metrics');
const qualityGate = require('./qualityGate');

async function processSite(siteId) {
  const site = db.getSite(siteId);
  if (!site) return;

  let crawl;
  try {
    crawl = await crawlSite(site.domain);
  } catch (err) {
    crawl = { pages: [], text: '', error: err.message };
  }

  const { niche, confidence } = guessNiche(crawl.text);
  const phrases = extractPhrases(crawl.text);

  let metrics;
  try {
    metrics = await fetchMetrics(site.domain);
  } catch (err) {
    db.updateSite(siteId, {
      status: 'rejected',
      gateReasons: [`שגיאה בשליפת נתוני האתר: ${err.message}`],
    });
    return;
  }

  const gate = qualityGate.evaluate(metrics);
  // Niche detection failing entirely (or landing on a near-tie) is, on
  // its own, a reason for a human to look before the site goes live --
  // it downgrades an otherwise-clean "approved" verdict to review, but
  // never upgrades a hard reject.
  let gateVerdict = gate.status;
  let gateReasons = gate.reasons;
  if (confidence === 'none' && gateVerdict === 'approved') {
    gateVerdict = 'pending_review';
    gateReasons = [...gateReasons, 'לא זוהתה נישה ברורה אוטומטית'];
  }

  const patch = {
    dr: metrics.dr,
    spamScore: metrics.spamScore,
    trafficEstimate: metrics.trafficEstimate,
    metricsSource: metrics.source,
    detectedNiche: niche,
    nicheConfidence: confidence,
    niche, // pre-fill; the owner can override on the approval screen
    detectedPhrases: phrases,
    crawledPages: crawl.pages.map((p) => p.url),
    crawlError: crawl.error || null,
    gateVerdict,
    gateReasons,
  };

  patch.status = gateVerdict === 'rejected' ? 'rejected' : 'awaiting_owner_review';
  db.updateSite(siteId, patch);
}

/** Fire-and-forget: process every site in a submission without blocking
 * the caller. Each site is independent -- one failing doesn't stop the
 * rest. */
function processSubmissionInBackground(siteIds) {
  for (const siteId of siteIds) {
    processSite(siteId).catch((err) => {
      console.error(`[pipeline] site ${siteId} failed:`, err);
      db.updateSite(siteId, {
        status: 'rejected',
        gateReasons: [`שגיאה בעיבוד: ${err.message}`],
      });
    });
  }
}

module.exports = { processSite, processSubmissionInBackground };
