// Lightweight, dependency-free site crawler used to gather signal for
// niche/phrase detection (see categorize.js). Deliberately shallow:
//
//   1. Try /robots.txt -- if the whole site is disallowed for "*", stop.
//   2. Try /sitemap.xml (and, one level deep, a sitemap index) for a real
//      list of the site's own pages.
//   3. If there's no sitemap, fall back to extracting same-domain links
//      from the homepage itself.
//   4. Fetch the homepage plus up to MAX_PAGES-1 more pages, pulling
//      <title>, meta description and the first <h1> from each with plain
//      regexes (no HTML-parser dependency -- good enough for signal
//      extraction, not for rendering).
//
// No JavaScript execution (plain fetch, not headless Chrome), so an SPA
// that renders its content client-side will look empty here. That's a
// known limitation, not a bug -- documented in the README.

const MAX_PAGES = 6;
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = 'LinkExchangeMVP-Crawler/1.0 (+site quality & category check)';

const SKIP_PATH_RE =
  /\/(login|logout|signin|signup|register|cart|checkout|account|privacy|terms|תנאי|פרטיות|contact|צור-קשר|wp-admin|wp-login|admin)(\/|$|\?)/i;
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|css|js|pdf|zip|mp4|mp3|woff2?|ico)(\?|$)/i;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function isDisallowedByRobots(origin) {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`);
    if (!res.ok) return false;
    const text = await res.text();
    // Very small, deliberately conservative parse: only acts on a
    // blanket "Disallow: /" under a "User-agent: *" block. Path-specific
    // rules are ignored -- we sample at most 6 pages, not a real crawl.
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let inStar = false;
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(':');
      if (!rawKey) continue;
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') inStar = value === '*';
      if (inStar && key === 'disallow' && value === '/') return true;
    }
    return false;
  } catch {
    return false; // robots.txt missing/unreachable -- proceed
  }
}

function extractTag(html, re) {
  const m = html.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function extractPageSignal(html) {
  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = extractTag(
    html,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
  );
  const h1 = extractTag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '');
  return { title, description, h1 };
}

function extractSameDomainLinks(html, origin, domain) {
  const hrefs = [...html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const out = new Set();
  for (const href of hrefs) {
    let abs;
    try {
      abs = new URL(href, origin);
    } catch {
      continue;
    }
    if (abs.hostname.replace(/^www\./, '') !== domain) continue;
    if (SKIP_PATH_RE.test(abs.pathname) || ASSET_EXT_RE.test(abs.pathname)) continue;
    abs.hash = '';
    out.add(abs.toString());
  }
  return [...out];
}

async function urlsFromSitemap(origin) {
  try {
    const res = await fetchWithTimeout(`${origin}/sitemap.xml`);
    if (!res.ok) return [];
    const xml = await res.text();

    // Sitemap index (points at other sitemaps) -- follow one level.
    const subSitemaps = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
    if (subSitemaps.length > 0) {
      const first = subSitemaps[0];
      const subRes = await fetchWithTimeout(first);
      if (!subRes.ok) return [];
      const subXml = await subRes.text();
      return [...subXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
    }

    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
  } catch {
    return [];
  }
}

/**
 * Crawl up to MAX_PAGES pages of `domain` and return aggregated signal.
 * Never throws -- failures are reported in the `error` field so callers
 * can route the site to manual review instead of crashing a batch job.
 */
async function crawlSite(domain) {
  const origin = `https://${domain}`;
  const pages = [];
  let error = null;

  try {
    if (await isDisallowedByRobots(origin)) {
      return { domain, pages: [], text: '', error: 'disallowed_by_robots_txt' };
    }

    // Always fetch the homepage first.
    const homeRes = await fetchWithTimeout(origin);
    if (!homeRes.ok) {
      return { domain, pages: [], text: '', error: `homepage_http_${homeRes.status}` };
    }
    const homeHtml = await homeRes.text();
    pages.push({ url: origin, ...extractPageSignal(homeHtml) });

    let candidateUrls = await urlsFromSitemap(origin);
    if (candidateUrls.length === 0) {
      candidateUrls = extractSameDomainLinks(homeHtml, origin, domain);
    }
    // De-dupe, drop the homepage itself, cap to what we still need.
    candidateUrls = [...new Set(candidateUrls)]
      .filter((u) => u.replace(/\/$/, '') !== origin.replace(/\/$/, ''))
      .slice(0, MAX_PAGES - 1);

    for (const url of candidateUrls) {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) continue;
        const html = await res.text();
        pages.push({ url, ...extractPageSignal(html) });
      } catch {
        // one page failing doesn't fail the whole crawl
      }
    }
  } catch (err) {
    error = err.name === 'AbortError' ? 'timeout' : 'fetch_failed';
  }

  const text = pages
    .map((p) => [p.title, p.description, p.h1].filter(Boolean).join(' '))
    .join(' ')
    .trim();

  return { domain, pages, text, error: pages.length === 0 ? error || 'no_pages_fetched' : null };
}

module.exports = { crawlSite, MAX_PAGES };
