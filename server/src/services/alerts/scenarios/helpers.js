import {
  HEAT_CLASS_ORDER, heatClasses, timing,
} from '../../../config/alertRules.js';
import { dhakaParts, recurringWindowOverlap } from '../../time.js';

// Shared building blocks for the occupation scenarios (ALERT_ENGINE_PLAN.md section 10.3).
const HOUR = 3_600_000;

// Does this event cover an area of the subscriber? Upazila lists are exact; district lists mean "district-wide".
export function covers(event, area) {
  return event.coverage.upazilaPcodes?.includes(area.upazilaPcode) || event.coverage.districtPcodes?.includes(area.districtPcode) || false;
}

export function matchAreas(subscriber, event, roles) {
  const matched = subscriber.areas.filter((area) => roles.includes(area.role) && covers(event, area));
  // The most specific role first (the order of `roles`), so the notification names the area the person works in.
  return matched.sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role));
}

// CTX-01: what the person is doing right now beats their usual occupation, until the status expires.
export function activityOf(subscriber, nowMs) {
  const activity = subscriber.activeActivity;
  return activity && +new Date(activity.expiresAt) > nowMs ? activity.key : null;
}

export function activitySince(subscriber) {
  return subscriber.activeActivity ? +new Date(subscriber.activeActivity.since) : null;
}

export const eventFromMs = (event) => +new Date(event.validFrom);
export const eventUntilMs = (event) => +new Date(event.validUntil);

// The event is still ahead of us (or running) and starts within `hours`.
export function withinLead(event, hours, nowMs) {
  return eventUntilMs(event) > nowMs && eventFromMs(event) - nowMs <= hours * HOUR;
}

export function localHour(nowMs) {
  return dhakaParts(new Date(nowMs)).hh;
}

// Usual outdoor hours when a profile carries no shift.
export const DEFAULT_OUTDOOR = { start: '06:00', end: '18:00' };
export const DEFAULT_VENDOR = { start: '07:00', end: '20:00' };

export function windowOverlap(window, event, nowMs) {
  return recurringWindowOverlap(window, Math.max(nowMs, eventFromMs(event)), eventUntilMs(event));
}

export function shiftOf(data) {
  return data.shiftStart && data.shiftEnd ? { start: data.shiftStart, end: data.shiftEnd } : null;
}

export function shiftHours(window) {
  if (!window) return 0;
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const minutes = (eh * 60 + em) - (sh * 60 + sm);
  return (minutes <= 0 ? minutes + 1440 : minutes) / 60;
}

// ---------- heat load class (plan section 11.3) ----------
const bump = (name) => HEAT_CLASS_ORDER[Math.min(HEAT_CLASS_ORDER.indexOf(name) + 1, HEAT_CLASS_ORDER.length - 1)];
const atLeast = (name, floor) => (HEAT_CLASS_ORDER.indexOf(name) >= HEAT_CLASS_ORDER.indexOf(floor) ? name : floor);

export function heatClassFor(subscriber) {
  const data = subscriber.occupationData ?? {};
  let name = HEAT_CLASS_ORDER.includes(data.workload) ? data.workload : 'light';
  // Heavy protective gear, no shelter, or more than eight hours outdoors each move the person one class heavier.
  if (data.ppeHeatBurden === 'heavy' || data.shelterAccess === 'none' || data.hoursOutdoor === 'gt8' || data.outdoorHours === 'gt8') name = bump(name);
  if (subscriber.isHeatSensitive) name = atLeast(name, 'moderate');
  return name;
}

// ADVISORY / WARNING / null for one subscriber class and one heat event. Heat never produces CRITICAL.
export function heatSeverity(event, className) {
  const metrics = event.evidence?.metrics;
  if (!metrics || !Number.isFinite(metrics.peakValueC)) {
    // An administrator-declared event carries no measurement: use the declared level.
    if (event.origin === 'admin-declared') return event.level >= 2 ? 'WARNING' : 'ADVISORY';
    return null;
  }
  const lines = heatClasses[className][metrics.indicator === 'wbgt' ? 'wbgtC' : 'heatIndexC'];
  if (metrics.peakValueC >= lines.warning) return 'WARNING';
  if (metrics.peakValueC >= lines.advisory) return 'ADVISORY';
  return null;
}

// Worker heat scenarios speak up to heatLeadHours before the working window, only while the heat is still ahead or running,
// and never in the small hours (06:00 local at the earliest).
export function heatTimingOk(event, window, nowMs) {
  if (event.origin === 'admin-declared') return eventUntilMs(event) > nowMs;
  if (localHour(nowMs) < timing.heatEarliestLocalHour) return false;
  if (!withinLead(event, timing.heatLeadHours, nowMs)) return false;
  return Boolean(window && windowOverlap(window, event, nowMs));
}

export function peakText(event) {
  return event.evidence?.metrics?.peakStartMs ?? null;
}
