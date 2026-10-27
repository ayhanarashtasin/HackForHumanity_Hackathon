import mongoose from 'mongoose';
import { env } from '../../../config/env.js';
import { HazardEvent } from '../../../models/HazardEvent.js';
import { JobState } from '../../../models/JobState.js';
import { geocodePlace } from '../../geocode.js';
import { compactRoute, hospitalsAlongRoute, nearestHospitals } from '../../hospitals.js';
import { loadFloodSnapshot, nearestGauges } from '../../alerts/floodSense.js';
import { loadShelterSnapshot, nearestSchoolShelters, nearestShelters, shelterSnapshotStatus } from '../../alerts/floodShelters.js';
import { listInbox } from '../../alerts/inbox.js';
import { circlesCovering } from '../../alerts/lightningGate.js';
import { effectiveLightningStatus, loadSnapshots } from '../../alerts/snapshots.js';
import { buildUpazilaSummaries, loadGeoData } from '../../lightningCampaign.js';
import { subscriberForChat, telegramLanguage } from '../linking.js';
import { beginTelegramFollow, refreshTelegramFollow, requestTelegramFollow, stopTelegramFollow } from '../telegramLocation.js';
import { buildRouteWeather } from '../../routeWeather.js';
import { latestStormSnapshot, stormDataStatus, stormReach } from '../../stormOutlook.js';
import { representativePcode } from './places.js';
import { chooseLightning, loadForecast } from './readings.js';

// The bot's reads from MongoDB. Like every page, it only reads what the background jobs stored: no command calls a weather provider.
const dbReady = () => mongoose.connection.readyState === 1;

const PROBE_KIND = { FRESH: 'reported', NO_MATCH: 'none', STALE: 'stale' };

// What lightning checks say about a place. Two stored sources can know: the alert engine's probes of the 100 km circles around the areas
// people monitor, and the map's campaign samples per upazila. The most recent check is the one shown.
export async function lightningFor(place, { nowMs = Date.now() } = {}) {
  if (!dbReady()) return { pick: null, error: true };
  const candidates = [];
  let attempts = 0;
  let failures = 0;
  const geo = loadGeoData();

  if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    attempts += 1;
    try {
      const circles = circlesCovering(geo, { lat: place.lat, lon: place.lon });
      const rows = circles.length ? await loadSnapshots('xweather', 'lightning-summary', circles.map((circle) => `c:${circle.id}`)) : new Map();
      for (const circle of circles) {
        const row = rows.get(`c:${circle.id}`);
        if (!row) continue;
        const kind = PROBE_KIND[effectiveLightningStatus(row, nowMs)] ?? 'unavailable';
        candidates.push({
          kind,
          sampledMs: +new Date(kind === 'unavailable' ? row.attemptedAt ?? row.fetchedAt : row.fetchedAt),
          count: Number.isFinite(row.data?.count) ? row.data.count : null,
          radiusKm: row.scope?.radiusKm ?? geo.apiRadiusKm,
          source: 'alert-engine',
        });
      }
    } catch {
      failures += 1;
    }
  }

  const pcode = representativePcode(place);
  if (pcode) {
    attempts += 1;
    try {
      const summary = await buildUpazilaSummaries(pcode, { now: () => new Date(nowMs) });
      for (const item of summary?.items ?? []) {
        candidates.push({
          kind: item.state,
          sampledMs: item.sampledAt ? Date.parse(item.sampledAt) : null,
          count: Number.isFinite(item.count) ? item.count : null,
          radiusKm: item.radiusKm,
          source: 'campaign',
        });
      }
    } catch {
      failures += 1;
    }
  }
  return { pick: chooseLightning(candidates), error: attempts > 0 && failures === attempts };
}

// What the storm tracker's newest satellite image says about a place: the strong cell that reaches any of its upazilas soonest, counted
// from now (stormOutlook.js). -> { status: FRESH | STALE | UNAVAILABLE, observedAtMs, hit | null }.
export async function stormFor(place, { nowMs = Date.now() } = {}) {
  const snapshot = await latestStormSnapshot();
  const status = stormDataStatus(snapshot, nowMs);
  if (status !== 'FRESH') return { status, observedAtMs: snapshot?.observedAtMs ?? null, hit: null };
  let hit = null;
  for (const candidate of stormReach(snapshot, place.members ?? [], nowMs).values()) {
    if (!hit || candidate.arrivalMs < hit.arrivalMs) hit = candidate;
  }
  return { status, observedAtMs: snapshot.observedAtMs, hit };
}

