import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { ForecastSnapshot } from '../models/ForecastSnapshot.js';

const HOUR = 3_600_000;

// Per source: how old the last successful check and the data itself may be before the source is reported as STALE.
const SOURCES = {
  bmd: { label: 'BMD WRF forecast', maxCheckAgeMs: 3 * HOUR, maxDataAgeMs: env.weather.staleAfterHours * HOUR },
  openMeteo: { label: 'Open-Meteo forecast', maxCheckAgeMs: 3 * env.weather.openMeteoMinutes * 60_000, maxDataAgeMs: null },
  radar: { label: 'BMD weather radar', maxCheckAgeMs: HOUR, maxDataAgeMs: HOUR },
  satellite: { label: 'Himawari satellite (NASA GIBS)', maxCheckAgeMs: 3 * HOUR, maxDataAgeMs: 4 * HOUR },
};
const PERSISTED = ['bmd', 'openMeteo'];

const state = Object.fromEntries(Object.keys(SOURCES).map((name) => [name, {
  data: null,
  fetchedAt: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  dataTime: null,
  lastError: null,
}]));

let version = 0;
let cache = { version: -1, snapshot: null, snapshotJson: null, dailyJson: null };

// BMD's naive `updated_at` is Bangladesh local time (a UTC reading would put it in the future).
function parseSourceTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value);
  const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}+06:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIso(date) {
  return date ? date.toISOString() : null;
}

export function statusOf(name, now = Date.now()) {
  const rule = SOURCES[name];
  const source = state[name];
  const dataTime = parseSourceTime(source.dataTime);

  let status;
  if (!source.lastSuccessAt) {
    // Until a first attempt has actually failed, the source is simply not loaded yet.
    status = source.lastError ? 'unavailable' : 'not-checked';
  } else if (
    now - source.lastSuccessAt.getTime() > rule.maxCheckAgeMs
    || (rule.maxDataAgeMs && dataTime && now - Math.min(dataTime.getTime(), now) > rule.maxDataAgeMs)
  ) {
    status = 'stale';
  } else {
    status = 'ok';
  }

  return {
    name,
    label: rule.label,
    status,
    dataTime: toIso(dataTime),
    fetchedAt: toIso(source.fetchedAt),
    checkedAt: toIso(source.lastSuccessAt),
    message: status === 'ok' ? null : source.lastError,
  };
}

export function allStatuses(now = Date.now()) {
  return Object.fromEntries(Object.keys(SOURCES).map((name) => [name, statusOf(name, now)]));
}

function safeMessage(error) {
  return String(error?.message ?? error ?? 'Unknown error').slice(0, 160);
}

export function recordAttempt(name) {
  state[name].lastAttemptAt = new Date();
}

export function recordFailure(name, error) {
  state[name].lastAttemptAt = new Date();
  state[name].lastError = safeMessage(error);
}

// A successful check that found nothing new (e.g. BMD run unchanged) still proves the source is reachable.
export function recordCheck(name, { dataTime } = {}) {
  const now = new Date();
  state[name].lastAttemptAt = now;
  state[name].lastSuccessAt = now;
  state[name].lastError = null;
  if (dataTime !== undefined) state[name].dataTime = dataTime;
}

async function persist(name) {
  if (!PERSISTED.includes(name) || mongoose.connection.readyState !== 1) return;
  const source = state[name];
  try {
    await ForecastSnapshot.findOneAndUpdate(
      { key: name },
      { key: name, fetchedAt: source.fetchedAt, sourceUpdatedAt: source.dataTime, data: source.data },
      { upsert: true },
    );
  } catch (error) {
    console.error(`Could not persist the ${name} snapshot: ${safeMessage(error)}`);
  }
}

export function setSnapshot(name, data, { dataTime = null, persistToDb = true } = {}) {
  const now = new Date();
  Object.assign(state[name], {
    data,
    fetchedAt: now,
    lastSuccessAt: now,
    lastAttemptAt: now,
    dataTime,
    lastError: null,
  });
  version++;
  return persistToDb ? persist(name) : Promise.resolve();
}

