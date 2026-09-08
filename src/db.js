// Minimal JSON-file data layer.
//
// Why not SQLite: this is meant to be cloned onto any machine and run with
// a plain `npm install` -- no native build step, no DB server. At MVP
// traffic (dozens/hundreds of signups) a synchronous JSON file is plenty
// fast and trivially inspectable (`cat data/sites.json`). If the pulse
// test works, swapping this module for Postgres is a clean, contained job
// because every other file only talks to the functions exported here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');

function ensureFile(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '[]', 'utf8');
  }
}

function readJSON(file) {
  ensureFile(file);
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

// Write via a temp file + rename so a crash mid-write can never leave a
// half-written / corrupt JSON file behind.
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function id() {
  return crypto.randomUUID();
}

function secretToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ---------- Sites ----------

function listSites() {
  return readJSON(SITES_FILE);
}

function getSite(siteId) {
  return listSites().find((s) => s.id === siteId) || null;
}

function getSiteByToken(token) {
  return listSites().find((s) => s.secretToken === token) || null;
}

function findSiteByDomain(domain) {
  return listSites().find((s) => s.domain === domain) || null;
}

function sitesForSubmission(submissionId) {
  return listSites().filter((s) => s.submissionId === submissionId);
}

const DEFAULT_RELIABILITY = { offered: 0, verified: 0, noShow: 0, removedAfterReciprocation: 0 };

function insertSite(site) {
  const sites = listSites();
  const record = {
    id: id(),
    secretToken: secretToken(),
    createdAt: new Date().toISOString(),
    reliability: { ...DEFAULT_RELIABILITY },
    ...site,
  };
  sites.push(record);
  writeJSON(SITES_FILE, sites);
  return record;
}

// Merge-adds to a site's reliability counters (never overwrites the whole
// object, so concurrent bumps to different counters don't clobber each
// other under last-writer-wins).
function bumpReliability(siteId, counterPatch) {
  const sites = listSites();
  const idx = sites.findIndex((s) => s.id === siteId);
  if (idx === -1) return null;
  const current = { ...DEFAULT_RELIABILITY, ...(sites[idx].reliability || {}) };
  for (const [key, delta] of Object.entries(counterPatch)) {
    current[key] = (current[key] || 0) + delta;
  }
  sites[idx] = { ...sites[idx], reliability: current, updatedAt: new Date().toISOString() };
  writeJSON(SITES_FILE, sites);
  return sites[idx];
}

function updateSite(siteId, patch) {
  const sites = listSites();
  const idx = sites.findIndex((s) => s.id === siteId);
  if (idx === -1) return null;
  sites[idx] = { ...sites[idx], ...patch, updatedAt: new Date().toISOString() };
  writeJSON(SITES_FILE, sites);
  return sites[idx];
}

// ---------- Matches ----------

function listMatches() {
  return readJSON(MATCHES_FILE);
}

function getMatch(matchId) {
  return listMatches().find((m) => m.id === matchId) || null;
}

function matchesForSite(siteId) {
  return listMatches().filter((m) => m.siteAId === siteId || m.siteBId === siteId);
}

function activeMatchExistsFor(siteId) {
  const active = new Set(['proposed', 'confirmed_a', 'confirmed_b', 'revealed']);
  return matchesForSite(siteId).some((m) => active.has(m.status));
}

function insertMatch(match) {
  const matches = listMatches();
  const record = {
    id: id(),
    status: 'proposed',
    createdAt: new Date().toISOString(),
    ...match,
  };
  matches.push(record);
  writeJSON(MATCHES_FILE, matches);
  return record;
}

function updateMatch(matchId, patch) {
  const matches = listMatches();
  const idx = matches.findIndex((m) => m.id === matchId);
  if (idx === -1) return null;
  matches[idx] = { ...matches[idx], ...patch, updatedAt: new Date().toISOString() };
  writeJSON(MATCHES_FILE, matches);
  return matches[idx];
}

// ---------- Submissions ----------
// A submission is one "I signed up with a list of domains under this
// email" event. Each domain becomes its own row in `sites`, linked back
// via `submissionId` -- the submission's secretToken is what the batch
// approval screen and the "all my sites" dashboard are keyed on.

function listSubmissions() {
  return readJSON(SUBMISSIONS_FILE);
}

function getSubmission(submissionId) {
  return listSubmissions().find((s) => s.id === submissionId) || null;
}

function getSubmissionByToken(token) {
  return listSubmissions().find((s) => s.secretToken === token) || null;
}

function insertSubmission(sub) {
  const subs = listSubmissions();
  const record = {
    id: id(),
    secretToken: secretToken(),
    createdAt: new Date().toISOString(),
    ...sub,
  };
  subs.push(record);
  writeJSON(SUBMISSIONS_FILE, subs);
  return record;
}

function updateSubmission(submissionId, patch) {
  const subs = listSubmissions();
  const idx = subs.findIndex((s) => s.id === submissionId);
  if (idx === -1) return null;
  subs[idx] = { ...subs[idx], ...patch, updatedAt: new Date().toISOString() };
  writeJSON(SUBMISSIONS_FILE, subs);
  return subs[idx];
}

module.exports = {
  listSites,
  getSite,
  getSiteByToken,
  findSiteByDomain,
  sitesForSubmission,
  insertSite,
  updateSite,
  bumpReliability,
  listMatches,
  getMatch,
  matchesForSite,
  activeMatchExistsFor,
  insertMatch,
  updateMatch,
  listSubmissions,
  getSubmission,
  getSubmissionByToken,
  insertSubmission,
  updateSubmission,
};
