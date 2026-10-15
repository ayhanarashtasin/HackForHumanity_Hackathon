import { SEVERITY_RANK } from '../../config/alertConstants.js';
import { env } from '../../config/env.js';
import {
  addDays, dhakaDate, dhakaParts, dhakaWallTime, parseHm,
} from '../time.js';

// When an external message may go out. Quiet hours and the channel's lowest severity are the person's and the operator's choices;
// a CRITICAL alert (lightning) is never held back by quiet hours or the daily cap (catalogue CTX-04: protective actions are time-critical).

// One alert stage = a severity and the number of re-notifications so far. An escalation or an allowed lightning re-notification is a
// new stage, so it is sent again; a silent evidence refresh is the same stage, so it is not.
export const stageKey = (notification) => `${notification.severity}:${notification.renotifications ?? 0}`;

export const isCritical = (severity) => severity === 'CRITICAL';

// A storm-approach warning (STORM_APPROACH) is over within the hour: held for quiet hours it would only expire unsent, so like a
// CRITICAL alert it goes out at night too (the person's daily cap still applies). It only uses env.channels.stormChannels.
const URGENT_HAZARDS = new Set(['STORM_APPROACH']);
export const skipsQuietHours = (notification) => isCritical(notification.severity) || URGENT_HAZARDS.has(notification.hazardType);

export function hazardAllowsChannel(hazardType, channel, stormChannels = env.channels.stormChannels) {
  return hazardType !== 'STORM_APPROACH' || stormChannels.includes(channel);
}

export function meetsMinSeverity(channel, severity, minimum = env.channels.minSeverity) {
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[minimum[channel]] ?? 1);
}

// quiet = { enabled, start: 'HH:MM', end: 'HH:MM' } in Bangladesh time; a window whose end is not after its start crosses midnight.
export function inQuietHours(quiet, nowMs) {
  if (!quiet?.enabled) return false;
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (start === null || end === null || start === end) return false;

  const { hh, mm } = dhakaParts(new Date(nowMs));
  const minutes = hh * 60 + mm;
  return start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
}

// The next moment the quiet window ends (always in the future).
export function quietEndsAt(quiet, nowMs) {
  const today = dhakaDate(new Date(nowMs));
  const todayEnd = dhakaWallTime(today, quiet.end).getTime();
  return todayEnd > nowMs ? todayEnd : dhakaWallTime(addDays(today, 1), quiet.end).getTime();
}

// The start of the current Bangladesh day, for the per-day message cap.
export const dayStart = (nowMs) => dhakaWallTime(dhakaDate(new Date(nowMs)), '00:00');
