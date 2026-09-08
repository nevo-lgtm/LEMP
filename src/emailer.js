// Notification sender -- same pluggable pattern as metrics.js: a `mock`
// mode that needs zero setup and a `real` mode you switch on with an API
// key once you've picked a provider. Nothing in the app talks to a raw
// SMTP/API call directly; everything goes through sendEmail() so the
// swap stays a one-file change.
//
// Mock mode doesn't silently drop mail -- it appends every "send" to
// data/notifications.json (visible in the admin panel) so you can see
// exactly what would have gone out.

const fs = require('fs');
const path = require('path');

const PROVIDER = (process.env.EMAIL_PROVIDER || 'mock').toLowerCase();
const NOTIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'notifications.json');

function logMockEmail(to, subject, body) {
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
  } catch {
    log = [];
  }
  log.unshift({ to, subject, body, sentAt: new Date().toISOString(), provider: 'mock' });
  log = log.slice(0, 200); // keep the log bounded
  const tmp = `${NOTIFICATIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
  fs.renameSync(tmp, NOTIFICATIONS_FILE);
}

function recentMockEmails(limit = 50) {
  try {
    const log = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8'));
    return log.slice(0, limit);
  } catch {
    return [];
  }
}

// TEMPLATE ONLY for the real path -- Resend's API is used as the example
// because its request shape is simple, but this has not been exercised
// against a live key. Verify against the provider's current docs before
// relying on it; the rest of the app only ever calls sendEmail().
async function sendViaResend(to, subject, body) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error('EMAIL_PROVIDER=resend but RESEND_API_KEY / EMAIL_FROM are not set in .env');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text: body }),
  });
  if (!res.ok) {
    throw new Error(`Email send failed: ${res.status} ${res.statusText}`);
  }
}

async function sendEmail(to, subject, body) {
  if (PROVIDER === 'resend') {
    return sendViaResend(to, subject, body);
  }
  logMockEmail(to, subject, body);
  return null;
}

module.exports = { sendEmail, recentMockEmails, PROVIDER };
