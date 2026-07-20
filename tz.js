// Time zone helpers built on Intl (no libraries needed).

const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES = Intl.supportedValuesOf('timeZone');
const ZONE_SET = new Set(ZONES);

function isValid(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (ZONE_SET.has(tz)) return true;
  // Accept valid aliases too (e.g. Asia/Kolkata vs Asia/Calcutta).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offset of a zone from UTC (in ms) at a given moment.
function tzOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epochMs))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - epochMs;
}

// "2026-07-20" + "15:30" as wall-clock time in a zone -> epoch ms.
function zonedTimeToEpoch(dateStr, timeStr, timeZone) {
  const [y, mo, d] = String(dateStr || '').split('-').map(Number);
  const [h, mi] = String(timeStr || '').split(':').map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return NaN;
  const wallUTC = Date.UTC(y, mo - 1, d, h, mi);
  let epoch = wallUTC - tzOffsetMs(wallUTC, timeZone);
  epoch = wallUTC - tzOffsetMs(epoch, timeZone); // second pass fixes DST edges
  return epoch;
}

// epoch ms -> "YYYY-MM-DD" / "HH:mm" wall-clock in a zone (for form fields).
function wallDate(ms, timeZone) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone });
}
function wallTime(ms, timeZone) {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' });
}

function offsetLabel(timeZone) {
  const min = Math.round(tzOffsetMs(Date.now(), timeZone) / 60000);
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// Dropdown list, computed once at startup: { value, label } sorted by offset.
const ZONES_LABELED = ZONES
  .map(z => ({ value: z, label: `${z} (${offsetLabel(z)})`, off: tzOffsetMs(Date.now(), z) }))
  .sort((a, b) => a.off - b.off || a.value.localeCompare(b.value))
  .map(({ value, label }) => ({ value, label }));

// Country calling code for a time zone (major zones). A local phone number on
// an appointment booked in another country's zone gets that country's prefix
// instead of the business default. Unknown zones return null (caller falls
// back to the default_country_code setting).
const TZ_CALLING_CODES = {
  // India & subcontinent
  'Asia/Kolkata': '91', 'Asia/Calcutta': '91',
  'Asia/Karachi': '92', 'Asia/Dhaka': '880', 'Asia/Colombo': '94',
  'Asia/Kathmandu': '977', 'Asia/Katmandu': '977', 'Asia/Thimphu': '975',
  'Asia/Kabul': '93', 'Indian/Maldives': '960',
  // Gulf / Middle East
  'Asia/Dubai': '971', 'Asia/Riyadh': '966', 'Asia/Qatar': '974',
  'Asia/Bahrain': '973', 'Asia/Kuwait': '965', 'Asia/Muscat': '968',
  'Asia/Baghdad': '964', 'Asia/Tehran': '98', 'Asia/Jerusalem': '972',
  'Asia/Amman': '962', 'Asia/Beirut': '961', 'Asia/Damascus': '963',
  'Asia/Aden': '967', 'Asia/Gaza': '970', 'Asia/Hebron': '970',
  // Asia
  'Asia/Singapore': '65', 'Asia/Kuala_Lumpur': '60', 'Asia/Jakarta': '62',
  'Asia/Makassar': '62', 'Asia/Jayapura': '62', 'Asia/Bangkok': '66',
  'Asia/Ho_Chi_Minh': '84', 'Asia/Saigon': '84', 'Asia/Manila': '63',
  'Asia/Hong_Kong': '852', 'Asia/Macau': '853', 'Asia/Shanghai': '86',
  'Asia/Urumqi': '86', 'Asia/Taipei': '886', 'Asia/Tokyo': '81',
  'Asia/Seoul': '82', 'Asia/Pyongyang': '850', 'Asia/Yangon': '95',
  'Asia/Rangoon': '95', 'Asia/Phnom_Penh': '855', 'Asia/Vientiane': '856',
  'Asia/Brunei': '673', 'Asia/Ulaanbaatar': '976',
  'Asia/Tashkent': '998', 'Asia/Samarkand': '998', 'Asia/Almaty': '7',
  'Asia/Aqtobe': '7', 'Asia/Dushanbe': '992', 'Asia/Ashgabat': '993',
  'Asia/Bishkek': '996', 'Asia/Baku': '994', 'Asia/Yerevan': '374',
  'Asia/Tbilisi': '995', 'Europe/Istanbul': '90', 'Asia/Nicosia': '357',
  // Europe
  'Europe/London': '44', 'Europe/Dublin': '353', 'Europe/Paris': '33',
  'Europe/Berlin': '49', 'Europe/Madrid': '34', 'Europe/Rome': '39',
  'Europe/Amsterdam': '31', 'Europe/Brussels': '32', 'Europe/Zurich': '41',
  'Europe/Vienna': '43', 'Europe/Stockholm': '46', 'Europe/Oslo': '47',
  'Europe/Copenhagen': '45', 'Europe/Helsinki': '358', 'Europe/Warsaw': '48',
  'Europe/Prague': '420', 'Europe/Budapest': '36', 'Europe/Bucharest': '40',
  'Europe/Sofia': '359', 'Europe/Athens': '30', 'Europe/Lisbon': '351',
  'Europe/Moscow': '7', 'Europe/Kyiv': '380', 'Europe/Kiev': '380',
  'Europe/Minsk': '375', 'Europe/Riga': '371', 'Europe/Vilnius': '370',
  'Europe/Tallinn': '372', 'Europe/Luxembourg': '352', 'Europe/Malta': '356',
  'Europe/Belgrade': '381', 'Europe/Zagreb': '385', 'Europe/Ljubljana': '386',
  'Europe/Sarajevo': '387', 'Europe/Skopje': '389', 'Europe/Tirane': '355',
  'Europe/Bratislava': '421', 'Europe/Chisinau': '373', 'Europe/Reykjavik': '354',
  // Africa
  'Africa/Cairo': '20', 'Africa/Lagos': '234', 'Africa/Nairobi': '254',
  'Africa/Johannesburg': '27', 'Africa/Casablanca': '212', 'Africa/Algiers': '213',
  'Africa/Tunis': '216', 'Africa/Tripoli': '218', 'Africa/Accra': '233',
  'Africa/Addis_Ababa': '251', 'Africa/Dar_es_Salaam': '255', 'Africa/Kampala': '256',
  'Africa/Khartoum': '249', 'Africa/Kinshasa': '243', 'Africa/Abidjan': '225',
  'Africa/Dakar': '221', 'Africa/Harare': '263', 'Africa/Lusaka': '260',
  'Africa/Maputo': '258', 'Africa/Windhoek': '264', 'Africa/Gaborone': '267',
  'Indian/Mauritius': '230',
  // Americas
  'America/New_York': '1', 'America/Chicago': '1', 'America/Denver': '1',
  'America/Los_Angeles': '1', 'America/Phoenix': '1', 'America/Anchorage': '1',
  'America/Detroit': '1', 'Pacific/Honolulu': '1',
  'America/Toronto': '1', 'America/Vancouver': '1', 'America/Edmonton': '1',
  'America/Winnipeg': '1', 'America/Halifax': '1', 'America/St_Johns': '1',
  'America/Mexico_City': '52', 'America/Tijuana': '52', 'America/Monterrey': '52',
  'America/Bogota': '57', 'America/Lima': '51', 'America/Santiago': '56',
  'America/Argentina/Buenos_Aires': '54', 'America/Sao_Paulo': '55',
  'America/Manaus': '55', 'America/Caracas': '58', 'America/Montevideo': '598',
  'America/Asuncion': '595', 'America/La_Paz': '591', 'America/Guayaquil': '593',
  'America/Panama': '507', 'America/Costa_Rica': '506', 'America/Guatemala': '502',
  'America/Havana': '53', 'America/Santo_Domingo': '1', 'America/Jamaica': '1',
  'America/Puerto_Rico': '1',
  // Oceania
  'Australia/Sydney': '61', 'Australia/Melbourne': '61', 'Australia/Brisbane': '61',
  'Australia/Perth': '61', 'Australia/Adelaide': '61', 'Australia/Hobart': '61',
  'Australia/Darwin': '61', 'Pacific/Auckland': '64', 'Pacific/Fiji': '679',
  'Pacific/Port_Moresby': '675', 'Pacific/Guam': '1'
};

function callingCode(timeZone) {
  if (TZ_CALLING_CODES[timeZone]) return TZ_CALLING_CODES[timeZone];
  if (String(timeZone || '').startsWith('Australia/')) return '61';
  return null;
}

module.exports = { DEFAULT_TZ, ZONES_LABELED, isValid, zonedTimeToEpoch, wallDate, wallTime, callingCode };
