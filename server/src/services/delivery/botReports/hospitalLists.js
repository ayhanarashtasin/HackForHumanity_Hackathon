import { randomBytes } from 'node:crypto';

// The hospital list of a /route report, kept in memory so its "🏥 Hospitals" and "See more" buttons can page through it without searching
// again. A button carries only a random token (Telegram allows 64 bytes of button data). Only the trip's two ends and the public hospital
// entries are kept, for a few hours.
const KEEP_MS = 6 * 3_600_000;
const MAX_LISTS = 2000;
const lists = new Map();

export const HOSPITAL_TOKEN = /^[A-Za-z0-9_-]{8}$/;

// -> the token for this list.
export function keepHospitalList({ from, to, hospitals }, nowMs) {
  const token = randomBytes(6).toString('base64url');
  lists.set(token, { from, to, hospitals, at: nowMs });
  if (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value);
  return token;
}

// -> { from, to, hospitals } or null when unknown or expired (the server restarted, or the report is old).
export function hospitalList(token, nowMs) {
  const entry = lists.get(token);
  if (!entry) return null;
  if (nowMs - entry.at > KEEP_MS) {
    lists.delete(token);
    return null;
  }
  return entry;
}

export function resetHospitalListsForTests() {
  lists.clear();
}
