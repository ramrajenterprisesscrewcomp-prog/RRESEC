const nodemailer = require('nodemailer');
const db = require('./db');
const tzu = require('./tz');
const cal = require('./cal');

// If a reminder is overdue by more than this, mark it missed instead of sending late.
const MISSED_AFTER_MS = 2 * 60 * 60 * 1000;

function normalizePhone(raw, countryCode) {
  let digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  const cc = String(countryCode || '91').replace(/[^\d]/g, '');
  if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    digits = cc + digits.slice(1);                              // local number with trunk 0 (e.g. 050… in UAE)
  } else if (digits.length >= 9 && digits.length <= 10) {
    digits = cc + digits;                                       // local number (9 or 10 digits)
  }
  return digits; // international format without '+'
}

// Local numbers get the calling code of the country the appointment's time
// zone belongs to; the business default is the fallback.
function countryCodeFor(settings, appt) {
  return tzu.callingCode(appt && appt.timezone) || settings.default_country_code;
}

function buildMessage(settings, appt) {
  const d = new Date(appt.start_ms);
  // Customer sees the time in the zone the appointment was booked in.
  const timeZone = tzu.isValid(appt.timezone) ? appt.timezone : tzu.DEFAULT_TZ;
  const date = d.toLocaleDateString('en-IN', { timeZone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { timeZone, hour: '2-digit', minute: '2-digit' });
  let message = (settings.message_template || '')
    .replaceAll('{customer}', appt.customer_name || '')
    .replaceAll('{business}', settings.business_name || '')
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{notes}', appt.notes || '')
    .trim();
  if (appt.destination) {
    message += `\nDestination: ${appt.destination}`;
  } else if (appt.location_text || appt.location_lat != null) {
    // Legacy appointments saved before the location feature was removed.
    const mapQ = appt.location_lat != null
      ? `${appt.location_lat},${appt.location_lng}`
      : encodeURIComponent(appt.location_text);
    message += `\nLocation: ${appt.location_text ? appt.location_text + ' — ' : ''}https://www.google.com/maps?q=${mapQ}`;
  }
  return message;
}

// ---------- email ----------

async function sendEmail(settings, to, subject, text, ics) {
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    return { ok: false, error: 'Email (SMTP) is not configured in Settings' };
  }
  const port = parseInt(settings.smtp_port, 10) || 587;
  const transport = nodemailer.createTransport({
    host: settings.smtp_host,
    port,
    secure: port === 465,
    auth: { user: settings.smtp_user, pass: settings.smtp_pass }
  });
  try {
    const mail = {
      from: `"${settings.smtp_from_name || settings.business_name || 'Appointments'}" <${settings.smtp_user}>`,
      to,
      subject,
      text
    };
    if (ics) mail.icalEvent = { method: 'PUBLISH', content: ics };
    await transport.sendMail(mail);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- WhatsApp ----------

async function sendWhatsApp(settings, rawPhone, message, countryCode) {
  const phone = normalizePhone(rawPhone, countryCode || settings.default_country_code);
  if (!phone) return { ok: false, error: 'No valid phone number' };

  if (settings.wa_provider === 'meta') {
    if (!settings.wa_meta_phone_id || !settings.wa_meta_token) {
      return { ok: false, error: 'Meta WhatsApp API is not configured in Settings' };
    }
    try {
      const res = await fetch(`https://graph.facebook.com/v20.0/${settings.wa_meta_phone_id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.wa_meta_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: message }
        })
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `Meta API ${res.status}: ${body.slice(0, 300)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (settings.wa_provider === 'twilio') {
    return twilioSend(settings, `whatsapp:${settings.twilio_wa_from}`, `whatsapp:+${phone}`, message);
  }

  return { ok: false, error: 'WhatsApp sending is disabled in Settings' };
}

// ---------- SMS ----------

async function sendSMS(settings, rawPhone, message, countryCode) {
  const phone = normalizePhone(rawPhone, countryCode || settings.default_country_code);
  if (!phone) return { ok: false, error: 'No valid phone number' };

  if (settings.sms_provider === 'twilio') {
    return twilioSend(settings, settings.twilio_sms_from, `+${phone}`, message);
  }

  if (settings.sms_provider === 'msg91') {
    if (!settings.msg91_authkey || !settings.msg91_template_id) {
      return { ok: false, error: 'MSG91 is not configured in Settings' };
    }
    try {
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: settings.msg91_authkey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: settings.msg91_template_id,
          sender: settings.msg91_sender || undefined,
          recipients: [{ mobiles: phone, message }]
        })
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, error: `MSG91 ${res.status}: ${body.slice(0, 300)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: 'SMS sending is disabled in Settings' };
}

async function twilioSend(settings, from, to, body) {
  if (!settings.twilio_sid || !settings.twilio_token || !from) {
    return { ok: false, error: 'Twilio is not configured in Settings' };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${settings.twilio_sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${settings.twilio_sid}:${settings.twilio_token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: from, To: to, Body: body })
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Twilio ${res.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- reminder engine ----------

async function processReminder(settings, row) {
  const channels = JSON.parse(row.channels || '[]');
  const message = buildMessage(settings, row);
  const results = [];

  for (const channel of channels) {
    let result;
    let recipient;
    if (channel === 'email') {
      recipient = row.customer_email;
      result = recipient
        ? await sendEmail(
            settings, recipient,
            `Appointment reminder – ${settings.business_name || ''}`.trim(),
            message, cal.buildIcs(row, settings)
          )
        : { ok: false, error: 'No customer email on this appointment' };
    } else if (channel === 'whatsapp') {
      recipient = row.customer_phone;
      result = recipient
        ? await sendWhatsApp(settings, recipient, message, countryCodeFor(settings, row))
        : { ok: false, error: 'No customer phone on this appointment' };
    } else if (channel === 'sms') {
      recipient = row.customer_phone;
      result = recipient
        ? await sendSMS(settings, recipient, message, countryCodeFor(settings, row))
        : { ok: false, error: 'No customer phone on this appointment' };
    } else {
      continue;
    }
    db.addLog(row.id, channel, recipient, result.ok ? 'sent' : 'failed', result.error);
    results.push(result.ok);
    console.log(
      `[reminder] appt #${row.id} (${row.customer_name}) via ${channel}: ${result.ok ? 'sent' : 'FAILED – ' + result.error}`
    );
  }

  if (results.length === 0) return 'failed';
  if (results.every(Boolean)) return 'sent';
  if (results.some(Boolean)) return 'partial';
  return 'failed';
}

let running = false;

async function tick() {
  if (running) return; // don't overlap slow runs
  running = true;
  try {
    const now = Date.now();
    const settings = db.getSettings();
    for (const row of db.dueReminders(now)) {
      if (now - row.due_ms > MISSED_AFTER_MS) {
        db.setReminderStatus(row.reminder_id, 'missed');
        db.addLog(row.id, 'system', '', 'missed', `Reminder "${row.label}" was overdue by more than 2 hours (was the app switched off?)`);
        continue;
      }
      const status = await processReminder(settings, row);
      db.setReminderStatus(row.reminder_id, status);
    }
  } catch (e) {
    console.error('[reminder] tick error:', e);
  } finally {
    running = false;
  }
}

function startScheduler() {
  setTimeout(tick, 5000);
  setInterval(tick, 60000);
  console.log('[reminder] scheduler started – checking every 60 seconds');
}

module.exports = { normalizePhone, sendEmail, sendWhatsApp, sendSMS, buildMessage, startScheduler, tick };
