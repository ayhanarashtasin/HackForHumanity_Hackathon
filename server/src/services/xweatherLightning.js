import { containsPoint } from './geoPoint.js';
import { saveSnapshot } from './alerts/snapshots.js';

// Xweather lightning: a cheap summary probe (1 token), observed strikes (10) and short-range threat polygons (10).
//
// CAUTION: a *populated* strikes or threats response has never been observed on this account (every live query so far returned
// "valid request, no matching data"). The parsers below follow the provider's documentation, are written defensively, and are tested
// against synthetic fixtures. Anything they do not recognise is reported as PARTIAL data and never turned into an invented strike or threat.
export const PROBE_COST = 1;
export const STRIKE_COST = 10;
export const THREAT_COST = 10;
export const STRIKE_LIMIT = 250;
export const THREAT_PERIOD_MS = 10 * 60_000;

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------- strikes ----------
// Documented fields: id, loc.lat, loc.long, ob.timestamp (seconds), ob.dateTimeISO, ob.pulse.type (cg / ic).
export function parseStrikes(json) {
  const response = json?.response;
  const list = Array.isArray(response) ? response : [];
  const strikes = [];

  for (const item of list) {
    const lat = number(item?.loc?.lat);
    const lon = number(item?.loc?.long ?? item?.loc?.lon);
    const seconds = number(item?.ob?.timestamp);
    const at = seconds !== null ? seconds * 1000 : Date.parse(item?.ob?.dateTimeISO ?? '');
    if (lat === null || lon === null || Number.isNaN(at)) continue;

    const raw = String(item?.ob?.pulse?.type ?? '').toLowerCase();
    strikes.push({
      id: String(item.id ?? `${at}:${lat}:${lon}`),
      at,
      lat,
      lon,
      type: raw === 'cg' || raw === 'ic' ? raw : 'unknown',
    });
  }
  return { strikes, recognised: !list.length || strikes.length > 0 };
}

