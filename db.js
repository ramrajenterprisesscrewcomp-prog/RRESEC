const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// On Vercel the deployed code directory is read-only (only /tmp is writable),
// and /tmp is wiped between cold starts — so data does not persist there.
// This just keeps the app from crashing on read-only hosts; it is not a fix
// for durable storage.
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    customer_email TEXT,
    notes TEXT,
    start_ms INTEGER NOT NULL,
    channels TEXT NOT NULL DEFAULT '[]',
    offsets TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id),
    due_ms INTEGER NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS reminder_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    recipient TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_ms);
  CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id, start_ms);
`);

const { DEFAULT_TZ } = require('./tz');

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'timezone', `timezone TEXT NOT NULL DEFAULT '${DEFAULT_TZ}'`);
ensureColumn('users', 'fav_timezones', "fav_timezones TEXT NOT NULL DEFAULT '[]'");
ensureColumn('appointments', 'timezone', `timezone TEXT NOT NULL DEFAULT '${DEFAULT_TZ}'`);
ensureColumn('appointments', 'location_text', "location_text TEXT NOT NULL DEFAULT ''");
ensureColumn('appointments', 'location_lat', 'location_lat REAL');
ensureColumn('appointments', 'location_lng', 'location_lng REAL');
ensureColumn('appointments', 'title', "title TEXT NOT NULL DEFAULT ''");
ensureColumn('appointments', 'mode', "mode TEXT NOT NULL DEFAULT 'in_person'");
ensureColumn('appointments', 'meet_person', "meet_person TEXT NOT NULL DEFAULT ''");
ensureColumn('appointments', 'meet_person_phone', "meet_person_phone TEXT NOT NULL DEFAULT ''");
ensureColumn('appointments', 'destination', "destination TEXT NOT NULL DEFAULT ''");

const DEFAULT_SETTINGS = {
  business_name: 'Ram Raj Enterprises',
  default_country_code: '91',
  message_template:
    'Hello {customer}, this is a reminder of your appointment with {business} on {date} at {time}. {notes}',
  smtp_host: 'smtp.gmail.com',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from_name: '',
  wa_provider: 'disabled',
  wa_meta_phone_id: '',
  wa_meta_token: '',
  twilio_sid: '',
  twilio_token: '',
  twilio_wa_from: '',
  twilio_sms_from: '',
  sms_provider: 'disabled',
  msg91_authkey: '',
  msg91_sender: '',
  msg91_template_id: '',
  gsheet_id: ''
};

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ---------- settings ----------

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value == null ? '' : value));
}

function getSessionSecret() {
  const file = path.join(DATA_DIR, 'session-secret.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret);
  return secret;
}

// ---------- users ----------

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser(name, email, passwordHash, role, timezone) {
  return db
    .prepare('INSERT INTO users (name, email, password_hash, role, active, timezone, created_ms) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(name.trim(), email.toLowerCase().trim(), passwordHash, role, timezone || DEFAULT_TZ, Date.now()).lastInsertRowid;
}

function updateUserZones(id, timezone, favTimezones) {
  db.prepare('UPDATE users SET timezone = ?, fav_timezones = ? WHERE id = ?')
    .run(timezone, JSON.stringify(favTimezones), id);
}

function listUsers() {
  return db.prepare('SELECT id, name, email, role, active, timezone, created_ms FROM users ORDER BY id').all();
}

function setUserActive(id, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

// ---------- appointments ----------

function createAppointment(a) {
  return db
    .prepare(
      `INSERT INTO appointments
        (user_id, title, mode, meet_person, meet_person_phone, destination,
         customer_name, customer_phone, customer_email, notes, start_ms, timezone,
         location_text, location_lat, location_lng, channels, offsets, status, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      a.user_id, a.title || '', a.mode || 'in_person', a.meet_person || '', a.meet_person_phone || '', a.destination || '',
      a.customer_name, a.customer_phone || '', a.customer_email || '',
      a.notes || '', a.start_ms, a.timezone || DEFAULT_TZ,
      a.location_text || '', a.location_lat ?? null, a.location_lng ?? null,
      JSON.stringify(a.channels), JSON.stringify(a.offsets), Date.now()
    ).lastInsertRowid;
}

function updateAppointment(id, a) {
  db.prepare(
    `UPDATE appointments SET
       title = ?, mode = ?, meet_person = ?, meet_person_phone = ?, destination = ?,
       customer_name = ?, customer_phone = ?, customer_email = ?, notes = ?,
       start_ms = ?, timezone = ?, location_text = ?, location_lat = ?, location_lng = ?,
       channels = ?, offsets = ?
     WHERE id = ?`
  ).run(
    a.title || '', a.mode || 'in_person', a.meet_person || '', a.meet_person_phone || '', a.destination || '',
    a.customer_name, a.customer_phone || '', a.customer_email || '', a.notes || '',
    a.start_ms, a.timezone || DEFAULT_TZ,
    a.location_text || '', a.location_lat ?? null, a.location_lng ?? null,
    JSON.stringify(a.channels), JSON.stringify(a.offsets), id
  );
}

