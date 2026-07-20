const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const notifier = require('./notifier');
const tzu = require('./tz');
const cal = require('./cal');
const gsheet = require('./google');

const app = express();
const PORT = process.env.PORT || 3010;
app.set('trust proxy', 1); // correct client IPs/cookies when behind a reverse proxy (VPS)

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: db.getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 3600 * 1000 }
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.userId ? db.getUserById(req.session.userId) : null;
  if (res.locals.user && !res.locals.user.active) {
    req.session.destroy(() => {});
    return res.redirect('/login');
  }
  res.locals.msg = req.session.msg || null;
  delete req.session.msg;
  const viewerTz =
    res.locals.user && tzu.isValid(res.locals.user.timezone) ? res.locals.user.timezone : tzu.DEFAULT_TZ;
  res.locals.viewerTz = viewerTz;
  res.locals.fmtDate = ms =>
    new Date(ms).toLocaleDateString('en-IN', { timeZone: viewerTz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  res.locals.fmtTime = ms =>
    new Date(ms).toLocaleTimeString('en-IN', { timeZone: viewerTz, hour: '2-digit', minute: '2-digit' });
  res.locals.fmtDateTime = ms => res.locals.fmtDate(ms) + ', ' + res.locals.fmtTime(ms);
  res.locals.wallTime = tzu.wallTime;
  res.locals.callingCode = tzu.callingCode;
  res.locals.gcalUrl = cal.gcalUrl;
  next();
});

function userFavZones(user) {
  try {
    return JSON.parse(user.fav_timezones || '[]').filter(tzu.isValid);
  } catch {
    return [];
  }
}

function flash(req, type, text) {
  req.session.msg = { type, text };
}

function requireLogin(req, res, next) {
  if (!res.locals.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.user || res.locals.user.role !== 'admin') {
    flash(req, 'error', 'Only the admin can open that page.');
    return res.redirect('/');
  }
  next();
}

// ---------- auth ----------

app.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: 'Log in', firstRun: db.countUsers() === 0 });
});

