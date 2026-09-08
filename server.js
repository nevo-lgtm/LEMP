require('dotenv').config();

const express = require('express');
const path = require('path');

const db = require('./src/db');
const { fetchMetrics, PROVIDER } = require('./src/metrics');
const qualityGate = require('./src/qualityGate');
const matching = require('./src/matching');
const { NICHES } = require('./src/niches');
const { normalizeUrl, domainOf, isValidEmail, basicAuthOk } = require('./src/util');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function siteLabel(site) {
  return site ? `${site.domain} (${site.niche})` : 'לא ידוע';
}

function statusLabelHe(status) {
  const map = {
    pending_review: 'ממתין לבדיקה ידנית',
    approved: 'אושר, ממתין להתאמה',
    rejected: 'נדחה',
  };
  return map[status] || status;
}

function matchStatusLabelHe(status) {
  const map = {
    proposed: 'הצעת התאמה חדשה',
    confirmed_a: 'צד אחד אישר',
    confirmed_b: 'שני הצדדים אישרו',
    revealed: 'פרטי הקשר נחשפו',
    completed: 'הקישור פורסם',
    declined: 'ההתאמה נדחתה',
  };
  return map[status] || status;
}

// Which "side" is this site on a given match: 'a' or 'b'.
function sideOf(match, siteId) {
  if (match.siteAId === siteId) return 'a';
  if (match.siteBId === siteId) return 'b';
  return null;
}

function otherSiteId(match, siteId) {
  return sideOf(match, siteId) === 'a' ? match.siteBId : match.siteAId;
}

function isRevealedTo(match) {
  return match.status === 'revealed' || match.status === 'completed';
}

// ---------- public: landing + signup ----------

app.get('/', (req, res) => {
  res.render('index', { niches: NICHES, error: null, values: {} });
});

app.post('/signup', async (req, res) => {
  const { email, url, niche } = req.body;

  const urlObj = normalizeUrl(url);
  if (!isValidEmail(email) || !urlObj || !NICHES.includes(niche)) {
    return res.status(400).render('index', {
      niches: NICHES,
      error: 'נא למלא מייל תקין, כתובת אתר תקינה ולבחור נישה מהרשימה.',
      values: { email, url, niche },
    });
  }

  const domain = domainOf(urlObj);
  const existing = db.findSiteByDomain(domain);
  if (existing) {
    return res.render('signup-result', {
      site: existing,
      baseUrl: BASE_URL,
      alreadyExisted: true,
    });
  }

  let metrics;
  try {
    metrics = await fetchMetrics(domain);
  } catch (err) {
    return res.status(500).render('index', {
      niches: NICHES,
      error: `שגיאה בשליפת נתוני האתר: ${err.message}`,
      values: { email, url, niche },
    });
  }

  const gate = qualityGate.evaluate(metrics);

  const site = db.insertSite({
    email: email.trim(),
    url: urlObj.toString(),
    domain,
    niche,
    dr: metrics.dr,
    spamScore: metrics.spamScore,
    trafficEstimate: metrics.trafficEstimate,
    metricsSource: metrics.source,
    status: gate.status,
    gateReasons: gate.reasons,
  });

  res.render('signup-result', { site, baseUrl: BASE_URL, alreadyExisted: false });
});

// ---------- public: personal dashboard (secret-link auth) ----------