// ---------- threats ----------
function firstGeometry(value, depth = 0) {
  if (!isObject(value) && !Array.isArray(value)) return null;
  if (isObject(value) && ['Polygon', 'MultiPolygon'].includes(value.type) && Array.isArray(value.coordinates)) return value;
  if (depth > 5) return null;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstGeometry(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function timeOf(period, keys) {
  for (const key of keys) {
    const value = period?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : value * 1000;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

// Documented: issue and validity times, one polygon per 10-minute period (up to 60 minutes ahead), movement and path. Only the polygons
// and their times are used. Returns { threats: [{ id, periods: [{ startMs, endMs, geometry }] }], recognised }.
export function parseThreats(json) {
  const response = json?.response;
  const list = Array.isArray(response) ? response : (isObject(response) ? [response] : []);
  const threats = [];

  list.forEach((item, index) => {
    const rawPeriods = Array.isArray(item?.periods) ? item.periods : (Array.isArray(item?.threat?.periods) ? item.threat.periods : []);
    const periods = [];
    for (const period of rawPeriods) {
      const geometry = firstGeometry(period);
      const startMs = timeOf(period, ['validFrom', 'validFromISO', 'startISO', 'start', 'dateTimeISO', 'validTime', 'timestamp']);
      if (!geometry || startMs === null) continue;
      const endMs = timeOf(period, ['validTo', 'validToISO', 'endISO', 'end', 'expiresISO', 'expires']) ?? startMs + THREAT_PERIOD_MS;
      periods.push({ startMs, endMs: endMs > startMs ? endMs : startMs + THREAT_PERIOD_MS, geometry });
    }
    if (periods.length) threats.push({ id: String(item.id ?? index), periods });
  });
  return { threats, recognised: !list.length || threats.length > 0 };
}

// The earliest threat period that covers a point and has not ended yet, within the horizon. Null when none does.
export function threatAt(threats, lon, lat, nowMs, horizonMs) {
  let best = null;
  for (const threat of threats) {
    for (const period of threat.periods) {
      if (period.endMs <= nowMs || period.startMs > nowMs + horizonMs) continue;
      if (!containsPoint(period.geometry, lon, lat)) continue;
      if (!best || period.startMs < best.startMs) best = { startMs: period.startMs, endMs: period.endMs, threatId: threat.id };
    }
  }
  return best;
}

// ---------- requests (all through the token governor) ----------
async function run({ budget, cls, cost, request }) {
  const decision = await budget.reserve(cls, cost);
  if (!decision.ok) return { refused: decision.reason };
  await budget.pace();
  const result = await request();
  await budget.settle({ cls, reserved: cost, headers: result.headers });
  return { result };
}

const FATAL = new Set(['auth', 'quota', 'rate-limit']);

// Tier 1: the 100 km circle, previous 5 minutes. Returns { refused } | { stopped } | { status, positive, snapshot }.
// `previous` is the circle's last probe snapshot: a quiet probe must not forget that lightning was seen a few minutes ago (it keeps the gate open).
export async function probeCircle({
  client, budget, circle, radiusKm, gate, previous = null, now = () => new Date(),
}) {
  const done = await run({ budget, cls: 'lightning_probe', cost: PROBE_COST, request: () => client.fetchSummary({ lat: circle.lat, lon: circle.lon, radiusKm }) });
  if (done.refused) return { refused: done.refused };
  const { result } = done;

  const at = now();
  const base = {
    provider: 'xweather', product: 'lightning-summary', queryKey: `c:${circle.id}`,
    scope: { lat: circle.lat, lon: circle.lon, radiusKm, gate, lastPositiveAt: previous?.scope?.lastPositiveAt ?? null },
    costTokens: result.headers.cost,
    httpStatus: result.httpStatus,
    now: at,
  };

  if (result.class === 'ok') {
    base.scope.lastPositiveAt = at.toISOString();
    const snapshot = await saveSnapshot({ ...base, status: 'FRESH', data: result.summary, message: result.summary.detail });
    // A populated summary whose count field was not recognised is still "reported": it triggers the strike fetch.
    return { status: 'FRESH', positive: result.summary.count === null || result.summary.count > 0, snapshot };
  }
  if (result.class === 'no-data') {
    const snapshot = await saveSnapshot({ ...base, status: 'NO_MATCH', data: { count: 0 }, message: 'No lightning matched in the previous five minutes.' });
    return { status: 'NO_MATCH', positive: false, snapshot };
  }
  const snapshot = await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: result.class, message: result.message });
  return FATAL.has(result.class) ? { stopped: result.class, status: 'UNAVAILABLE', snapshot } : { status: 'UNAVAILABLE', positive: false, snapshot };
}

// Tier 2: strikes in the circle, once per positive probe. Distances to every monitored upazila are computed locally afterwards.
export async function fetchStrikes({ client, budget, circle, radiusKm, now = () => new Date() }) {
  const done = await run({
    budget, cls: 'lightning_strikes', cost: STRIKE_COST,
    request: () => client.fetchJson({ path: '/lightning/closest', query: { p: `${circle.lat},${circle.lon}`, radius: `${radiusKm}km`, limit: STRIKE_LIMIT, from: '-5minutes', to: 'now' } }),
  });
  if (done.refused) return { refused: done.refused };
  const { result } = done;

  const at = now();
  const base = {
    provider: 'xweather', product: 'lightning-strikes', queryKey: `c:${circle.id}`,
    scope: { lat: circle.lat, lon: circle.lon, radiusKm }, costTokens: result.headers.cost, httpStatus: result.httpStatus, now: at,
  };

  if (result.class === 'ok') {
    const { strikes, recognised } = parseStrikes(result.json);
    if (!recognised) {
      await saveSnapshot({ ...base, status: 'PARTIAL', data: { strikes: [] }, message: 'Strikes were returned in a shape that is not recognised, so none were used.' });
      return { status: 'PARTIAL', strikes: [] };
    }
    await saveSnapshot({ ...base, status: strikes.length ? 'FRESH' : 'NO_MATCH', data: { strikes } });
    return { status: 'FRESH', strikes };
  }
  if (result.class === 'no-data') {
    await saveSnapshot({ ...base, status: 'NO_MATCH', data: { strikes: [] } });
    return { status: 'NO_MATCH', strikes: [] };
  }
  await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: result.class, message: result.message });
  return FATAL.has(result.class) ? { stopped: result.class, status: 'UNAVAILABLE' } : { status: 'UNAVAILABLE' };
}

// Tier 3: threat polygons for the circle.
export async function fetchThreats({ client, budget, circle, radiusKm, now = () => new Date() }) {
  const done = await run({
    budget, cls: 'lightning_threats', cost: THREAT_COST,
    request: () => client.fetchJson({ path: '/lightning/threats/closest', query: { p: `${circle.lat},${circle.lon}`, radius: `${radiusKm}km`, limit: 25 } }),
  });
  if (done.refused) return { refused: done.refused };
  const { result } = done;

  const at = now();
  const base = {
    provider: 'xweather', product: 'lightning-threats', queryKey: `c:${circle.id}`,
    scope: { lat: circle.lat, lon: circle.lon, radiusKm }, costTokens: result.headers.cost, httpStatus: result.httpStatus, now: at,
  };

  if (result.class === 'ok') {
    const { threats, recognised } = parseThreats(result.json);
    if (!recognised) {
      await saveSnapshot({ ...base, status: 'PARTIAL', data: { threats: [] }, message: 'Threat data was returned in a shape that is not recognised, so none was used.' });
      return { status: 'PARTIAL', threats: [] };
    }
    await saveSnapshot({ ...base, status: threats.length ? 'FRESH' : 'NO_MATCH', data: { threats } });
    return { status: 'FRESH', threats };
  }
  if (result.class === 'no-data') {
    await saveSnapshot({ ...base, status: 'NO_MATCH', data: { threats: [] } });
    return { status: 'NO_MATCH', threats: [] };
  }
  await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: result.class, message: result.message });
  return FATAL.has(result.class) ? { stopped: result.class, status: 'UNAVAILABLE' } : { status: 'UNAVAILABLE' };
}