function getAppointment(id) {
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
}

function listAppointments(userId, filter) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  let where = [];
  let params = [];
  if (userId != null) {
    where.push('a.user_id = ?');
    params.push(userId);
  }
  if (filter === 'past') {
    where.push('a.start_ms < ?');
    params.push(startOfToday.getTime());
  } else if (filter !== 'all') {
    where.push('a.start_ms >= ?');
    params.push(startOfToday.getTime());
  }
  const sql = `
    SELECT a.*, u.name AS owner_name,
      (SELECT MIN(due_ms) FROM reminders r WHERE r.appointment_id = a.id AND r.status = 'pending') AS next_due_ms,
      (SELECT COUNT(*) FROM reminders r WHERE r.appointment_id = a.id AND r.status = 'sent') AS sent_count
    FROM appointments a JOIN users u ON u.id = a.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.start_ms ${filter === 'past' ? 'DESC' : 'ASC'}
    LIMIT 500`;
  return db.prepare(sql).all(...params);
}

function setAppointmentStatus(id, status) {
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
  if (status !== 'active') {
    db.prepare("DELETE FROM reminders WHERE appointment_id = ? AND status = 'pending'").run(id);
  }
}

function deleteAppointment(id) {
  db.prepare('DELETE FROM reminders WHERE appointment_id = ?').run(id);
  db.prepare('DELETE FROM appointments WHERE id = ?').run(id);
}

// ---------- reminders ----------

const OFFSET_LABELS = {
  1440: '1 day before',
  180: '3 hours before',
  60: '1 hour before',
  15: '15 minutes before'
};

function regenerateReminders(appointmentId) {
  const a = getAppointment(appointmentId);
  if (!a || a.status !== 'active') return;
  db.prepare("DELETE FROM reminders WHERE appointment_id = ? AND status = 'pending'").run(appointmentId);
  const now = Date.now();
  const offsets = JSON.parse(a.offsets || '[]');
  const insert = db.prepare('INSERT INTO reminders (appointment_id, due_ms, label, status) VALUES (?, ?, ?, ?)');
  let scheduled = 0;
  for (const minutes of offsets) {
    const due = a.start_ms - minutes * 60000;
    if (due > now) {
      insert.run(appointmentId, due, OFFSET_LABELS[minutes] || `${minutes} min before`, 'pending');
      scheduled++;
    }
  }
  // Too late for every chosen time but the appointment is still ahead: remind right away.
  if (scheduled === 0 && offsets.length > 0 && a.start_ms > now) {
    insert.run(appointmentId, now, 'immediately', 'pending');
  }
}

function dueReminders(nowMs) {
  return db
    .prepare(
      `SELECT r.id AS reminder_id, r.due_ms, r.label, a.*
       FROM reminders r JOIN appointments a ON a.id = r.appointment_id
       WHERE r.status = 'pending' AND r.due_ms <= ? AND a.status = 'active'`
    )
    .all(nowMs);
}

function setReminderStatus(id, status) {
  db.prepare('UPDATE reminders SET status = ?, sent_ms = ? WHERE id = ?').run(status, Date.now(), id);
}

function addLog(appointmentId, channel, recipient, status, error) {
  db.prepare(
    'INSERT INTO reminder_logs (appointment_id, channel, recipient, status, error, created_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(appointmentId, channel, recipient || '', status, error || '', Date.now());
}

function listLogs(userId) {
  const params = [];
  let where = '';
  if (userId != null) {
    where = 'WHERE a.user_id = ?';
    params.push(userId);
  }
  return db
    .prepare(
      `SELECT l.*, a.customer_name, a.start_ms, u.name AS owner_name
       FROM reminder_logs l
       JOIN appointments a ON a.id = l.appointment_id
       JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY l.id DESC LIMIT 200`
    )
    .all(...params);
}

module.exports = {
  getSettings, setSetting, getSessionSecret,
  countUsers, getUserByEmail, getUserById, createUser, updateUserZones, listUsers, setUserActive,
  createAppointment, updateAppointment, getAppointment, listAppointments,
  setAppointmentStatus, deleteAppointment,
  OFFSET_LABELS, regenerateReminders, dueReminders, setReminderStatus,
  addLog, listLogs
};
