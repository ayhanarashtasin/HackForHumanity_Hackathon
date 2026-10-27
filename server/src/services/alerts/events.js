import { randomUUID } from 'node:crypto';
import { notifyRules } from '../../config/alertRules.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import { Notification } from '../../models/Notification.js';
import { primaryStatus } from './hazards.js';

// Hazard events: create, update, supersede and expire. An event is occupation-neutral; notifications hang off it.
const HOUR = 3_600_000;
const GAP_MS = 3 * HOUR; // forecast windows closer than this belong to the same event
const BLOCKING = new Set(['STALE', 'UNAVAILABLE']);

const iso = (ms) => new Date(ms).toISOString();
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// A metric that moved by a quarter or more (against a floor of 1 so tiny values do not count as large changes).
export function metricsChanged(before, after, ratio = notifyRules.materialMetricChange) {
  if (!before || !after) return Boolean(before) !== Boolean(after);
  return Object.keys(after).some((key) => isNumber(after[key]) && isNumber(before[key])
    && Math.abs(after[key] - before[key]) / Math.max(Math.abs(before[key]), 1) >= ratio);
}

export function eventKeyFor(detection, areaPcode) {
  return `fc:${detection.source.provider}:${areaPcode}:${detection.hazardType}:${iso(detection.window.fromMs)}`;
}

function forecastIssuedAt(area, provider) {
  const entry = area.providers.find((item) => item.provider === provider);
  const time = entry?.dataTime ? new Date(entry.dataTime) : null;
  return time && !Number.isNaN(time.getTime()) ? time : null;
}

