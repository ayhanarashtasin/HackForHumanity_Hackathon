import mongoose from 'mongoose';
import { env } from '../../../config/env.js';
import { JobState } from '../../../models/JobState.js';
import { listInbox } from '../../alerts/inbox.js';
import { circlesCovering } from '../../alerts/lightningGate.js';
import { effectiveLightningStatus, loadSnapshots } from '../../alerts/snapshots.js';
import { buildUpazilaSummaries, loadGeoData } from '../../lightningCampaign.js';
import { subscriberForChat } from '../linking.js';
import { buildRouteWeather } from '../../routeWeather.js';
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
  subscriberForChat,
  lightningFor,
  alertsFor,
  engineStatus,
};
