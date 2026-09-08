// Turns crawled page text (see crawler.js) into (a) a best-guess niche
// from the closed NICHES list and (b) a rough set of "phrase tags" --
// the words the site's own pages actually emphasize.
//
// Both are DICTIONARY / FREQUENCY based, not real NLP -- no embeddings,
// no external classification API (matches the "no paid API" constraint
// for this stage). That's a deliberate, cheap starting point: the guess
// pre-fills the batch-approval screen for a human to confirm or correct,
// it never auto-approves on its own authority, and the phrase tags are
// currently a bonus signal in matching (see matching.js), not a hard
// requirement -- both are safe to be rough.

const { NICHE_KEYWORDS } = require('./niches');

const STOPWORDS = new Set(
  [
    // Hebrew
    'של', 'את', 'עם', 'על', 'הוא', 'היא', 'הם', 'הן', 'זה', 'זאת', 'אלה', 'אני', 'אתה', 'אנחנו',
    'אנו', 'יש', 'אין', 'לא', 'כן', 'גם', 'רק', 'כל', 'כמו', 'אבל', 'או', 'אם', 'כי', 'מה', 'איך',
    'מי', 'איפה', 'מתי', 'עוד', 'כבר', 'אחד', 'אחת', 'שתי', 'שני', 'לנו', 'לכם', 'להם', 'בין', 'תוך',
    'לפי', 'אחר', 'אחרי', 'לפני', 'כדי', 'ידי', 'צריך', 'צריכה', 'היה', 'היתה', 'יהיה', 'להיות',
    'שלי', 'שלנו', 'שלך', 'שלכם', 'שלהם', 'כאן', 'היום', 'ברוכים', 'הבאים', 'באתר', 'עבור',
    // English
    'the', 'and', 'for', 'are', 'with', 'that', 'this', 'from', 'your', 'you', 'have', 'has', 'was',
    'were', 'will', 'can', 'all', 'our', 'their', 'about', 'more', 'not', 'but', 'what', 'how', 'who',
    'when', 'where', 'why', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it', 'as', 'by', 'or', 'be',
  ].map((w) => w.toLowerCase())
);

function tokenize(text) {
  return (text.toLowerCase().match(/[֐-׿a-z0-9]+/g) || []).filter(
    (w) => w.length >= 2 && !STOPWORDS.has(w)
  );
}

/**
 * Best-guess niche from NICHES, by counting keyword hits in the text.
 * Returns { niche, confidence } where confidence is 'high' | 'low' |
 * 'none' -- 'none' means nothing matched and it should default to "אחר"
 * with a mandatory review, never a silent guess.
 */
function guessNiche(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      const needle = kw.toLowerCase();
      // Count occurrences, not just presence, so a site that talks
      // heavily about one topic outscores one with an incidental mention.
      const matches = lower.split(needle).length - 1;
      score += matches;
    }
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = niche;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  if (!best || bestScore === 0) {
    return { niche: 'אחר', confidence: 'none' };
  }
  // "High" confidence requires a clear lead over the runner-up, not just
  // a nonzero score -- a near-tie is exactly the case a human should see.
  const confidence = bestScore >= 3 && bestScore > secondScore * 1.5 ? 'high' : 'low';
  return { niche: best, confidence };
}

/**
 * Rough phrase tags: the most frequent single words and adjacent-word
 * pairs in the crawled text, stopwords removed. These are a bonus
 * matching signal (see matching.js), not a hard filter -- rough is fine.
 */
function extractPhrases(text, limit = 8) {
  const words = tokenize(text);
  const counts = new Map();

  for (const w of words) {
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  for (let i = 0; i < words.length - 1; i += 1) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([phrase, count]) => count >= 2 || phrase.includes(' '))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

module.exports = { guessNiche, extractPhrases, tokenize };
