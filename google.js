// Google Sheets sync via a service account (JWT signed with node:crypto — no SDK).
// Auth needs the service account's JSON key file saved as data/google-key.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const tzu = require('./tz');

const KEY_PATH = path.join(__dirname, 'data', 'google-key.json');
let cachedToken = null;

// On a host with no local data/ folder (e.g. Railway), the key is supplied via
// the GOOGLE_SERVICE_ACCOUNT_JSON env var instead of the file.
function loadKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const k = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      if (k.client_email && k.private_key) return k;
    } catch {
      // fall through to the file
    }
  }
  try {
    const k = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    return k.client_email && k.private_key ? k : null;
  } catch {
    return null;
  }
}

function statusInfo() {
  const k = loadKey();
  return { keyPresent: !!k, email: k ? k.client_email : '' };
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expMs > Date.now() + 60000) return cachedToken.token;
  const key = loadKey();
  if (!key) {
    throw new Error(
      'Google key file not found. Download the service account JSON key and save it as data\\google-key.json'
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Google login failed: ' + (body.error_description || body.error || res.status));
  cachedToken = { token: body.access_token, expMs: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.token;
}

// Tab title for a user: safe characters only, unique via the user id.
function userTabTitle(u) {
  const clean = String(u.name || 'User').replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 80);
  return `${clean} #${u.id}`;
}

function apptTable(appts, withOwner) {
  const header = [
    'ID', ...(withOwner ? ['Booked by'] : []), 'Title', 'Type', 'Customer', 'Person to meet',
    'Meet person phone', 'Destination', 'Phone', 'Email', 'Date', 'Time',
    'Time zone', 'Notes', 'Reminders via', 'Status', 'Next reminder'
  ];
  const rows = appts.map(a => [
    a.id, ...(withOwner ? [a.owner_name] : []), a.title || '',
    a.mode === 'online' ? 'Online' : 'In-person', a.customer_name, a.meet_person || '',
    a.meet_person_phone || '', a.destination || '', a.customer_phone, a.customer_email,
    tzu.wallDate(a.start_ms, a.timezone), tzu.wallTime(a.start_ms, a.timezone), a.timezone,
    a.notes, JSON.parse(a.channels || '[]').join(', '), a.status,
    a.next_due_ms ? `${tzu.wallDate(a.next_due_ms, a.timezone)} ${tzu.wallTime(a.next_due_ms, a.timezone)}` : ''
  ]);
  return [header, ...rows];
}

function usersTable(users, appts) {
  const header = ['ID', 'Name', 'Email', 'Role', 'Active', 'Time zone', 'Joined', 'Total appointments', 'Sheet tab'];
  const rows = users.map(u => [
    u.id, u.name, u.email, u.role, u.active ? 'yes' : 'no', u.timezone || '',
    new Date(u.created_ms).toISOString().slice(0, 10),
    appts.filter(a => a.user_id === u.id).length,
    userTabTitle(u)
  ]);
  return [header, ...rows];
}

// Rewrites the spreadsheet: a Users tab, an All-appointments tab,
// and one tab per user (tabs are created automatically as users join).
async function syncAllToSheet() {
  try {
    const settings = db.getSettings();
    const sheetId = settings.gsheet_id;
    if (!sheetId) return { ok: false, error: 'No Google Sheet ID saved in Settings' };
    const token = await getAccessToken();
    const auth = { Authorization: `Bearer ${token}` };
    const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };
    const apiBase = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;

    const users = db.listUsers();
    const appts = db.listAppointments(null, 'all');
    const tabs = [
      { title: 'Users', values: usersTable(users, appts) },
      { title: 'All appointments', values: apptTable(appts, true) },
      ...users.map(u => ({
        title: userTabTitle(u),
        values: apptTable(appts.filter(a => a.user_id === u.id), false)
      }))
    ];

    // Which tabs already exist?
    const metaRes = await fetch(`${apiBase}?fields=sheets.properties.title`, { headers: auth });
    if (!metaRes.ok) {
      const text = await metaRes.text();
      if (metaRes.status === 403) {
        return {
          ok: false,
          error: `Google says access denied (403). Share the Sheet with ${loadKey().client_email} as Editor.`
        };
      }
      if (metaRes.status === 404) return { ok: false, error: 'Sheet not found — check the Sheet ID in Settings.' };
      return { ok: false, error: `Google Sheets error ${metaRes.status}: ${text.slice(0, 300)}` };
    }
    const meta = await metaRes.json();
    const existing = new Set((meta.sheets || []).map(s => s.properties.title));

    // Create missing tabs in one call.
    const missing = tabs.filter(t => !existing.has(t.title));
    if (missing.length > 0) {
      const addRes = await fetch(`${apiBase}:batchUpdate`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ requests: missing.map(t => ({ addSheet: { properties: { title: t.title } } })) })
      });
      if (!addRes.ok) {
        const text = await addRes.text();
        return { ok: false, error: `Could not create sheet tabs: ${text.slice(0, 300)}` };
      }
    }

    // Write every tab: clear old rows, then write fresh ones.
    for (const t of tabs) {
      const range = encodeURIComponent(`'${t.title}'!A:Z`);
      const clearRes = await fetch(`${apiBase}/values/${range}:clear`, { method: 'POST', headers: auth });
      if (!clearRes.ok) {
        const text = await clearRes.text();
        return { ok: false, error: `Error clearing tab "${t.title}": ${text.slice(0, 300)}` };
      }
      const startCell = encodeURIComponent(`'${t.title}'!A1`);
      const putRes = await fetch(`${apiBase}/values/${startCell}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ values: t.values })
      });
      if (!putRes.ok) {
        const text = await putRes.text();
        return { ok: false, error: `Error writing tab "${t.title}": ${text.slice(0, 300)}` };
      }
    }
    return { ok: true, count: appts.length, tabs: tabs.length, users: users.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Fire-and-forget sync after appointment changes; quiet if not configured yet.
function syncSoon() {
  const settings = db.getSettings();
  if (!settings.gsheet_id || !loadKey()) return;
  setTimeout(() => {
    syncAllToSheet().then(r => {
      console.log(r.ok ? `[gsheet] synced ${r.count} appointments` : `[gsheet] sync failed: ${r.error}`);
    });
  }, 100);
}

module.exports = { statusInfo, syncAllToSheet, syncSoon };
