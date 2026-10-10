import { MARINE_ZONES } from '../../config/alertConstants.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import { Notification } from '../../models/Notification.js';
import { Subscriber } from '../../models/Subscriber.js';
import { dhakaIso } from '../time.js';
import {
  expireEnded, lifecycleEntry, supersedeUnconfirmed, upsertDetectedEvent, upsertMarineEvent,
} from './events.js';
import { detectAreaHazards, detectMarine } from './hazards.js';
import { applyEvent } from './notify.js';
import { buildAreaForecast, loadSources } from './normalize.js';
import { evaluateSubscriber } from './scenarios/index.js';
import { getSettings } from './settings.js';
import { loadForecastInputs, loadMarineInput } from './snapshots.js';

// One engine pass: 0 validate/normalise -> 1 detect -> 2 recipients -> 3 scenarios -> 4 compose, de-duplicate, publish, store.
// It reads cached provider data only; it never calls a provider (the fetch jobs do, on their own schedule and budget).
const enabled = (settings, type) => settings.hazardEnabled?.[type] !== false;

export async function monitoredAreas(nowMs = Date.now()) {
  return Subscriber.distinct('relevantUpazilas', { status: 'active', expiresAt: { $gt: new Date(nowMs) } });
}

export async function monitoredMarineZones(nowMs = Date.now()) {
  const count = await Subscriber.countDocuments({
    status: 'active', expiresAt: { $gt: new Date(nowMs) }, occupation: 'fisherman', 'occupationData.waterBody': { $in: ['coastal', 'marine'] },
  });
  // Coastal and open-sea fishermen are all matched to the zones we can monitor (today only the North Bay).
  return count ? MARINE_ZONES : [];
}

// Stage 1 for every monitored area: forecast hazards -> events.
async function detectForecastHazards({ areas, nowMs, sources, settings, stats }) {
  const inputs = await loadForecastInputs(areas, nowMs);

  for (const pcode of areas) {
    const area = buildAreaForecast(pcode, { now: nowMs, sources, xweather: inputs.get(pcode) ?? null });
    if (!area) continue;

    const confirmed = [];
    for (const detection of detectAreaHazards(area, nowMs)) {
      if (!enabled(settings, detection.hazardType)) continue;
      const result = await upsertDetectedEvent({ detection, area, nowMs, settings });
      if (!result) { stats.blocked += 1; continue; }
      confirmed.push(result.event._id);
      if (result.created) stats.eventsCreated += 1;
      else if (result.material) stats.eventsUpdated += 1;
    }

    const hazardTypes = ['HEAVY_RAIN', 'HEAT_STRESS', 'STRONG_WIND', 'DRY_SPELL'].filter((type) => enabled(settings, type));
    stats.eventsSuperseded += await supersedeUnconfirmed({ area, confirmedIds: confirmed, nowMs, hazardTypes });
  }
}

async function detectMarineHazards({ zones, nowMs, settings, stats }) {
  if (!enabled(settings, 'MARINE_WEATHER')) return;
  for (const zone of zones) {
    const input = await loadMarineInput(zone.id, nowMs);
    if (!input) continue;
    const detection = detectMarine({ periods: input.periods, status: input.status }, nowMs);
    if (!detection || detection.level <= 0 || !detection.window) continue;
    const result = await upsertMarineEvent({ detection, zone, nowMs, settings });
    if (!result) { stats.blocked += 1; continue; }
    if (result.created) stats.eventsCreated += 1;
    else if (result.material) stats.eventsUpdated += 1;
  }
}

// Stages 2-4 for every active event.
async function notifyForEvents({ nowMs, settings, stats }) {
  const events = await HazardEvent.find({ lifecycle: 'active', validUntil: { $gt: new Date(nowMs) } });
  for (const event of events) {
    if (!enabled(settings, event.hazardType)) continue;
    const summary = await applyEvent(event, { nowMs, settings, publishedBy: 'engine' });
    stats.recipients += summary.recipients;
    stats.notificationsCreated += summary.inserted;
    stats.notificationsUpdated += summary.updated + summary.escalated + summary.refreshed;
    stats.held += summary.held;
    stats.skippedCap += summary.skippedCap;
  }
  stats.activeEvents = events.length;
}

