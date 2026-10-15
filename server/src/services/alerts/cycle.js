import { env } from '../../config/env.js';
import { JobState } from '../../models/JobState.js';
import { Subscriber } from '../../models/Subscriber.js';
import { refreshBulletins } from '../bmdBulletins.js';
import { refreshForecasts } from '../xweatherForecast.js';
import { refreshMaritime } from '../xweatherMaritime.js';
import { monitoredMarineZones, runTick } from './engine.js';
import { refreshLightning } from './lightningGate.js';
import { lightningStage } from './lightningEpisodes.js';
import { officialStage } from './officialNotices.js';
import { loadSnapshots, marineKey, upazilaKey } from './snapshots.js';
import { stormStage } from './stormEpisodes.js';

// One cycle of the alert job: refresh what is due from Xweather through the token governor, then run the engine on the cached data.
// The browser never triggers any of this: pages read MongoDB only.
const MINUTE = 60_000;
const HOUR = 3_600_000;
export const FORECAST_EVERY = 3 * HOUR;
export const MARITIME_EVERY = 6 * HOUR;
const RETRY_AFTER_FAILURE = 30 * MINUTE;

// ---------- one lease per task, so a second process cannot run the same cycle ----------
export async function acquireLease(key, ms, nowMs = Date.now()) {
  const now = new Date(nowMs);
  try {
    const row = await JobState.findOneAndUpdate(
      { key, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
      { $set: { leaseUntil: new Date(nowMs + ms) } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return Boolean(row);
  } catch (error) {
    if (error?.code === 11000) return false; // another worker holds it
    throw error;
  }
}

export async function releaseLease(key) {
  await JobState.updateOne({ key }, { $set: { leaseUntil: null } });
}

// "Record the last completed fetch in MongoDB": a failed run never moves lastCompletedAt, so freshness always reflects the last real success.
export async function recordJob(key, task, nowMs = Date.now()) {
  await JobState.updateOne({ key }, { $set: { lastStartedAt: new Date(nowMs) } }, { upsert: true });
  try {
    const detail = await task();
    const status = detail?.status ?? 'ok';
    await JobState.updateOne({ key }, { $set: { lastCompletedAt: new Date(), lastStatus: status, lastError: null, detail } });
    return detail;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200);
    await JobState.updateOne({ key }, { $set: { lastStatus: 'error', lastError: message } });
    console.error(`[alerts] ${key}: ${message}`);
    return { status: 'error', error: message };
  }
}

const statusOf = (summary) => (summary.stoppedBy || summary.failed || summary.refused ? 'partial' : 'ok');

// ---------- what is due ----------
// Monitored upazilas with the most subscribers first, capped: only these get an Xweather forecast.
export async function topForecastAreas(limit = env.alerts.maxForecastAreas) {
  if (limit <= 0) return [];
  const rows = await Subscriber.aggregate([
    { $match: { status: 'active', expiresAt: { $gt: new Date() } } },
    { $project: { areas: { $setUnion: ['$relevantUpazilas', { $cond: [{ $gt: ['$currentArea.expiresAt', new Date()] }, ['$currentArea.upazilaPcode'], []] }] } } },
    { $unwind: '$areas' },
    { $group: { _id: '$areas', n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => row._id);
}

const dueAt = (snapshot, every, nowMs) => {
  if (!snapshot) return true;
  const last = +new Date(snapshot.attemptedAt ?? snapshot.fetchedAt);
  return nowMs - last >= (snapshot.status === 'UNAVAILABLE' ? RETRY_AFTER_FAILURE : every);
};

export async function dueForecastAreas(nowMs, pcodes) {
  const rows = await loadSnapshots('xweather', 'forecast-1hr', pcodes.map(upazilaKey));
  return pcodes
    .filter((pcode) => dueAt(rows.get(upazilaKey(pcode)), FORECAST_EVERY, nowMs))
    // The area that has waited longest goes first, so a tight budget never starves one place.
    .sort((a, b) => +new Date(rows.get(upazilaKey(a))?.fetchedAt ?? 0) - +new Date(rows.get(upazilaKey(b))?.fetchedAt ?? 0));
}

export async function dueMarineZones(nowMs) {
  const zones = (await monitoredMarineZones(nowMs)).slice(0, env.alerts.maxMarinePoints);
  if (!zones.length) return [];
  const rows = await loadSnapshots('xweather', 'maritime', zones.map((zone) => marineKey(zone.id)));
  return zones.filter((zone) => dueAt(rows.get(marineKey(zone.id)), MARITIME_EVERY, nowMs));
}

// ---------- the cycle ----------
export async function runFetchTasks({ nowMs = Date.now(), client, budget, log = console }) {
  const results = {};
  const now = () => new Date();

  const areas = await dueForecastAreas(nowMs, await topForecastAreas());
  if (areas.length) {
    results.forecast = await recordJob('xweather-forecast', async () => {
      const summary = await refreshForecasts({ client, budget, pcodes: areas, now, log });
      return { status: statusOf(summary), ...summary, areas: areas.length };
    }, nowMs);
  }

  const zones = await dueMarineZones(nowMs);
  if (zones.length) {
    results.maritime = await recordJob('xweather-maritime', async () => {
      const summary = await refreshMaritime({ client, budget, zones, now, log });
      return { status: statusOf(summary), ...summary, zones: zones.length };
    }, nowMs);
  }

  results.lightning = await recordJob('lightning-gate', async () => {
    const summary = await refreshLightning({ client, budget, nowMs, now, log });
    return { status: statusOf(summary), ...summary };
  }, nowMs);
  return results;
}

// BMD bulletins: free to read, checked every 30 minutes. A blank page or an unreadable PDF is recorded, never read as a withdrawal.
export const BULLETINS_EVERY = 30 * MINUTE;

export async function runBulletins({ nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const last = await JobState.findOne({ key: 'bulletins' }).lean();
  if (last?.lastCompletedAt && nowMs - +last.lastCompletedAt < BULLETINS_EVERY) return null;
  return recordJob('bulletins', () => refreshBulletins({ fetchImpl }), nowMs);
}

export async function runAlertCycle({
  nowMs = Date.now(), client, budget, log = console, fetchImpl,
} = {}) {
  const xweatherOn = env.alerts.xweatherEnabled && client?.hasCredentials?.();
  const fetched = xweatherOn ? await runFetchTasks({ nowMs, client, budget, log }) : null;
  const bulletins = env.alerts.bulletinsEnabled ? await runBulletins({ nowMs, fetchImpl }) : null;
  const engine = await recordJob('alert-engine', async () => ({ status: 'ok', stats: await runTick({ nowMs, extraStages: [stormStage, lightningStage, officialStage] }) }), nowMs);
  return { fetched, bulletins, engine };
}