// Active hazards (what the alert engine detected or an administrator declared) on the upazilas and districts a road passes, in force at
// some point of the trip. Only the hazard, the area and its end time are shown: never who was alerted or why. Demo events are left out.
export async function routeHazards({
  pcodes = [], districtCodes = [], fromMs, untilMs,
}) {
  if (!dbReady()) throw new Error('database not ready');
  return HazardEvent.find({
    lifecycle: 'active',
    isDemo: { $ne: true },
    validUntil: { $gt: new Date(fromMs) },
    validFrom: { $lt: new Date(untilMs) },
    $or: [{ 'coverage.upazilaPcodes': { $in: pcodes } }, { 'coverage.districtPcodes': { $in: districtCodes } }],
  }, { hazardType: 1, coverage: 1, validUntil: 1 }).sort({ validUntil: 1 }).limit(30).lean();
}

// Hospitals near the road the trip takes, for the Telegram route report: the same search on the same compacted road the website sends,
// so the two list the same hospitals. null when switched off; throws when the hospital file cannot be read (the report then says
// "unavailable", never "no hospitals").
export async function hospitalsFor(coordinates) {
  return hospitalsAlongRoute(compactRoute(coordinates));
}

// Top 3 nearest hospitals for a place (or coordinates) with phone numbers.
export async function nearestHospitalsForPlace(place, { limit = 3 } = {}) {
  const lat = place?.lat;
  const lon = place?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  try {
    return nearestHospitals(lat, lon, limit);
  } catch {
    return [];
  }
}

// School shelter lookup is independent of FFWC and forecast availability. It reads only the stored DDM list.
export async function schoolSheltersFor(place, { nowMs = Date.now() } = {}) {
  const unavailable = { status: 'UNAVAILABLE', fetchedAt: null, shelters: [] };
  if (!env.flood.sheltersEnabled) return { ...unavailable, disabled: true };
  if (!dbReady() || !Number.isFinite(place?.lat) || !Number.isFinite(place?.lon)) return unavailable;
  const snapshot = await loadShelterSnapshot();
  if (!Array.isArray(snapshot?.data?.shelters)) return unavailable;
  return {
    status: shelterSnapshotStatus(snapshot, nowMs),
    fetchedAt: snapshot.fetchedAt ?? null,
    shelters: nearestSchoolShelters(snapshot.data.shelters, place.lat, place.lon),
  };
}

export async function floodFor(place, { nowMs = Date.now() } = {}) {
  if (!dbReady()) return { status: 'UNAVAILABLE', error: true };
  let floodSnapshot;
  try {
    floodSnapshot = await loadFloodSnapshot(nowMs);
  } catch {
    return { status: 'UNAVAILABLE', error: true };
  }
  const { data, status } = floodSnapshot ?? {};
  let reading = null;
  let nearest = [];
  const lat = place?.lat;
  const lon = place?.lon;

  if (data?.readings?.length) {
    const pcode = representativePcode(place) || place?.id;
    if (pcode) {
      reading = data.readings.find((r) => r.area?.upazilaPcode === pcode || r.area?.districtPcode === pcode) ?? null;
    }
  }
  if (data && Number.isFinite(lat) && Number.isFinite(lon)) {
    nearest = nearestGauges(data, lat, lon, 3);
  }
  if (!reading && nearest.length) {
    reading = nearest[0];
  }

  let shelters = [];
  if (env.flood.sheltersEnabled && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const shelterSnapshot = await loadShelterSnapshot();
      shelters = nearestShelters(shelterSnapshot?.data?.shelters ?? [], lat, lon, env.flood.maxShelters || 3);
    } catch {
      shelters = [];
    }
  }

  return {
    status,
    data,
    reading,
    nearestGauges: nearest,
    shelters,
    dataTime: data?.issuedAt ? +new Date(data.issuedAt) : null,
  };
}

export async function alertsFor(subscriber, nowMs = Date.now()) {
  if (!dbReady()) throw new Error('database not ready');
  return listInbox(subscriber._id, { view: 'active', now: new Date(nowMs) });
}

export async function engineStatus() {
  const row = dbReady() ? await JobState.findOne({ key: 'alert-engine' }).lean().catch(() => null) : null;
  return {
    enabled: env.alerts.engineEnabled,
    lastCompletedMs: row?.lastCompletedAt ? +new Date(row.lastCompletedAt) : null,
    lastStatus: row?.lastStatus ?? null,
  };
}

// Tests replace any of these.
export const defaultDeps = {
  loadForecast,
  routeWeather: buildRouteWeather,
  routeHazards,
  stormSnapshot: latestStormSnapshot,
  geocode: (query) => geocodePlace(query),
  subscriberForChat,
  telegramLanguage,
  beginTelegramFollow,
  refreshTelegramFollow,
  requestTelegramFollow,
  stopTelegramFollow,
  lightningFor,
  stormFor,
  floodFor,
  schoolSheltersFor,
  hospitalsFor,
  nearestHospitalsForPlace,
  alertsFor,
  engineStatus,
};