export const newStats = (nowMs) => ({
  at: dhakaIso(new Date(nowMs)), areas: 0, eventsCreated: 0, eventsUpdated: 0, eventsSuperseded: 0, blocked: 0, activeEvents: 0,
  recipients: 0, notificationsCreated: 0, notificationsUpdated: 0, held: 0, skippedCap: 0, expired: null,
});

// Stage 1 for everything monitored: forecast hazards, marine weather, and any extra stage (lightning, bulletins) that produces events the same way.
// It only creates and updates hazard events (occupation-neutral), never notifications, so an administrator can run it before a preview.
export async function detectAll({ nowMs = Date.now(), sources = null, extraStages = [], stats = newStats(nowMs) } = {}) {
  const settings = await getSettings({ force: true, now: nowMs });
  const loaded = sources ?? loadSources(nowMs);

  const areas = await monitoredAreas(nowMs);
  stats.areas = areas.length;
  if (areas.length) await detectForecastHazards({ areas, nowMs, sources: loaded, settings, stats });

  const zones = await monitoredMarineZones(nowMs);
  if (zones.length) await detectMarineHazards({ zones, nowMs, settings, stats });

  for (const stage of extraStages) await stage({ nowMs, settings, stats, areas, zones });
  return { settings, stats };
}

// One full pass: detect, notify every active event's recipients, then end whatever has run out of time.
export async function runTick({ nowMs = Date.now(), sources = null, extraStages = [] } = {}) {
  const { settings, stats } = await detectAll({ nowMs, sources, extraStages });
  await notifyForEvents({ nowMs, settings, stats });
  stats.expired = await expireEnded(nowMs);
  return stats;
}

// ---------- one subscriber (sign-up backfill and profile edits) ----------
// Evaluates a (new or edited) profile against the events that are active now: database only, no provider call.
export async function evaluateSubscriberNow(subscriberId, { nowMs = Date.now() } = {}) {
  const subscriber = await Subscriber.findById(subscriberId).lean();
  if (!subscriber) return null;
  const settings = await getSettings({ now: nowMs });

  const upazilas = subscriber.relevantUpazilas;
  const districts = subscriber.relevantDistricts;
  const events = await HazardEvent.find({
    lifecycle: 'active',
    validUntil: { $gt: new Date(nowMs) },
    $or: [
      { 'coverage.upazilaPcodes': { $in: upazilas } },
      { 'coverage.districtPcodes': { $in: districts } },
      { 'coverage.scope': 'marine-zone' },
    ],
  });

  const totals = { inserted: 0, updated: 0 };
  for (const event of events) {
    if (!enabled(settings, event.hazardType)) continue;
    const summary = await applyEvent(event, { nowMs, settings, subscriberIds: [subscriber._id], publishedBy: 'engine' });
    totals.inserted += summary.inserted;
    totals.updated += summary.updated + summary.escalated + summary.refreshed;
  }
  return totals;
}

// After a profile edit: alerts whose rule no longer matches the person are withdrawn (not an all-clear), then the new profile is backfilled.
export async function reevaluateSubscriber(subscriberId, { nowMs = Date.now() } = {}) {
  const subscriber = await Subscriber.findById(subscriberId).lean();
  if (!subscriber) return null;

  const current = await Notification.find({ subscriberId, status: { $in: ['active', 'draft'] } }).lean();
  const events = new Map((await HazardEvent.find({ _id: { $in: [...new Set(current.map((item) => String(item.hazardEventId)))] } })).map((event) => [String(event._id), event]));
  const now = new Date(nowMs);
  let withdrawn = 0;

  for (const notification of current) {
    const event = events.get(String(notification.hazardEventId));
    if (!event || notification.origin === 'admin-message') continue;
    // Judged at the time it was created, so a lead window or a finished shift cannot make a still-valid alert look unmatched.
    const stillMatches = evaluateSubscriber({ subscriber, event, nowMs: +new Date(notification.createdAt) })
      .some((entry) => entry.scenario.id === notification.scenarioId);
    if (stillMatches) continue;

    await Notification.updateOne({ _id: notification._id }, {
      $set: { status: notification.status === 'draft' ? 'discarded' : 'withdrawn', withdrawalReason: 'profile-changed' },
      $push: { lifecycle: lifecycleEntry('withdrawn', 'Your profile changed, so this alert no longer applies to you. This is not an all-clear.', now) },
    });
    withdrawn += 1;
  }

  const added = await evaluateSubscriberNow(subscriberId, { nowMs });
  return { withdrawn, ...added };
}
