import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { WeatherRun } from '../models/WeatherRun.js';
import { districts as districtList } from './geo.js';

// The data-for-later layer. The collectors already keep the latest forecast in MongoDB (ForecastSnapshot) and every page reads that
// cache; this adds a bounded history so earlier runs stay available for trends and back-testing. Nothing here calls a provider.
const DAY_MS = 86_400_000;
const WINDOW_24H = 8; // 3-hourly steps
const districtCodes = new Set(districtList.map((district) => district.pcode));

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const present = (values) => values.filter((value) => Number.isFinite(value));
const maxOf = (values) => { const list = present(values); return list.length ? Math.max(...list) : null; };
const sumOf = (values) => { const list = present(values); return list.length ? list.reduce((total, value) => total + value, 0) : null; };
const meanOf = (values) => { const list = present(values); return list.length ? list.reduce((total, value) => total + value, 0) / list.length : null; };

// Metric keys (district summaries; BMD rainfall units are unconfirmed, so rainfall is stored as the provider's own number):
//   t = hottest upazila's air temperature (°C)   hi = highest heat index (°C)     wg = strongest gust (km/h)   ws = strongest mean wind (km/h)
//   rf = sum of the district-mean rainfall per step   rfx = largest single-step rainfall of the wettest upazila
//   rh = mean relative humidity (%)   pop = highest precipitation probability (%, Open-Meteo)   ts = highest thunder potential (0-2, Open-Meteo)
function summarizeWindow(columns, from, to) {
  const slice = (key) => columns[key]?.slice(from, to) ?? [];
  const out = {
    t: maxOf(slice('tempMax').length ? slice('tempMax') : slice('temp')),
    hi: maxOf(slice('hiMax').length ? slice('hiMax') : slice('hi')),
    wg: maxOf(slice('wgMax').length ? slice('wgMax') : slice('wg')),
    ws: maxOf(slice('wsMax').length ? slice('wsMax') : slice('ws')),
    rf: sumOf(slice('rf')),
    rfx: maxOf(slice('rfMax').length ? slice('rfMax') : slice('rf')),
    rh: meanOf(slice('rh')),
    pop: maxOf(slice('pop')),
    ts: maxOf(slice('ts')),
  };
  const rounded = {};
  for (const [key, value] of Object.entries(out)) {
    if (value === null) continue; // a missing value stays missing; it is never written as 0
    rounded[key] = round(value, key === 'rf' || key === 'rfx' ? 2 : (key === 'rh' || key === 'pop' || key === 'ts' ? 0 : 1));
  }
  return rounded;
}

// Pure: a stored forecast payload ({ steps, districts }) -> { [districtPcode]: { w24, all } }.
export function summarizeRun(data) {
  const length = data?.steps?.length ?? 0;
  const result = {};
  if (!length || !data.districts) return result;

  for (const [code, columns] of Object.entries(data.districts)) {
    const w24 = summarizeWindow(columns, 0, Math.min(WINDOW_24H, length));
    const all = summarizeWindow(columns, 0, length);
    if (Object.keys(all).length) result[code] = { w24, all };
  }
  return result;
}

export function runIdFor(source, data, fetchedAt) {
  if (source === 'bmd' && data?.sourceUpdatedAt) return String(data.sourceUpdatedAt);
  return new Date(fetchedAt).toISOString();
}

// Called by the collectors right after a new run is stored. A failure here is logged, never thrown: history must not break collection.
export async function recordRun(source, data, { fetchedAt = new Date(), retentionDays = env.weather.historyDays } = {}) {
  if (!retentionDays || mongoose.connection.readyState !== 1) return null;

  try {
    const summary = summarizeRun(data);
    if (!Object.keys(summary).length) return null;

    const runId = runIdFor(source, data, fetchedAt);
    const steps = data.steps ?? [];
    const result = await WeatherRun.updateOne(
      { source, runId },
      {
        $setOnInsert: {
          source,
          runId,
          fetchedAt,
          sourceUpdatedAt: data.sourceUpdatedAt ?? null,
          steps: steps.length,
          firstStep: steps[0] ?? null,
          lastStep: steps.at(-1) ?? null,
          districts: summary,
          expiresAt: new Date(+fetchedAt + retentionDays * DAY_MS),
        },
      },
      { upsert: true },
    );
    return { runId, inserted: result.upsertedCount > 0 };
  } catch (error) {
    console.error(`[history] could not record the ${source} run: ${String(error?.message ?? error).slice(0, 160)}`);
    return null;
  }
}

export function isDistrictCode(value) {
  return districtCodes.has(String(value));
}

// Newest first. `days` is how far back to look; one district's series, or the run summaries for every district when none is named.
export async function listRuns({ source = 'bmd', district = null, days = 7, limit = 200, now = Date.now() } = {}) {
  const since = new Date(now - days * DAY_MS);
  const rows = await WeatherRun.find({ source, fetchedAt: { $gte: since } }).sort({ fetchedAt: -1 }).limit(limit).lean();

  return rows.map((row) => ({
    runId: row.runId,
    fetchedAt: row.fetchedAt,
    sourceUpdatedAt: row.sourceUpdatedAt,
    steps: row.steps,
    firstStep: row.firstStep,
    lastStep: row.lastStep,
    ...(district ? { summary: row.districts?.[district] ?? null } : { districts: row.districts }),
  }));
}
