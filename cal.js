// Calendar helpers: "Add to Google Calendar" links and .ics files.
// Events are exported with a default duration of 1 hour.

const EVENT_DURATION_MS = 60 * 60 * 1000;

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function locationOf(appt) {
  if (appt.location_text) return appt.location_text;
  if (appt.location_lat != null) return `${appt.location_lat},${appt.location_lng}`;
  if (appt.destination) return appt.destination;
  return '';
}

function detailsOf(appt) {
  const lines = [];
  if (appt.mode) lines.push(appt.mode === 'online' ? 'Online meeting' : 'In-person meeting');
  const meet = [appt.meet_person, appt.meet_person_phone].filter(Boolean).join(', ');
  if (meet) lines.push(`Meeting with: ${meet}`);
  if (appt.destination) lines.push(`Destination: ${appt.destination}`);
  if (appt.notes) lines.push(appt.notes);
  return lines.join('\n');
}

function gcalUrl(appt) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: appt.title ? `${appt.title} – ${appt.customer_name}` : `Appointment: ${appt.customer_name}`,
    dates: `${utcStamp(appt.start_ms)}/${utcStamp(appt.start_ms + EVENT_DURATION_MS)}`,
    details: detailsOf(appt)
  });
  if (appt.timezone) p.set('ctz', appt.timezone);
  const loc = locationOf(appt);
  if (loc) p.set('location', loc);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function buildIcs(appt, settings) {
  const loc = locationOf(appt);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Appointment Secretary//EN',
    'BEGIN:VEVENT',
    `UID:appt-${appt.id}@appointment-secretary`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    `DTSTART:${utcStamp(appt.start_ms)}`,
    `DTEND:${utcStamp(appt.start_ms + EVENT_DURATION_MS)}`,
    `SUMMARY:${icsEscape(appt.title || `Appointment – ${settings.business_name || 'Appointment'}`)}`,
    detailsOf(appt) ? `DESCRIPTION:${icsEscape(detailsOf(appt))}` : null,
    loc ? `LOCATION:${icsEscape(loc)}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

module.exports = { gcalUrl, buildIcs };