export async function restoreSnapshots() {
  if (mongoose.connection.readyState !== 1) return;
  const saved = await ForecastSnapshot.find({ key: { $in: PERSISTED } }).lean();

  for (const doc of saved) {
    Object.assign(state[doc.key], {
      data: doc.data,
      fetchedAt: doc.fetchedAt,
      // A restored snapshot is only as fresh as when it was saved, not as when the server started.
      lastSuccessAt: doc.fetchedAt,
      dataTime: doc.sourceUpdatedAt,
    });
  }
  version++;
}

export function getSourceData(name) {
  return state[name].data;
}

export function resetForTests() {
  for (const name of Object.keys(state)) {
    Object.assign(state[name], { data: null, fetchedAt: null, lastSuccessAt: null, lastAttemptAt: null, dataTime: null, lastError: null });
  }
  version++;
}

function alignExtras(steps, extras, pick) {
  if (!extras) return {};
  const index = new Map(extras.steps.map((step, i) => [step, i]));
  const positions = steps.map((step) => index.get(step));
  const out = {};
  for (const key of ['wmo', 'ts', 'pop']) {
    const column = pick(key);
    if (column) out[key] = positions.map((i) => (i === undefined ? null : column[i] ?? null));
  }
  return out;
}

function chooseBase(now) {
  const bmd = statusOf('bmd', now).status;
  const openMeteo = statusOf('openMeteo', now).status;
  const has = (name) => Boolean(state[name].data);

  if (has('bmd') && bmd === 'ok') return 'bmd';
  if (has('openMeteo') && openMeteo === 'ok') return 'openMeteo';
  if (has('bmd')) return 'bmd';
  if (has('openMeteo')) return 'openMeteo';
  return null;
}

function buildSnapshot(now) {
  const baseName = chooseBase(now);
  const sources = allStatuses(now);
  const generatedAt = new Date(now).toISOString();
  const empty = { generatedAt, base: null, baseLabel: null, stepHours: 3, steps: [], locations: {}, districts: {}, sources };
  if (!baseName) return empty;

  const base = state[baseName].data;
  const openMeteo = baseName === 'bmd' ? state.openMeteo.data : null;
  const locations = {};
  const districts = {};

  for (const [pcode, columns] of Object.entries(base.locations)) {
    const { cape, ...kept } = columns;
    locations[pcode] = {
      ...kept,
      ...alignExtras(base.steps, openMeteo, (key) => openMeteo?.locations[pcode]?.[key]),
    };
  }
  for (const [code, columns] of Object.entries(base.districts)) {
    const { cape, ...kept } = columns;
    districts[code] = {
      ...kept,
      ...alignExtras(base.steps, openMeteo, (key) => openMeteo?.districts[code]?.[key]),
    };
  }

  return {
    ...empty,
    base: baseName === 'bmd' ? 'bmd' : 'open-meteo',
    baseLabel: SOURCES[baseName].label,
    steps: base.steps,
    locations,
    districts,
    thunderSource: baseName === 'openMeteo' || openMeteo ? 'open-meteo' : null,
  };
}

function ensureCache(now = Date.now()) {
  // Status depends on the clock, so rebuild at most once a minute even if no source changed.
  const minute = Math.floor(now / 60_000);
  if (cache.version === version && cache.minute === minute) return cache;

  const snapshot = buildSnapshot(now);
  const bmd = state.bmd.data;
  const daily = bmd && snapshot.base === 'bmd' ? bmd.daily : { days: [], locations: {} };

  cache = {
    version,
    minute,
    snapshot,
    snapshotJson: JSON.stringify({ data: snapshot }),
    dailyJson: JSON.stringify({ data: { ...daily, source: daily.days.length ? 'bmd' : null, sources: { bmd: snapshot.sources.bmd } } }),
  };
  return cache;
}

export function getSnapshotJson(now) {
  return ensureCache(now).snapshotJson;
}

export function getDailyJson(now) {
  return ensureCache(now).dailyJson;
}

export function getSnapshotObject(now) {
  return ensureCache(now).snapshot;
}
