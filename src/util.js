function normalizeUrl(input) {
  let raw = (input || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    return u;
  } catch (err) {
    return null;
  }
}

function domainOf(urlObj) {
  return urlObj.hostname.replace(/^www\./i, '').toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// Parses a blob of user-supplied text (a textarea paste, or the raw
// contents of an uploaded .csv) into a deduped list of normalized
// domains. Splits on newlines, commas AND semicolons so a one-column CSV
// (with or without a header row) and a plain pasted list both work; any
// token that isn't a parseable URL/domain is silently dropped rather
// than failing the whole batch -- a bulk upload with a couple of typos
// should still process everything else.
function parseDomainList(rawText) {
  const tokens = (rawText || '')
    .split(/[\r\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const domains = new Set();
  for (const token of tokens) {
    // Skip an obvious CSV header cell.
    if (/^(domain|url|website|אתר|דומיין|כתובת)$/i.test(token)) continue;
    const urlObj = normalizeUrl(token);
    if (urlObj) domains.add(domainOf(urlObj));
  }
  return [...domains];
}

function basicAuthOk(req, expectedPassword) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const pass = decoded.slice(idx + 1);
  return pass === expectedPassword;
}

module.exports = { normalizeUrl, domainOf, isValidEmail, parseDomainList, basicAuthOk };
