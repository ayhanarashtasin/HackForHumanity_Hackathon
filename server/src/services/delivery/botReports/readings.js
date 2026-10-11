import { hazardRules } from '../../../config/alertRules.js';
import { env } from '../../../config/env.js';
import { heatIndexCategories } from '../../../config/thresholds.js';
import { circularMeanDegrees } from '../../aggregate.js';
import { dhakaDate } from '../../time.js';
import { allStatuses, getSourceData } from '../../weatherStore.js';

// What the bot knows about the weather at a place: pure functions over the stored forecast. Nothing here reads the network or the database,
// and nothing here words a result; text.js does that. A forecast value is never a measurement and a missing value is never zero.
export const HOUR = 3_600_000;
export const STEP_MS = 3 * HOUR;

// ---------- the forecast on hand ----------
// The same base choice the map makes: BMD when it is current, else Open-Meteo, else whichever exists (and is then reported as stale).
export function loadForecast({
  now = Date.now(), bmd, openMeteo, statuses,
} = {}) {
  const info = statuses ?? allStatuses(now);
  const bmdRaw = bmd === undefined ? getSourceData('bmd') : bmd;
  const meteoRaw = openMeteo === undefined ? getSourceData('openMeteo') : openMeteo;
  const has = (raw) => Boolean(raw?.steps?.length);
  const status = (name) => info[name]?.status ?? 'not-checked';

  let base = null;
  if (has(bmdRaw) && status('bmd') === 'ok') base = 'bmd';
  else if (has(meteoRaw) && status('openMeteo') === 'ok') base = 'openMeteo';
  else if (has(bmdRaw)) base = 'bmd';
  else if (has(meteoRaw)) base = 'openMeteo';

  const baseRaw = base === 'bmd' ? bmdRaw : base === 'openMeteo' ? meteoRaw : null;
  return {
    nowMs: now,
    base,
    baseRaw,
    bmd: { raw: bmdRaw, info: info.bmd ?? null },
    openMeteo: { raw: meteoRaw, info: info.openMeteo ?? null },
    stepsMs: baseRaw ? baseRaw.steps.map((step) => Date.parse(step)) : [],
  };
}

// ---------- one column of one source for one place ----------
const present = (value) => value !== null && value !== undefined && Number.isFinite(value);
const MEAN_KEYS = new Set(['temp', 'rh', 'cc', 'hi', 'rf', 'ws', 'wg']);
const MAX_KEYS = new Set(['ts', 'pop', 'wmo']);
// A district has no forecast of its own: it is built from its upazilas. Heat, rain and gusts show the highest upazila; the rest the average.
const DISTRICT_KEY = { hi: 'hiMax', rf: 'rfMax', wg: 'wgMax' };

function combine(raw, place, key) {
  const members = (place.members ?? []).map((pcode) => raw.locations?.[pcode]).filter(Boolean);
  const used = place.approx ? members.slice(0, 1) : members;
  if (!used.some((member) => member[key])) return null;
  const length = raw.steps.length;
  return Array.from({ length }, (_, i) => {
    const values = used.map((member) => member[key]?.[i]).filter(present);
    if (!values.length) return null;
    if (MAX_KEYS.has(key)) return Math.max(...values);
    if (key === 'wd') return Math.round(circularMeanDegrees(values));
    if (MEAN_KEYS.has(key)) return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
    return values[0];
  });
}

export function rawColumn(raw, place, key) {
  if (!raw?.steps?.length) return null;
  if (place.level === 'location') return raw.locations?.[place.id]?.[key] ?? null;
  if (place.level === 'district') return raw.districts?.[place.id]?.[DISTRICT_KEY[key] ?? key] ?? null;
  return combine(raw, place, key);
}

// Moves a column of another source onto the base steps (a missing step stays null).
function align(baseSteps, otherSteps, column) {
  if (!column || !otherSteps) return null;
  const index = new Map(otherSteps.map((step, i) => [step, i]));
  return baseSteps.map((step) => {
    const i = index.get(step);
    return i === undefined ? null : column[i] ?? null;
  });
}

