import { freshness } from '../../config/alertRules.js';
import { WeatherSnapshot } from '../../models/WeatherSnapshot.js';

// Shared provider results, keyed by (provider, product, query). One fetch serves every subscriber in that area.
const HOUR = 3_600_000;
const TTL_HOURS = 48;

// A failed refresh keeps the last good data and says so (status UNAVAILABLE); a first-ever failure stores an empty snapshot.
export async function saveSnapshot({
  provider, product, queryKey, scope = {}, status, data = null, issuedAt = null, validFrom = null, validTo = null,
  costTokens = null, httpStatus = null, errorClass = null, message = null, now = new Date(),
}) {
  const expiresAt = new Date(+now + TTL_HOURS * HOUR);
  const key = { provider, product, queryKey };

  if (status === 'UNAVAILABLE') {
    const updated = await WeatherSnapshot.findOneAndUpdate(
      key,
      { $set: { status, attemptedAt: now, costTokens, httpStatus, errorClass, message, expiresAt } },
      { returnDocument: 'after' },
    ).lean();
    if (updated) return updated;
    return WeatherSnapshot.findOneAndUpdate(
      key,
      { $set: { scope, fetchedAt: now, attemptedAt: now, status, data: null, costTokens, httpStatus, errorClass, message, expiresAt } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }

  return WeatherSnapshot.findOneAndUpdate(
    key,
    {
      $set: {
        scope, fetchedAt: now, attemptedAt: now, issuedAt, validFrom, validTo, status, data, costTokens, httpStatus, errorClass, message, expiresAt,
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
}

export async function loadSnapshots(provider, product, queryKeys) {
  if (!queryKeys.length) return new Map();
  const rows = await WeatherSnapshot.find({ provider, product, queryKey: { $in: queryKeys } }).lean();
  return new Map(rows.map((row) => [row.queryKey, row]));
}

// Freshness is decided here, not by the database: TTL deletion is not instantaneous and a snapshot can be old while its row still exists.
export function effectiveStatus(snapshot, maxCheckAgeMs, nowMs = Date.now()) {
  if (!snapshot) return 'UNAVAILABLE';
  if (snapshot.status === 'UNAVAILABLE' || !snapshot.data) return 'UNAVAILABLE';
  if (nowMs - +new Date(snapshot.fetchedAt) > maxCheckAgeMs) return 'STALE';
  return snapshot.status === 'PARTIAL' ? 'PARTIAL' : 'FRESH';
}

// Lightning probes: the freshness window depends on whether the gate was open (checked every 5 minutes) or it was a baseline check.
export function effectiveLightningStatus(snapshot, nowMs = Date.now()) {
  if (!snapshot || snapshot.status === 'UNAVAILABLE') return 'UNAVAILABLE';
  const maxAge = snapshot.scope?.gate === 'baseline' ? freshness.lightningProbe.baselineMaxCheckAgeMs : freshness.lightningProbe.maxCheckAgeMs;
  if (nowMs - +new Date(snapshot.fetchedAt) > maxAge) return 'STALE';
  return snapshot.status;
}

export const upazilaKey = (pcode) => `u:${pcode}`;

// The engine's view of an Xweather forecast snapshot (hourly periods, aligned pop + precip + WBGT).
export async function loadForecastInputs(pcodes, nowMs = Date.now()) {
  const rows = await loadSnapshots('xweather', 'forecast-1hr', pcodes.map(upazilaKey));
  const inputs = new Map();
  for (const pcode of pcodes) {
    const row = rows.get(upazilaKey(pcode));
    if (!row) continue;
    inputs.set(pcode, {
      status: effectiveStatus(row, freshness.xweatherForecast.maxCheckAgeMs, nowMs),
      fetchedAt: row.fetchedAt,
      issuedAt: row.issuedAt,
      hourly: row.data?.periods ?? [],
    });
  }
  return inputs;
}

export const marineKey = (zoneId) => `m:${zoneId}`;

export async function loadMarineInput(zoneId, nowMs = Date.now()) {
  const rows = await loadSnapshots('xweather', 'maritime', [marineKey(zoneId)]);
  const row = rows.get(marineKey(zoneId));
  if (!row) return null;
  return {
    status: effectiveStatus(row, freshness.xweatherMaritime.maxCheckAgeMs, nowMs),
    fetchedAt: row.fetchedAt,
    periods: row.data?.periods ?? [],
  };
}
