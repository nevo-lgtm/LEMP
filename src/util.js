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

function basicAuthOk(req, expectedPassword) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const pass = decoded.slice(idx + 1);
  return pass === expectedPassword;
}

module.exports = { normalizeUrl, domainOf, isValidEmail, basicAuthOk };