app.get('/me/:token', (req, res) => {
  const site = db.getSiteByToken(req.params.token);
  if (!site) return res.status(404).send('קישור לא נמצא. ודא שהעתקת את הכתובת המלאה ששמרת בהרשמה.');

  const myMatches = db
    .matchesForSite(site.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((m) => {
      const mySide = sideOf(m, site.id);
      const revealed = isRevealedTo(m);
      const partner = revealed ? db.getSite(otherSiteId(m, site.id)) : null;
      const iHaveConfirmed =
        revealed ||
        m.status === 'completed' ||
        (m.status === 'confirmed_a' && mySide === 'a') ||
        (m.status === 'confirmed_b' && mySide === 'b');
      const canRespond = m.status !== 'declined' && m.status !== 'completed' && !iHaveConfirmed;
      const canComplete = m.status === 'revealed';
      return {
        ...m,
        mySide,
        revealed,
        partner,
        iHaveConfirmed,
        canRespond,
        canComplete,
        statusLabel: matchStatusLabelHe(m.status),
      };
    });

  res.render('dashboard', {
    site,
    statusLabel: statusLabelHe(site.status),
    matches: myMatches,
    error: req.query.error || null,
  });
});

function loadMatchForSite(token, matchId) {
  const site = db.getSiteByToken(token);
  if (!site) return { error: 'not_found' };
  const match = db.getMatch(matchId);
  if (!match) return { error: 'not_found' };
  if (sideOf(match, site.id) === null) return { error: 'forbidden' };
  return { site, match };
}

app.post('/me/:token/matches/:matchId/confirm', (req, res) => {
  const { site, match, error } = loadMatchForSite(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');

  const side = sideOf(match, site.id);
  let nextStatus = match.status;

  if (match.status === 'proposed') {
    nextStatus = side === 'a' ? 'confirmed_a' : 'confirmed_b';
  } else if (
    (match.status === 'confirmed_a' && side === 'b') ||
    (match.status === 'confirmed_b' && side === 'a')
  ) {
    nextStatus = 'revealed';
  }
  // If the same side confirms twice, or it's already revealed, this is a no-op.

  const patch = { status: nextStatus };
  if (nextStatus === 'revealed') patch.revealedAt = new Date().toISOString();
  db.updateMatch(match.id, patch);

  res.redirect(`/me/${req.params.token}`);
});

app.post('/me/:token/matches/:matchId/decline', (req, res) => {
  const { site, match, error } = loadMatchForSite(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');

  db.updateMatch(match.id, { status: 'declined', declinedBy: site.id });
  res.redirect(`/me/${req.params.token}`);
});

app.post('/me/:token/matches/:matchId/complete', (req, res) => {
  const { site, match, error } = loadMatchForSite(req.params.token, req.params.matchId);
  if (error) return res.status(error === 'forbidden' ? 403 : 404).send('פעולה לא חוקית.');
  if (match.status !== 'revealed') {
    return res.redirect(`/me/${req.params.token}?error=${encodeURIComponent('אפשר לסמן כהושלם רק אחרי חשיפת פרטים הדדית.')}`);
  }

  db.updateMatch(match.id, { status: 'completed', completedAt: new Date().toISOString() });
  res.redirect(`/me/${req.params.token}`);
});

// ---------- admin ----------

app.use('/admin', (req, res, next) => {
  if (basicAuthOk(req, ADMIN_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).send('נדרש אימות.');
});

app.get('/admin', (req, res) => {
  const sites = db.listSites();
  const matches = db.listMatches();

  const stats = {
    totalSignups: sites.length,
    approved: sites.filter((s) => s.status === 'approved').length,
    pendingReview: sites.filter((s) => s.status === 'pending_review').length,
    rejected: sites.filter((s) => s.status === 'rejected').length,
    matchesProposed: matches.length,
    matchesRevealed: matches.filter((m) => m.status === 'revealed' || m.status === 'completed').length,
    matchesCompleted: matches.filter((m) => m.status === 'completed').length,
    matchesDeclined: matches.filter((m) => m.status === 'declined').length,
  };

  const reviewQueue = sites
    .filter((s) => s.status === 'pending_review')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const matchRows = matches
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((m) => ({
      ...m,
      siteA: db.getSite(m.siteAId),
      siteB: db.getSite(m.siteBId),
      statusLabel: matchStatusLabelHe(m.status),
    }));

  res.render('admin', {
    stats,
    reviewQueue,
    sites: sites.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    matchRows,
    metricsProvider: PROVIDER,
    thresholds: qualityGate.getThresholds(),
    tolerance: matching.tolerance(),
    flash: req.query.flash || null,
  });
});

app.post('/admin/sites/:id/approve', (req, res) => {
  db.updateSite(req.params.id, { status: 'approved', reviewedAt: new Date().toISOString() });
  res.redirect('/admin?flash=' + encodeURIComponent('האתר אושר.'));
});

app.post('/admin/sites/:id/reject', (req, res) => {
  db.updateSite(req.params.id, { status: 'rejected', reviewedAt: new Date().toISOString() });
  res.redirect('/admin?flash=' + encodeURIComponent('האתר נדחה.'));
});

app.post('/admin/run-matching', (req, res) => {
  const report = matching.runMatching();
  const msg = `נוצרו ${report.created.length} התאמות חדשות. ${report.unmatched.length} אתרים נשארו ללא זוג בסבב הזה.`;
  res.redirect('/admin?flash=' + encodeURIComponent(msg));
});

app.listen(PORT, () => {
  console.log(`Link-exchange MVP running at ${BASE_URL} (metrics provider: ${PROVIDER})`);
  console.log(`Admin panel: ${BASE_URL}/admin  (user: any, password: from ADMIN_PASSWORD in .env)`);
});
