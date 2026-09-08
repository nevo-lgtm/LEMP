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

function insertSite(site) {
  const sites = listSites();
  const record = {
    id: id(),
    secretToken: secretToken(),
    createdAt: new Date().toISOString(),
    ...site,
  };
  sites.push(record);
  writeJSON(SITES_FILE, sites);
  return record;
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

module.exports = {
  listSites,
  getSite,
  getSiteByToken,
  findSiteByDomain,
  insertSite,
  updateSite,
  listMatches,
  getMatch,
  matchesForSite,
  activeMatchExistsFor,
  insertMatch,
  updateMatch,
};
