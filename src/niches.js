// Fixed niche list -- deliberately a closed list rather than free text or
// embeddings-based topical matching. It's coarse, but it's honest about
// what it is, cheap to implement, and enough signal for a pulse test.
// Refine into subcategories or swap for a real classifier once you have
// volume and can see where "same category, still irrelevant" matches
// actually happen.
//
// NICHE_KEYWORDS backs the auto-categorizer (see categorize.js): each
// niche maps to Hebrew + English words/phrases that, found on a site's
// crawled pages, vote for that niche. It's a blunt instrument -- a
// dictionary match, not real NLP -- and it's meant to PRE-FILL the
// category for a human to confirm on the batch-approval screen, not to
// make an unreviewable final call.

const NICHE_KEYWORDS = {
  'נדל"ן': ['נדלן', 'נדל"ן', 'דירה', 'דירות', 'משכנתא', 'נכס', 'נכסים', 'תיווך', 'real estate', 'property', 'mortgage', 'apartment'],
  'פיננסים וביטוח': ['ביטוח', 'פיננס', 'פיננסי', 'הלוואה', 'הלוואות', 'חיסכון', 'פנסיה', 'קרן', 'השקעות', 'insurance', 'finance', 'loan', 'investment', 'pension'],
  'בריאות ורפואה': ['רפואה', 'רפואי', 'קליניקה', 'מרפאה', 'בריאות', 'רופא', 'טיפול', 'קלינ', 'health', 'clinic', 'medical', 'doctor', 'therapy'],
  'טכנולוגיה והייטק': ['טכנולוגיה', 'הייטק', 'תוכנה', 'אפליקציה', 'סטארטאפ', 'פיתוח', 'תוכנת', 'saas', 'software', 'startup', 'app', 'technology', 'developer', 'api'],
  'אוכל ומסעדות': ['מסעדה', 'מסעדות', 'אוכל', 'מתכון', 'מתכונים', 'שף', 'תפריט', 'קייטרינג', 'restaurant', 'recipe', 'food', 'menu', 'chef', 'catering'],
  'אופנה ויופי': ['אופנה', 'בגדים', 'יופי', 'קוסמטיקה', 'איפור', 'עיצוב שיער', 'fashion', 'beauty', 'cosmetics', 'makeup', 'clothing', 'style'],
  'נסיעות ותיירות': ['תיירות', 'טיולים', 'טיסות', 'מלון', 'מלונות', 'נופש', 'חופשה', 'travel', 'tourism', 'flight', 'hotel', 'vacation', 'trip'],
  'חינוך והכשרות': ['חינוך', 'הכשרה', 'הכשרות', 'קורס', 'קורסים', 'לימודים', 'הדרכה', 'education', 'course', 'training', 'learning', 'academy'],
  'רכב': ['רכב', 'רכבים', 'מכונית', 'מוסך', 'ליסינג', 'צמיגים', 'car', 'vehicle', 'automotive', 'garage', 'leasing', 'tires'],
  'בית וגינה': ['שיפוצים', 'עיצוב פנים', 'גינה', 'גינון', 'ריהוט', 'בית חכם', 'home', 'garden', 'furniture', 'renovation', 'interior design'],
  'עסקים, שיווק ופרסום': ['שיווק', 'פרסום', 'קידום אתרים', 'seo', 'עסקים', 'סטרטגיה', 'מיתוג', 'marketing', 'advertising', 'branding', 'business', 'agency'],
  'משפטים': ['עורך דין', 'עורכי דין', 'משפטי', 'משפטים', 'ייעוץ משפטי', 'law', 'legal', 'attorney', 'lawyer'],
  'ספורט וכושר': ['כושר', 'ספורט', 'אימון', 'חדר כושר', 'תזונה ספורטיבית', 'fitness', 'sport', 'gym', 'workout', 'training'],
};

const NICHES = [...Object.keys(NICHE_KEYWORDS), 'אחר'];

module.exports = { NICHES, NICHE_KEYWORDS };
