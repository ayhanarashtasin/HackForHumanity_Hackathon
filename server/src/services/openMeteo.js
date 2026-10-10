import { env } from '../config/env.js';
import { thunderPotential } from '../config/thresholds.js';
import { aggregateDistricts, circularMeanDegrees } from './aggregate.js';
import { chunk, districts, locations } from './geo.js';
import { heatIndexC } from './heatIndex.js';
import { mapWithConcurrency, withRetry } from './http.js';

// Ten hourly variables = one billable call per location on the free tier.
const HOURLY = [
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'precipitation_probability', 'weather_code',
  'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cape',
];
const CHUNK_SIZE = 100;
const WINDOW_HOURS = 3;

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const present = (values) => values.filter((value) => value !== null && value !== undefined && Number.isFinite(value));
const mean = (values) => {
  const list = present(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
};
const maxOf = (values) => {
  const list = present(values);
  return list.length ? Math.max(...list) : null;
};
const sumOf = (values) => {
  const list = present(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) : null;
};

// Thunderstorm *potential* 0-3 for one hour. It is a risk sign, not a prediction of lightning strikes.
export function thunderLevel({ wmo, cape, pop }) {
  const rule = thunderPotential;
  if (wmo >= rule.thunderCodeFrom) return 3;
  if (cape >= rule.level3.cape && pop >= rule.level3.pop) return 3;
  if (cape >= rule.level2.cape && pop >= rule.level2.pop) return 2;
  if (rule.showerCodes.includes(wmo) && cape >= rule.showerCape) return 2;
  if (cape >= rule.level1.cape && pop >= rule.level1.pop) return 1;
  return 0;
}

// Aggregates one location's hourly series into 3-hour windows aligned to local hours 00, 03, 06, ... (the same grid BMD uses).
export function windowHourly(hourly) {
  const windows = new Map();

  hourly.time.forEach((time, index) => {
    const date = time.slice(0, 10);
    const hour = Number(time.slice(11, 13));
    const start = `${date}T${String(hour - (hour % WINDOW_HOURS)).padStart(2, '0')}:00:00+06:00`;
    if (!windows.has(start)) windows.set(start, []);
    windows.get(start).push(index);
  });

  const steps = [];
  const columns = { temp: [], rf: [], rh: [], ws: [], wd: [], wg: [], cc: [], hi: [], wmo: [], ts: [], pop: [], cape: [] };

  for (const [start, indexes] of [...windows].sort(([a], [b]) => a.localeCompare(b))) {
    const at = (key) => indexes.map((index) => hourly[key]?.[index] ?? null);
    const temp = mean(at('temperature_2m'));
    const rh = mean(at('relative_humidity_2m'));
    const hi = temp !== null && rh !== null ? heatIndexC(temp, rh) : null;
    const hourlyThunder = indexes.map((index) => thunderLevel({
      wmo: hourly.weather_code?.[index],
      cape: hourly.cape?.[index],
      pop: hourly.precipitation_probability?.[index],
    }));

    const wd = circularMeanDegrees(at('wind_direction_10m'));
    steps.push(start);
    columns.temp.push(temp === null ? null : round(temp, 1));
    columns.rf.push(sumOf(at('precipitation')) === null ? null : round(sumOf(at('precipitation')), 2));
    columns.rh.push(rh === null ? null : round(rh, 0));
    columns.ws.push(mean(at('wind_speed_10m')) === null ? null : round(mean(at('wind_speed_10m')), 1));
    columns.wd.push(wd === null ? null : round(wd, 0));
    columns.wg.push(maxOf(at('wind_gusts_10m')) === null ? null : round(maxOf(at('wind_gusts_10m')), 1));
    columns.cc.push(mean(at('cloud_cover')) === null ? null : round((mean(at('cloud_cover')) / 100) * 8, 1)); // % -> okta, matching BMD
    columns.hi.push(hi === null ? null : round(hi, 1));
    columns.wmo.push(maxOf(at('weather_code')));
    columns.ts.push(Math.max(...hourlyThunder));
    columns.pop.push(maxOf(at('precipitation_probability')));
    columns.cape.push(maxOf(at('cape')) === null ? null : round(maxOf(at('cape')), 0));
  }

  return { steps, columns };
}

async function fetchGroup(group, { fetchImpl = fetch, timeoutMs = 90_000 } = {}) {
  const query = new URLSearchParams({
    latitude: group.map((location) => location.lat.toFixed(3)).join(','),
    longitude: group.map((location) => location.lon.toFixed(3)).join(','),
    hourly: HOURLY.join(','),
    forecast_days: '4',
    timezone: 'Asia/Dhaka',
    wind_speed_unit: 'kmh',
  });

  const response = await fetchImpl(`${env.weather.openMeteoUrl}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);

  const json = await response.json().catch(() => {
    throw new Error('Open-Meteo returned a response that is not JSON.');
  });
  const results = Array.isArray(json) ? json : [json];
  if (results.length !== group.length || results.some((result) => result.error || !result.hourly?.time)) {
    throw new Error('Open-Meteo returned an unexpected response.');
  }
  return results;
}

export function normalizeResponses(pairs) {
  const stepSet = new Set();
  const byPcode = {};

  for (const { pcode, hourly } of pairs) {
    const { steps, columns } = windowHourly(hourly);
    steps.forEach((step) => stepSet.add(step));
    byPcode[pcode] = { steps, columns };
  }

  const steps = [...stepSet].sort();
  const indexByStep = new Map(steps.map((step, index) => [step, index]));
  const result = {};

  for (const [pcode, { steps: own, columns }] of Object.entries(byPcode)) {
    const aligned = {};
    for (const [key, values] of Object.entries(columns)) {
      const column = new Array(steps.length).fill(null);
      own.forEach((step, i) => { column[indexByStep.get(step)] = values[i]; });
      aligned[key] = column;
    }
    result[pcode] = aligned;
  }

  return { steps, locations: result };
}

// Fetches all 544 BMD locations. A failed group only drops its own locations; every group failing is an error.
export async function fetchOpenMeteo(options = {}) {
  const groups = chunk(locations, CHUNK_SIZE);
  const settled = await mapWithConcurrency(groups, 1, async (group) => {
    try {
      const results = await withRetry(() => fetchGroup(group, options), { attempts: 3, baseDelayMs: 4000 });
      return group.map((location, index) => ({ pcode: location.pcode, hourly: results[index].hourly }));
    } catch (error) {
      return { error };
    }
  });

  const pairs = settled.flatMap((entry) => (Array.isArray(entry) ? entry : []));
  if (!pairs.length) throw settled.find((entry) => entry.error)?.error ?? new Error('Open-Meteo returned no data.');

  const { steps, locations: byPcode } = normalizeResponses(pairs);
  return {
    steps,
    locations: byPcode,
    districts: aggregateDistricts(districts, byPcode, steps.length),
    missing: locations.map((location) => location.pcode).filter((pcode) => !byPcode[pcode]),
  };
}
