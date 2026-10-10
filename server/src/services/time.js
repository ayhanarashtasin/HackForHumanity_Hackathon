// Bangladesh is a fixed UTC+6 with no daylight saving, so Asia/Dhaka wall time is plain offset arithmetic.
export const DHAKA_OFFSET_MS = 6 * 60 * 60_000;
export const TIMEZONE = 'Asia/Dhaka';

const pad = (n) => String(n).padStart(2, '0');

export function dhakaParts(date) {
  const shifted = new Date(date.getTime() + DHAKA_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes(), ss: shifted.getUTCSeconds(),
  };
}

export function dhakaDate(date) {
  const { y, m, d } = dhakaParts(date);
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function dhakaIso(date) {
  if (!date) return null;
  const { hh, mm, ss } = dhakaParts(date);
  return `${dhakaDate(date)}T${pad(hh)}:${pad(mm)}:${pad(ss)}+06:00`;
}

export function dhakaWallTime(dateString, time) {
  const [y, m, d] = dateString.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - DHAKA_OFFSET_MS);
}

export function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// "HH:MM" (24 h, Bangladesh time) -> minutes after midnight, or null when it is not a valid time.
export function parseHm(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function formatHm(date) {
  const { hh, mm } = dhakaParts(date);
  return `${pad(hh)}:${pad(mm)}`;
}

// Great-circle distance between two coordinates in kilometres.
export function haversineKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h = Math.sin(((bLat - aLat) * rad) / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

// Does a window that repeats every day (for example a 07:00-09:00 commute or a 22:00-06:00 night shift) overlap [fromMs, toMs]?
// Returns the first overlapping interval, or null. A window whose end is not after its start crosses midnight.
export function recurringWindowOverlap({ start, end }, fromMs, toMs) {
  const startMinutes = parseHm(start);
  const endMinutes = parseHm(end);
  if (startMinutes === null || endMinutes === null || !(toMs > fromMs)) return null;

  const first = dhakaDate(new Date(fromMs));
  const crossesMidnight = endMinutes <= startMinutes;

  for (let day = -1; day <= Math.ceil((toMs - fromMs) / 86_400_000) + 1; day++) {
    const date = addDays(first, day);
    const from = dhakaWallTime(date, start).getTime();
    const to = dhakaWallTime(date, end).getTime() + (crossesMidnight ? 86_400_000 : 0);
    const overlapFrom = Math.max(from, fromMs);
    const overlapTo = Math.min(to, toMs);
    if (overlapTo > overlapFrom) return { from: overlapFrom, to: overlapTo };
  }
  return null;
}
