// All times are shown in Bangladesh Standard Time ("BST" on BMD products), regardless of the viewer's own time zone.
const TIME_ZONE = 'Asia/Dhaka';

const longFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false });

export const toMs = (iso) => new Date(iso).getTime();
export const formatBst = (ms) => `${longFormat.format(ms).replace(',', '')} BST`;
export const STEP_MS = 3 * 3_600_000;
export const formatRange = (start, end) => `${longFormat.format(start).replace(',', '')} – ${clockFormat.format(end)} BST`;
export const formatClock = (ms) => clockFormat.format(ms).replace(' ', '').toLowerCase();
export const formatDay = (ms) => dayFormat.format(ms).replace(',', '');
export const dayKey = (ms) => dayKeyFormat.format(ms);
export const hourOf = (ms) => Number(hourFormat.format(ms)) % 24;

export function relativeLabel(ms, now = Date.now()) {
  const minutes = Math.round((ms - now) / 60_000);
  const abs = Math.abs(minutes);
  if (abs < 5) return 'now';

  const text = abs < 90 ? `${abs} min` : abs < 36 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return minutes > 0 ? `in ${text}` : `${text} ago`;
}

// Index of the last step whose start is at or before `ms` (the 3-hour step containing that time), clamped into the array.
export function stepIndexAt(steps, ms) {
  let found = 0;
  for (let i = 0; i < steps.length; i++) {
    if (toMs(steps[i]) <= ms) found = i;
    else break;
  }
  return found;
}

export function nearestIndex(times, ms) {
  let best = 0;
  let bestDistance = Infinity;
  times.forEach((time, i) => {
    const distance = Math.abs(time - ms);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  });
  return best;
}