export function stepIndex(stepsMs, nowMs) {
  return stepsMs.findIndex((start) => start <= nowMs && nowMs < start + STEP_MS);
}

// ---------- the forecast for one place ----------
export function forecastFor(place, ctx) {
  if (!ctx.baseRaw) return { place, available: false, reason: 'no-data' };
  const steps = ctx.baseRaw.steps;
  const own = (key) => rawColumn(ctx.baseRaw, place, key);
  const temp = own('temp');
  if (!temp) return { place, available: false, reason: 'no-place' };

  const meteo = ctx.openMeteo;
  const fromMeteo = (key) => (ctx.base === 'openMeteo' ? own(key) : align(steps, meteo.raw?.steps, rawColumn(meteo.raw, place, key)));
  const coreSource = ctx.base === 'bmd' ? 'bmd' : 'open-meteo';
  const coreInfo = ctx.base === 'bmd' ? ctx.bmd.info : meteo.info;

  // Rain amounts: Open-Meteo's unit is known, BMD's is not yet confirmed (the alert engine refuses BMD amounts for the same reason),
  // so a current Open-Meteo forecast is preferred and BMD's amounts carry a caveat.
  let rain;
  const meteoRain = ctx.base === 'openMeteo' ? own('rf') : (meteo.info?.status === 'ok' ? fromMeteo('rf') : null);
  if (meteoRain) rain = { values: meteoRain, source: 'open-meteo', info: meteo.info, unverified: false };
  else rain = { values: own('rf'), source: coreSource, info: coreInfo, unverified: coreSource === 'bmd' && !env.alerts.bmdRainVerified };

  // BMD's gust is its own model output and is below its own mean wind in about a third of the steps. A gust is by definition never
  // lighter than the mean wind, so the larger of the two published numbers is shown; no value is made up and a missing gust stays missing.
  const speeds = own('ws');
  const gusts = own('wg');
  const gustAtLeastMean = gusts && speeds ? gusts.map((gust, i) => (present(gust) && present(speeds[i]) ? Math.max(gust, speeds[i]) : gust)) : gusts;

  const thunderValues = fromMeteo('ts');
  return {
    place,
    available: true,
    nowMs: ctx.nowMs,
    steps: ctx.stepsMs,
    nowIdx: stepIndex(ctx.stepsMs, ctx.nowMs),
    base: ctx.base,
    coreSource,
    coreInfo,
    cols: {
      temp, hi: own('hi'), rh: own('rh'), ws: speeds, wg: gustAtLeastMean, wd: own('wd'), cc: own('cc'), wmo: fromMeteo('wmo'), pop: fromMeteo('pop'),
    },
    rain,
    thunder: { values: thunderValues, source: 'open-meteo', info: meteo.info },
  };
}

// Steps that overlap [now, now + hours): the current step and the ones after it.
export function windowIdx(forecast, hours) {
  const { steps, nowMs } = forecast;
  return steps.map((start, i) => i).filter((i) => steps[i] + STEP_MS > nowMs && steps[i] < nowMs + hours * HOUR);
}

// Steps that begin after the current one, within `hours`.
export function laterIdx(forecast, hours) {
  const { steps, nowMs } = forecast;
  return steps.map((start, i) => i).filter((i) => steps[i] > nowMs && steps[i] < nowMs + hours * HOUR);
}

// ---------- numbers over some steps ----------
export function peakOf(column, indexes) {
  let best = null;
  for (const i of indexes) {
    const value = column?.[i];
    if (present(value) && (best === null || value > best.value)) best = { value, index: i };
  }
  return best;
}

export function lowOf(column, indexes) {
  let best = null;
  for (const i of indexes) {
    const value = column?.[i];
    if (present(value) && (best === null || value < best.value)) best = { value, index: i };
  }
  return best;
}

// total is null when no step has a value; partial says some steps had none, so the total is a lower bound.
export function sumOf(column, indexes) {
  const values = indexes.map((i) => column?.[i]).filter(present);
  return { total: values.length ? values.reduce((a, b) => a + b, 0) : null, partial: values.length < indexes.length };
}