// Creates the event for a detection, or updates the active one it overlaps. Returns { event, created, material } or null when nothing may be created.
export async function upsertDetectedEvent({ detection, area, nowMs, settings }) {
  const now = new Date(nowMs);
  const { fromMs, untilMs } = detection.window;
  const blocked = BLOCKING.has(detection.dataStatus);

  const existing = await HazardEvent.findOne({
    hazardType: detection.hazardType,
    origin: 'detected',
    'coverage.scope': 'upazila',
    'coverage.upazilaPcodes': area.pcode,
    lifecycle: 'active',
    eventKey: /^fc:/,
    validUntil: { $gte: new Date(fromMs - GAP_MS) },
    validFrom: { $lte: new Date(untilMs + GAP_MS) },
  }).sort({ validFrom: 1 });

  if (existing) {
    // A stale or unavailable source can annotate an alert, but it can never change or escalate it.
    if (blocked) {
      if (existing.dataStatus !== detection.dataStatus) {
        existing.dataStatus = detection.dataStatus;
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        await existing.save();
        return { event: existing, created: false, material: true };
      }
      return { event: existing, created: false, material: false };
    }

    const started = +existing.validFrom <= nowMs;
    const newFrom = started ? Math.min(+existing.validFrom, fromMs) : fromMs;
    const material = existing.level !== detection.level
      || existing.dataStatus !== detection.dataStatus
      || Math.abs(+existing.validUntil - untilMs) > notifyRules.materialValidityExtensionMs
      || metricsChanged(existing.evidence?.metrics, detection.evidence.metrics);

    existing.level = detection.level;
    existing.evidence = detection.evidence;
    existing.source = { ...detection.source, referenceId: existing.source?.referenceId ?? null };
    existing.dataStatus = detection.dataStatus;
    existing.validFrom = new Date(newFrom);
    existing.validUntil = new Date(untilMs);
    existing.forecastIssuedAt = forecastIssuedAt(area, detection.source.provider);
    existing.lastConfirmedAt = now;
    if (material) {
      existing.lastUpdatedAt = now;
      existing.revision += 1;
    }
    await existing.save();
    return { event: existing, created: false, material };
  }

  if (blocked || settings?.hazardEnabled?.[detection.hazardType] === false) return null;

  const doc = {
    eventKey: eventKeyFor(detection, area.pcode),
    hazardType: detection.hazardType,
    origin: 'detected',
    source: { ...detection.source, referenceId: null },
    // Only the exact upazila: a forecast for one upazila is never described as a district-wide claim.
    coverage: { scope: 'upazila', upazilaPcodes: [area.pcode], districtPcodes: [], marineZone: null, matchMethod: 'representative_point' },
    level: detection.level,
    evidence: detection.evidence,
    validFrom: new Date(fromMs),
    validUntil: new Date(untilMs),
    forecastIssuedAt: forecastIssuedAt(area, detection.source.provider),
    lifecycle: 'active',
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
    revision: 1,
    dataStatus: detection.dataStatus,
  };

  try {
    const event = await HazardEvent.create(doc);
    return { event, created: true, material: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // The same key already exists (another pass created it first): treat it as the existing event.
    return { event: await HazardEvent.findOne({ eventKey: doc.eventKey }), created: false, material: false };
  }
}

// Events with the same identity but a marine zone instead of an upazila.
export async function upsertMarineEvent({ detection, zone, nowMs, settings }) {
  const now = new Date(nowMs);
  const { fromMs, untilMs } = detection.window;
  const blocked = BLOCKING.has(detection.dataStatus);

  const existing = await HazardEvent.findOne({
    hazardType: 'MARINE_WEATHER',
    origin: 'detected',
    'coverage.scope': 'marine-zone',
    'coverage.marineZone': zone.id,
    lifecycle: 'active',
    validUntil: { $gte: new Date(fromMs - GAP_MS) },
    validFrom: { $lte: new Date(untilMs + GAP_MS) },
  }).sort({ validFrom: 1 });

  if (existing) {
    if (blocked) return { event: existing, created: false, material: false };
    const material = existing.level !== detection.level
      || existing.dataStatus !== detection.dataStatus
      || Math.abs(+existing.validUntil - untilMs) > notifyRules.materialValidityExtensionMs
      || metricsChanged(existing.evidence?.metrics, detection.evidence.metrics);
    existing.level = detection.level;
    existing.evidence = detection.evidence;
    existing.dataStatus = detection.dataStatus;
    existing.validFrom = new Date(+existing.validFrom <= nowMs ? Math.min(+existing.validFrom, fromMs) : fromMs);
    existing.validUntil = new Date(untilMs);
    existing.lastConfirmedAt = now;
    if (material) { existing.lastUpdatedAt = now; existing.revision += 1; }
    await existing.save();
    return { event: existing, created: false, material };
  }

  if (blocked || settings?.hazardEnabled?.MARINE_WEATHER === false) return null;
  const doc = {
    eventKey: `mar:${zone.id}:${iso(fromMs)}`,
    hazardType: 'MARINE_WEATHER',
    origin: 'detected',
    source: { ...detection.source, referenceId: null },
    coverage: { scope: 'marine-zone', upazilaPcodes: [], districtPcodes: [], marineZone: zone.id, matchMethod: 'marine_zone' },
    level: detection.level,
    evidence: detection.evidence,
    validFrom: new Date(fromMs),
    validUntil: new Date(untilMs),
    lifecycle: 'active',
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
    revision: 1,
    dataStatus: detection.dataStatus,
  };
  try {
    return { event: await HazardEvent.create(doc), created: true, material: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { event: await HazardEvent.findOne({ eventKey: doc.eventKey }), created: false, material: false };
  }
}

// ---------- ending events ----------
const lifecycleEntry = (type, note, at) => ({ $each: [{ at, type, note }], $slice: -20 });

// The notifications of an event stop being "current". `to` is the status for sent ones; held (draft) ones are discarded or marked unsent.
async function closeNotifications(eventId, { activeTo, draftTo, type, note, reason = null, now }) {
  const sent = await Notification.updateMany(
    { hazardEventId: eventId, status: 'active' },
    { $set: { status: activeTo, withdrawalReason: reason }, $push: { lifecycle: lifecycleEntry(type, note, now) } },
  );
  await Notification.updateMany(
    { hazardEventId: eventId, status: 'draft' },
    { $set: { status: draftTo, withdrawalReason: reason }, $push: { lifecycle: lifecycleEntry(type, note, now) } },
  );
  return sent.modifiedCount;
}

// An event the forecast no longer shows: withdrawn by the system, never presented as an all-clear. Only when the deciding source is FRESH.
export async function supersedeUnconfirmed({ area, confirmedIds, nowMs, hazardTypes = null }) {
  const now = new Date(nowMs);
  const stale = await HazardEvent.find({
    ...(hazardTypes ? { hazardType: { $in: hazardTypes } } : {}),
    origin: 'detected',
    lifecycle: 'active',
    'coverage.scope': 'upazila',
    'coverage.upazilaPcodes': area.pcode,
    eventKey: /^fc:/,
    validUntil: { $gt: now },
    _id: { $nin: confirmedIds },
  });

  let superseded = 0;
  for (const event of stale) {
    if (primaryStatus(area, event.hazardType) !== 'FRESH') continue;
    event.lifecycle = 'superseded';
    event.withdrawal = { at: now, source: 'system', reason: 'forecast-updated' };
    event.lastUpdatedAt = now;
    event.revision += 1;
    await event.save();
    await closeNotifications(event._id, {
      activeTo: 'withdrawn', draftTo: 'discarded', type: 'withdrawn', reason: 'forecast-updated', now,
      note: 'The forecast changed and this alert no longer applies. This is not an all-clear.',
    });
    superseded += 1;
  }
  return superseded;
}

// Time-based expiry: the validity of an event or a notification has ended. Neither is an all-clear.
export async function expireEnded(nowMs) {
  const now = new Date(nowMs);
  const events = await HazardEvent.updateMany({ lifecycle: 'active', validUntil: { $lte: now } }, { $set: { lifecycle: 'expired', lastUpdatedAt: now } });

  const note = 'This alert period has ended. This is not an all-clear.';
  const sent = await Notification.updateMany(
    { status: 'active', validUntil: { $lte: now } },
    { $set: { status: 'expired' }, $push: { lifecycle: lifecycleEntry('expired', note, now) } },
  );
  const held = await Notification.updateMany(
    { status: 'draft', validUntil: { $lte: now } },
    { $set: { status: 'expired_unsent' }, $push: { lifecycle: lifecycleEntry('expired', note, now) } },
  );
  return { events: events.modifiedCount, sent: sent.modifiedCount, held: held.modifiedCount };
}

// An explicit withdrawal, never an all-clear. Returns the number of sent notifications withdrawn; held drafts are discarded.
export async function withdrawEvent(event, { source, reason, reference = null, nowMs = Date.now() }) {
  const now = new Date(nowMs);
  event.lifecycle = 'withdrawn';
  event.withdrawal = { at: now, source, reason, reference };
  event.lastUpdatedAt = now;
  event.revision += 1;
  await event.save();

  const text = source === 'official'
    ? 'An official notice withdrew this alert. This is not an all-clear.'
    : source === 'system'
      ? 'The river gauge is back below the alert level, so this warning was withdrawn. This is not an all-clear.'
      : 'The administrator withdrew this alert. This is not an all-clear.';
  return closeNotifications(event._id, { activeTo: 'withdrawn', draftTo: 'discarded', type: 'withdrawn', note: reason ? `${text} Reason: ${reason}` : text, reason, now });
}

export const newBatchId = () => `b_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

export { lifecycleEntry };
