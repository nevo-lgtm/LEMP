// The quality gate is the actual product, not the plumbing around it --
// see the discussion this MVP came out of: an exchange platform is only
// as trustworthy as its ability to say no to spammy / low-value sites.
//
// v1 is deliberately simple (three numeric thresholds, no PBN-footprint
// or anchor-text heuristics yet) but it is a REAL automatic gate, not a
// placeholder: most sites are auto-approved or auto-rejected without a
// human touching them, and only genuinely borderline cases reach the
// admin review queue.

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function getThresholds() {
  return {
    minDr: num('MIN_DR', 10),
    maxSpamScore: num('MAX_SPAM_SCORE', 30),
    minTraffic: num('MIN_TRAFFIC', 50),
    reviewBandSpam: num('REVIEW_BAND_SPAM', 10),
    reviewBandDr: num('REVIEW_BAND_DR', 5),
  };
}

// Returns { status: 'approved' | 'pending_review' | 'rejected', reasons: string[] }
function evaluate(metrics) {
  const t = getThresholds();
  const { dr, spamScore, trafficEstimate } = metrics;
  const reasons = [];

  let hardReject = false;
  let needsReview = false;

  if (spamScore > t.maxSpamScore + t.reviewBandSpam) {
    hardReject = true;
    reasons.push(`ציון ספאם גבוה מדי (${spamScore}, סף דחייה ${t.maxSpamScore + t.reviewBandSpam})`);
  } else if (spamScore > t.maxSpamScore) {
    needsReview = true;
    reasons.push(`ציון ספאם גבולי (${spamScore}, סף ${t.maxSpamScore})`);
  }

  const hardDrFloor = Math.max(0, t.minDr - t.reviewBandDr);
  if (dr < hardDrFloor) {
    hardReject = true;
    reasons.push(`חוזק אתר (DR) נמוך מדי (${dr}, סף דחייה ${hardDrFloor})`);
  } else if (dr < t.minDr) {
    needsReview = true;
    reasons.push(`חוזק אתר (DR) גבולי (${dr}, סף ${t.minDr})`);
  }

  if (trafficEstimate < t.minTraffic) {
    needsReview = true;
    reasons.push(`תעבורה משוערת נמוכה (${trafficEstimate}, סף ${t.minTraffic})`);
  }

  let status = 'approved';
  if (hardReject) status = 'rejected';
  else if (needsReview) status = 'pending_review';

  if (reasons.length === 0) reasons.push('עומד בכל הסבים אוטומטית');

  return { status, reasons, thresholds: t };
}

module.exports = { evaluate, getThresholds };