// ---------- classes ----------
// 0 = below the caution line, 1..4 = Caution, Extreme caution, Danger, Extreme danger (NWS edges, as the map legend uses).
export function heatCategory(heatIndex) {
  if (!present(heatIndex)) return null;
  return heatIndexCategories.reduce((level, category, i) => (heatIndex >= category.from ? i + 1 : level), 0);
}

// Per 3 hours, on the same lines as the alert rules (7.5 mm moderate, 23 mm heavy, 50 mm very heavy).
export function rainClass(mm) {
  if (!present(mm)) return null;
  const levels = hazardRules.HEAVY_RAIN.levels;
  if (mm < 0.1) return 'none';
  if (mm >= levels[3].rain3hMm) return 'very_heavy';
  if (mm >= levels[2].rain3hMm) return 'heavy';
  if (mm >= levels[1].rain3hMm) return 'moderate';
  return 'light';
}

export function gustClass(kph) {
  if (!present(kph)) return null;
  const lines = hazardRules.STRONG_WIND.gustKph;
  if (kph >= lines[3]) return 'severe';
  if (kph >= lines[2]) return 'very_strong';
  if (kph >= lines[1]) return 'strong';
  if (kph >= 30) return 'brisk';
  return 'light';
}

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassIndex = (degrees) => (present(degrees) ? Math.round((((degrees % 360) + 360) % 360) / 45) % 8 : null);

// WMO 95-99: the model itself forecasts a thunderstorm (96 and 99 with hail).
export const isThunderCode = (code) => present(code) && code >= 95;
export const hasHailCode = (code) => code === 96 || code === 99;

// ---------- days ----------
// One row per Bangladesh calendar day from today on, built from the 3-hour steps. A day needs at least four steps (half a day) to be listed.
export function dailySummaries(forecast, { maxDays = 5 } = {}) {
  const today = dhakaDate(new Date(forecast.nowMs));
  const days = new Map();
  forecast.steps.forEach((start, i) => {
    const date = dhakaDate(new Date(start));
    if (date < today) return;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(i);
  });

  const { cols, rain, thunder } = forecast;
  const rows = [];
  for (const [date, indexes] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    if (indexes.length < 4) continue;
    rows.push({
      date,
      startMs: forecast.steps[indexes[0]],
      low: lowOf(cols.temp, indexes)?.value ?? null,
      high: peakOf(cols.temp, indexes)?.value ?? null,
      rain: sumOf(rain.values, indexes),
      gust: peakOf(cols.wg, indexes)?.value ?? null,
      thunder: thunder.values ? (peakOf(thunder.values, indexes)?.value ?? null) : null,
      pop: peakOf(cols.pop, indexes)?.value ?? null,
    });
    if (rows.length >= maxDays) break;
  }
  return rows;
}

// ---------- freshness ----------
// 'ok' | 'stale' | 'unavailable' | 'not-checked', and when the data was last updated (the source's own time, else when we last checked).
export function freshnessOf(info) {
  const status = info?.status ?? 'not-checked';
  const stamp = info?.dataTime ?? info?.checkedAt ?? null;
  const updatedMs = stamp ? Date.parse(stamp) : null;
  return { status, updatedMs: Number.isFinite(updatedMs) ? updatedMs : null };
}

// ---------- lightning (what was recorded, as opposed to the thunder forecast) ----------
// Collapses candidate checks into the one most worth showing: the most recent. Each candidate is
// { kind: 'reported'|'none'|'stale'|'unavailable'|'not-checked', sampledMs, count, radiusKm, source }.
export function chooseLightning(candidates) {
  const real = candidates.filter(Boolean);
  if (!real.length) return null;
  const checked = real.filter((item) => item.kind !== 'not-checked' && Number.isFinite(item.sampledMs));
  if (checked.length) return checked.sort((a, b) => b.sampledMs - a.sampledMs)[0];
  return real.find((item) => item.kind === 'unavailable') ?? real[0];
}