app.post('/login', (req, res) => {
  const user = db.getUserByEmail(req.body.email || '');
  if (!user || !bcrypt.compareSync(req.body.password || '', user.password_hash)) {
    flash(req, 'error', 'Wrong email or password.');
    return res.redirect('/login');
  }
  if (!user.active) {
    flash(req, 'error', 'Your account has been deactivated. Ask the admin.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect('/');
});

app.get('/register', (req, res) => {
  res.render('register', {
    title: 'Create account',
    firstRun: db.countUsers() === 0,
    timezones: tzu.ZONES_LABELED,
    defaultTz: tzu.DEFAULT_TZ
  });
});

app.post('/register', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email.includes('@') || password.length < 6) {
    flash(req, 'error', 'Please fill name, a valid email, and a password of at least 6 characters.');
    return res.redirect('/register');
  }
  if (db.getUserByEmail(email)) {
    flash(req, 'error', 'That email is already registered. Try logging in.');
    return res.redirect('/login');
  }
  const role = db.countUsers() === 0 ? 'admin' : 'user';
  const timezone = tzu.isValid(req.body.timezone) ? req.body.timezone : tzu.DEFAULT_TZ;
  const id = db.createUser(name, email, bcrypt.hashSync(password, 10), role, timezone);
  gsheet.syncSoon(); // creates the new user's tab in the Google Sheet
  req.session.userId = id;
  flash(req, 'success', role === 'admin'
    ? 'Welcome! You are the admin. Open Settings to set up email sending.'
    : 'Account created. Welcome!');
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- profile ----------

app.get('/profile', requireLogin, (req, res) => {
  res.render('profile', {
    title: 'My profile',
    timezones: tzu.ZONES_LABELED,
    favZones: userFavZones(res.locals.user)
  });
});

app.post('/profile', requireLogin, (req, res) => {
  const timezone = tzu.isValid(req.body.timezone) ? req.body.timezone : res.locals.user.timezone;
  const favs = String(req.body.fav_timezones || '')
    .split(',')
    .map(z => z.trim())
    .filter(tzu.isValid)
    .filter((z, i, arr) => arr.indexOf(z) === i)
    .slice(0, 20);
  db.updateUserZones(res.locals.user.id, timezone, favs);
  flash(req, 'success', `Saved. Your times now show in ${timezone}.`);
  res.redirect('/profile');
});

// ---------- dashboard ----------

app.get('/', requireLogin, (req, res) => {
  const filter = ['past', 'all'].includes(req.query.filter) ? req.query.filter : 'upcoming';
  const isAdmin = res.locals.user.role === 'admin';
  const scopeAll = isAdmin && req.query.scope === 'all';
  const appointments = db.listAppointments(scopeAll ? null : res.locals.user.id, filter);
  const settings = db.getSettings();
  res.render('dashboard', {
    title: 'Appointments',
    appointments,
    filter,
    scopeAll,
    emailConfigured: !!(settings.smtp_user && settings.smtp_pass)
  });
});

// ---------- appointments ----------

const OFFSET_OPTIONS = [
  { minutes: 1440, label: '1 day before' },
  { minutes: 180, label: '3 hours before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 15, label: '15 minutes before' }
];

function readAppointmentForm(req, res) {
  const channels = [].concat(req.body.channels || []).filter(c => ['email', 'whatsapp', 'sms'].includes(c));
  const offsets = [].concat(req.body.offsets || []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  const timezone = tzu.isValid(req.body.timezone) ? req.body.timezone : res.locals.viewerTz;
  const start_ms = tzu.zonedTimeToEpoch(req.body.date, req.body.time, timezone);
  // Meet person's phone is stored in international format, using the calling
  // code of the appointment's time zone (fallback: the business default).
  const cc = tzu.callingCode(timezone) || db.getSettings().default_country_code;
  const meetPhone = notifier.normalizePhone(req.body.meet_person_phone, cc);
  return {
    title: (req.body.title || '').trim(),
    mode: req.body.mode === 'online' ? 'online' : 'in_person',
    meet_person: (req.body.meet_person || '').trim(),
    meet_person_phone: meetPhone ? '+' + meetPhone : '',
    destination: (req.body.destination || '').trim(),
    location_text: '',
    location_lat: null,
    location_lng: null,
    customer_name: (req.body.customer_name || '').trim(),
    customer_phone: (req.body.customer_phone || '').trim(),
    customer_email: (req.body.customer_email || '').trim(),
    notes: (req.body.notes || '').trim(),
    start_ms,
    timezone,
    channels,
    offsets
  };
}

function validateAppointment(f) {
  if (!f.customer_name) return 'Customer name is required.';
  if (isNaN(f.start_ms)) return 'Please choose a valid date and time.';
  if (f.start_ms < Date.now()) return 'The appointment time is in the past.';
  if (f.channels.length === 0) return 'Choose at least one reminder channel (email, WhatsApp or SMS).';
  if (f.offsets.length === 0) return 'Choose at least one reminder time (e.g. 1 day before).';
  if (f.channels.includes('email') && !f.customer_email.includes('@'))
    return 'Email reminder chosen, but no valid customer email given.';
  if ((f.channels.includes('whatsapp') || f.channels.includes('sms')) && f.customer_phone.replace(/\D/g, '').length < 9)
    return 'WhatsApp/SMS reminder chosen, but no valid customer phone number given.';
  return null;
}

app.get('/appointments/new', requireLogin, (req, res) => {
  res.render('appointment-form', {
    title: 'New appointment',
    appt: null,
    offsetOptions: OFFSET_OPTIONS,
    settings: db.getSettings(),
    timezones: tzu.ZONES_LABELED,
    favZones: userFavZones(res.locals.user),
    wallDate: tzu.wallDate
  });
});

app.post('/appointments', requireLogin, (req, res) => {
  const f = readAppointmentForm(req, res);
  const error = validateAppointment(f);
  if (error) {
    flash(req, 'error', error);
    return res.redirect('/appointments/new');
  }
  const id = db.createAppointment({ user_id: res.locals.user.id, ...f });
  db.regenerateReminders(id);
  gsheet.syncSoon();
  flash(req, 'success', `Appointment for ${f.customer_name} saved. Reminders are scheduled.`);
  res.redirect('/');
});

function loadOwnAppointment(req, res) {
  const appt = db.getAppointment(Number(req.params.id));
  if (!appt) return null;
  if (res.locals.user.role !== 'admin' && appt.user_id !== res.locals.user.id) return null;
  return appt;
}

app.get('/appointments/:id/edit', requireLogin, (req, res) => {
  const appt = loadOwnAppointment(req, res);
  if (!appt) {
    flash(req, 'error', 'Appointment not found.');
    return res.redirect('/');
  }
  res.render('appointment-form', {
    title: 'Edit appointment',
    appt,
    offsetOptions: OFFSET_OPTIONS,
    settings: db.getSettings(),
    timezones: tzu.ZONES_LABELED,
    favZones: userFavZones(res.locals.user),
    wallDate: tzu.wallDate
  });
});

app.post('/appointments/:id', requireLogin, (req, res) => {
  const appt = loadOwnAppointment(req, res);
  if (!appt) {
    flash(req, 'error', 'Appointment not found.');
    return res.redirect('/');
  }
  const f = readAppointmentForm(req, res);
  const error = validateAppointment(f);
  if (error) {
    flash(req, 'error', error);
    return res.redirect(`/appointments/${appt.id}/edit`);
  }
  db.updateAppointment(appt.id, f);
  db.regenerateReminders(appt.id);
  gsheet.syncSoon();
  flash(req, 'success', 'Appointment updated. Reminders were re-scheduled.');
  res.redirect('/');
});

app.post('/appointments/:id/cancel', requireLogin, (req, res) => {
  const appt = loadOwnAppointment(req, res);
  if (appt) {
    db.setAppointmentStatus(appt.id, 'cancelled');
    gsheet.syncSoon();
    flash(req, 'success', `Appointment for ${appt.customer_name} cancelled. No reminders will be sent.`);
  }
  res.redirect('/');
});

app.post('/appointments/:id/delete', requireLogin, (req, res) => {
  const appt = loadOwnAppointment(req, res);
  if (appt) {
    db.deleteAppointment(appt.id);
    gsheet.syncSoon();
    flash(req, 'success', 'Appointment deleted.');
  }
  res.redirect('/');
});

// ---------- notifications & calendar ----------

// Appointments of the logged-in user starting within the next 30 minutes,
// polled by the browser to show desktop/app alerts.
app.get('/api/notifications', requireLogin, (req, res) => {
  const now = Date.now();
  const soon = now + 30 * 60000;
  const rows = db
    .listAppointments(res.locals.user.id, 'upcoming')
    .filter(a => a.status === 'active' && a.start_ms >= now && a.start_ms <= soon)
    .map(a => ({ id: a.id, customer: a.customer_name, time: res.locals.fmtTime(a.start_ms) }));
  res.json(rows);
});

app.get('/appointments/:id/ics', requireLogin, (req, res) => {
  const appt = loadOwnAppointment(req, res);
  if (!appt) {
    flash(req, 'error', 'Appointment not found.');
    return res.redirect('/');
  }
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=appointment-${appt.id}.ics`);
  res.send(cal.buildIcs(appt, db.getSettings()));
});

// ---------- logs ----------

app.get('/logs', requireLogin, (req, res) => {
  const isAdmin = res.locals.user.role === 'admin';
  const logs = db.listLogs(isAdmin ? null : res.locals.user.id);
  res.render('logs', { title: 'Reminder log', logs, isAdmin });
});

// ---------- settings (admin) ----------

const SETTING_KEYS = [
  'business_name', 'default_country_code', 'message_template',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_name',
  'wa_provider', 'wa_meta_phone_id', 'wa_meta_token',
  'twilio_sid', 'twilio_token', 'twilio_wa_from', 'twilio_sms_from',
  'sms_provider', 'msg91_authkey', 'msg91_sender', 'msg91_template_id',
  'gsheet_id'
];

app.get('/settings', requireAdmin, (req, res) => {
  res.render('settings', { title: 'Settings', settings: db.getSettings(), gsheetStatus: gsheet.statusInfo() });
});

app.post('/settings', requireAdmin, (req, res) => {
  for (const key of SETTING_KEYS) {
    if (key in req.body) db.setSetting(key, req.body[key]);
  }
  flash(req, 'success', 'Settings saved.');
  res.redirect('/settings');
});

app.post('/settings/test-email', requireAdmin, async (req, res) => {
  const settings = db.getSettings();
  const to = (req.body.test_to || '').trim() || res.locals.user.email;
  const result = await notifier.sendEmail(
    settings,
    to,
    `Test email – ${settings.business_name || 'Appointment app'}`,
    'This is a test email from your appointment reminder app. Email sending works!'
  );
  flash(req, result.ok ? 'success' : 'error',
    result.ok ? `Test email sent to ${to}. Check the inbox (and spam folder).` : `Test email failed: ${result.error}`);
  res.redirect('/settings');
});

app.post('/settings/sync-sheet', requireAdmin, async (req, res) => {
  const result = await gsheet.syncAllToSheet();
  flash(req, result.ok ? 'success' : 'error',
    result.ok
      ? `Google Sheet updated: ${result.count} appointment(s) across ${result.tabs} tabs (Users + All + one per user).`
      : `Sheet sync failed: ${result.error}`);
  res.redirect('/settings');
});

// ---------- users (admin) ----------

app.get('/users', requireAdmin, (req, res) => {
  res.render('users', { title: 'Users', users: db.listUsers() });
});

app.post('/users/:id/toggle', requireAdmin, (req, res) => {
  const target = db.getUserById(Number(req.params.id));
  if (target && target.id !== res.locals.user.id) {
    db.setUserActive(target.id, !target.active);
    gsheet.syncSoon();
    flash(req, 'success', `${target.name} is now ${target.active ? 'deactivated' : 'active'}.`);
  }
  res.redirect('/users');
});

// ---------- start ----------

const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

app.listen(PORT, () => {
  console.log('');
  console.log('  Appointment Secretary is running.');
  console.log(`  Open in your browser:  http://localhost:${PORT}`);
  console.log(`  From phones on the same Wi-Fi, use this PC's IP, e.g. http://192.168.x.x:${PORT}`);
  console.log('');
  notifier.startScheduler();
});

// HTTPS (needed for the location feature on phones — browsers block
// geolocation on plain http except localhost). Cert is self-signed;
// phones show a one-time warning that must be accepted.
const pfxPath = path.join(__dirname, 'data', 'cert.pfx');
if (fs.existsSync(pfxPath)) {
  https
    .createServer({ pfx: fs.readFileSync(pfxPath), passphrase: 'secretary' }, app)
    .listen(HTTPS_PORT, () => {
      console.log(`  HTTPS (for location on phones):  https://192.168.x.x:${HTTPS_PORT}`);
    });
}
