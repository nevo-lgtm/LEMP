// Fixed niche list for v1 -- deliberately a closed list rather than free
// text or NLP-based topical matching. It's coarse, but it's honest about
// what it is, it's instant to implement, and it's enough signal for a
// pulse test. Refine into subcategories or swap for embeddings once you
// have real volume and can see where "same category, still irrelevant"
// matches actually happen.

const NICHES = [
  'נדל"ן',
  'פיננסים וביטוח',
  'בריאות ורפואה',
  'טכנולוגיה והייטק',
  'אוכל ומסעדות',
  'אופנה ויופי',
  'נסיעות ותיירות',
  'חינוך והכשרות',
  'רכב',
  'בית וגינה',
  'עסקים, שיווק ופרסום',
  'משפטים',
  'ספורט וכושר',
  'אחר',
];

module.exports = { NICHES };
