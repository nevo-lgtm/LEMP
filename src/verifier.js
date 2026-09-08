// Checks whether a page actually contains a link to a given domain --
// used to confirm a placed link is real (not just self-reported) and,
// on repeat checks, to catch a link that was removed after the other
// side reciprocated ("hit and run").
//
// Plain HTTP fetch + regex, same as crawler.js: this does NOT execute
// JavaScript, so a link injected client-side (a React/SPA site) will not
// be seen. That's a known, documented limitation -- a headless browser
// would close it at real infrastructure cost, not a fit for this stage.

const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'LinkExchangeMVP-Verifier/1.0 (+checking a placed backlink)';

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch `pageUrl` and look for an <a> tag pointing at `targetDomain`.
 * Never throws -- returns { found: false, error } on any failure so a
 * dead placement URL degrades to "not verified" rather than crashing
 * the verification job.
 */
async function checkLinkOnPage(pageUrl, targetDomain) {
  let res;
  try {
    res = await fetchWithTimeout(pageUrl);
  } catch (err) {
    return { found: false, error: err.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  }
  if (!res.ok) {
    return { found: false, error: `http_${res.status}` };
  }

  let html;
  try {
    html = await res.text();
  } catch {
    return { found: false, error: 'body_read_failed' };
  }

  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const domainNeedle = targetDomain.replace(/^www\./, '').toLowerCase();

  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    const [, attrs, inner] = match;
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    let hrefDomain;
    try {
      hrefDomain = new URL(hrefMatch[1], pageUrl).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }
    if (hrefDomain !== domainNeedle) continue;

    const relMatch = attrs.match(/rel=["']([^"']+)["']/i);
    const anchorText = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return {
      found: true,
      anchorText: anchorText.slice(0, 200),
      rel: relMatch ? relMatch[1] : null,
      checkedAt: new Date().toISOString(),
    };
  }

  return { found: false, checkedAt: new Date().toISOString() };
}

module.exports = { checkLinkOnPage };
