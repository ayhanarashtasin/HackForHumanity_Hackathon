import { env } from '../config/env.js';
import { aggregateDistricts } from './aggregate.js';
import { chunk, districts, pcodes } from './geo.js';
import { mapWithConcurrency, withRetry } from './http.js';
import { heatIndexC } from './heatIndex.js';

const SOURCE = 'BMDWRF';
// BMD rejects very long URLs: 250 PCODEs worked, 330 returned HTTP 400. 200 keeps a safe margin.
const CHUNK_SIZE = 200;
const CONCURRENCY = 2;
const STEP_PARAMS = ['temp', 'rf', 'rh', 'windspd', 'winddir', 'windgust', 'cldcvr'];
const STEP_COLUMNS = { temp: 'temp', rf: 'rf', rh: 'rh', windspd: 'ws', winddir: 'wd', windgust: 'wg', cldcvr: 'cc' };
const DAILY_PARAMS = ['temp', 'rf', 'rh', 'windspd', 'windgust'];
const DIGITS = { temp: 1, rf: 2, rh: 0, ws: 1, wd: 0, wg: 1, cc: 1, hi: 1 };

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

// The steps endpoint stores the nominal hour in the "minutes" field ("T00:06:00" = 06:00) and is documented as Bangladesh local time.
export function decodeStepTime(stepStart) {
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:(\d{2}):\d{2}$/.exec(stepStart);
  if (!match || Number(match[2]) > 23) throw new Error(`Unexpected BMD step time: ${stepStart}`);
  return `${match[1]}T${match[2]}:00:00+06:00`;
}

// The daily endpoint is documented as UTC (a day runs 00:00-24:00 UTC, i.e. 06:00-06:00 Bangladesh time).
export function decodeDayTime(stepStart) {
  const match = /^(\d{4}-\d{2}-\d{2})T00:00:00$/.exec(stepStart);
  if (!match) throw new Error(`Unexpected BMD daily time: ${stepStart}`);
  return `${match[1]}T00:00:00Z`;
}

function requestUrl(path, codes, params) {
  const query = new URLSearchParams({ SOURCE });
  for (const param of params) query.append('PARAM', param);
  for (const code of codes) query.append('PCODE', code);
  return `${env.weather.bmdApiUrl}/${path}?${query}`;
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 90_000 } = {}) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`BMD HTTP ${response.status}`);

  const json = await response.json().catch(() => {
    throw new Error('BMD returned a response that is not JSON.');
  });
  if (json.error) throw new Error(`BMD error: ${json.error}`);
  if (!json.data || typeof json.data !== 'object') throw new Error('BMD response contains no data.');
  return json;
}

async function fetchAll(path, params, options) {
  const groups = chunk(pcodes, CHUNK_SIZE);
  return mapWithConcurrency(groups, CONCURRENCY, (group) => withRetry(() => getJson(requestUrl(path, group, params), options)));
}

// A one-location, one-variable request used only to read the run's `updated_at` cheaply.
export async function probeUpdatedAt(options) {
  const json = await getJson(requestUrl('upazila_forecast_steps_recent', [pcodes[0]], ['rf']), options);
  return json.updated_at ?? null;
}

export function normalizeSteps(chunks) {
  const data = Object.assign({}, ...chunks.map((part) => part.data));
  const starts = new Set();
  for (const location of Object.values(data)) {
    for (const entry of location.forecast_data?.temp ?? []) starts.add(decodeStepTime(entry.step_start));
  }

  const steps = [...starts].sort();
  const indexByStart = new Map(steps.map((start, index) => [start, index]));
  const locations = {};

  for (const [pcode, location] of Object.entries(data)) {
    const columns = {};
    for (const [param, key] of Object.entries(STEP_COLUMNS)) {
      const values = new Array(steps.length).fill(null);
      for (const entry of location.forecast_data?.[param] ?? []) {
        const index = indexByStart.get(decodeStepTime(entry.step_start));
        if (index !== undefined && Number.isFinite(entry.val_avg)) values[index] = round(entry.val_avg, DIGITS[key]);
      }
      columns[key] = values;
    }
    columns.hi = columns.temp.map((temp, i) => {
      const value = temp !== null && columns.rh[i] !== null ? heatIndexC(temp, columns.rh[i]) : null;
      return value === null ? null : round(value, DIGITS.hi);
    });
    locations[pcode] = columns;
  }

  return {
    updatedAt: chunks[0]?.updated_at ?? null,
    steps,
    locations,
    missing: pcodes.filter((pcode) => !locations[pcode]),
  };
}

export function normalizeDaily(chunks) {
  const data = Object.assign({}, ...chunks.map((part) => part.data));
  const starts = new Set();
  for (const location of Object.values(data)) {
    for (const entry of location.forecast_data?.temp ?? []) starts.add(decodeDayTime(entry.step_start));
  }

  const days = [...starts].sort();
  const indexByStart = new Map(days.map((start, index) => [start, index]));
  const locations = {};

  for (const [pcode, location] of Object.entries(data)) {
    const column = (param, field, digits) => {
      const values = new Array(days.length).fill(null);
      for (const entry of location.forecast_data?.[param] ?? []) {
        const index = indexByStart.get(decodeDayTime(entry.step_start));
        if (index !== undefined && Number.isFinite(entry[field])) values[index] = round(entry[field], digits);
      }
      return values;
    };

    locations[pcode] = {
      tmin: column('temp', 'val_min', 1),
      tmax: column('temp', 'val_max', 1),
      rf: column('rf', 'val_avg', 2),
      rfMax: column('rf', 'val_max', 2),
      rh: column('rh', 'val_avg', 0),
      ws: column('windspd', 'val_avg', 1),
      wg: column('windgust', 'val_max', 1),
    };
  }

  return { days, locations };
}

// Full pull: 3 step requests + 3 daily requests for all 544 locations.
export async function fetchForecast(options = {}) {
  const stepChunks = await fetchAll('upazila_forecast_steps_recent', STEP_PARAMS, options);
  const dailyChunks = await fetchAll('upazila_forecast_recent', DAILY_PARAMS, options);

  const steps = normalizeSteps(stepChunks);
  if (!steps.steps.length || !Object.keys(steps.locations).length) throw new Error('BMD returned no forecast steps.');

  return {
    sourceUpdatedAt: steps.updatedAt,
    steps: steps.steps,
    locations: steps.locations,
    districts: aggregateDistricts(districts, steps.locations, steps.steps.length),
    missing: steps.missing,
    daily: normalizeDaily(dailyChunks),
  };
}
