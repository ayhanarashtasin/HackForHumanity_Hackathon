import { env } from '../../config/env.js';
import { getSourceData, statusOf } from '../weatherStore.js';
import { locationByPcode } from '../geo.js';

// Stage 0 of the pipeline: take the cached provider data and turn it into one internal shape per area.
// Nothing downstream sees provider field names. `null` always means "not provided", never zero.
const HOUR = 3_600_000;
const STEP_HOURS = 3;

// The map's source statuses use ok / stale / unavailable / not-checked; the alert engine uses the shared five-status vocabulary.
export function toDataStatus(status) {
  if (status === 'ok') return 'FRESH';
  if (status === 'stale') return 'STALE';
  return 'UNAVAILABLE';
}

const parseTime = (iso) => Date.parse(iso);

// Reads the shared caches. `sources` can be injected (tests, admin dry runs); by default it is the live weatherStore.
export function loadSources(now = Date.now()) {
  const read = (name) => {
    const info = statusOf(name, now);
    return {
      name,
      data: getSourceData(name),
      status: toDataStatus(info.status),
      dataTime: info.dataTime,
      checkedAt: info.checkedAt,
      message: info.message,
    };
  };
  return { bmd: read('bmd'), openMeteo: read('openMeteo') };
}

function column(source, pcode, key) {
  return source?.data?.locations?.[pcode]?.[key] ?? null;
}

// 3-hourly periods { startMs, endMs, value } for one column of one source. Steps are Bangladesh-time ISO strings.
export function stepSeries(source, pcode, key) {
  const values = column(source, pcode, key);
  const steps = source?.data?.steps;
  if (!values || !steps) return [];
  return steps.map((step, i) => ({
    startMs: parseTime(step),
    endMs: parseTime(step) + STEP_HOURS * HOUR,
    value: values[i] ?? null,
  }));
}

export function buildAreaForecast(pcode, { now = Date.now(), sources = loadSources(now), xweather = null } = {}) {
  const location = locationByPcode.get(pcode);
  if (!location) return null;

  const { bmd, openMeteo } = sources;
  const hasBmd = Boolean(bmd?.data?.locations?.[pcode]);
  const hasOpenMeteo = Boolean(openMeteo?.data?.locations?.[pcode]);

  const providers = [];
  const addProvider = (provider, product, status, extra = {}) => providers.push({ provider, product, status, ...extra });

  // ----- rain -----
  const rain = [];
  if (xweather?.hourly?.length) {
    rain.push({
      provider: 'xweather', product: 'forecast-1hr', status: xweather.status, unitVerified: true,
      periods: xweather.hourly.map((p) => ({ startMs: p.startMs, endMs: p.endMs, mm: p.precipMM, pop: p.pop })),
    });
  }
  if (hasOpenMeteo) {
    const amount = stepSeries(openMeteo, pcode, 'rf');
    const pop = stepSeries(openMeteo, pcode, 'pop');
    rain.push({
      provider: 'open-meteo', product: 'forecast-3h', status: openMeteo.status, unitVerified: true,
      periods: amount.map((p, i) => ({ startMs: p.startMs, endMs: p.endMs, mm: p.value, pop: pop[i]?.value ?? null })),
    });
  }
  if (hasBmd) {
    rain.push({
      provider: 'bmd', product: 'wrf-3h', status: bmd.status, unitVerified: env.alerts.bmdRainVerified,
      periods: stepSeries(bmd, pcode, 'rf').map((p) => ({ startMs: p.startMs, endMs: p.endMs, mm: p.value, pop: null })),
    });
  }

  // ----- heat: WBGT when a provider supplies it, otherwise the computed heat index (BMD, then Open-Meteo) -----
  const heat = [];
  if (xweather?.hourly?.some((p) => p.wbgtC !== null)) {
    heat.push({
      provider: 'xweather', product: 'forecast-1hr', indicator: 'wbgt', status: xweather.status,
      periods: xweather.hourly.map((p) => ({ startMs: p.startMs, endMs: p.endMs, value: p.wbgtC })),
    });
  }
  if (hasBmd) heat.push({ provider: 'bmd', product: 'wrf-3h', indicator: 'heat_index', status: bmd.status, periods: stepSeries(bmd, pcode, 'hi') });
  if (hasOpenMeteo) heat.push({ provider: 'open-meteo', product: 'forecast-3h', indicator: 'heat_index', status: openMeteo.status, periods: stepSeries(openMeteo, pcode, 'hi') });

  // Air temperature is recorded as evidence (BMD heat-wave classes), never used for a severity.
  const airTemp = hasBmd ? stepSeries(bmd, pcode, 'temp') : (hasOpenMeteo ? stepSeries(openMeteo, pcode, 'temp') : []);

  // ----- wind gusts: BMD primary, Open-Meteo second opinion, Xweather when present -----
  const gust = [];
  if (hasBmd) gust.push({ provider: 'bmd', product: 'wrf-3h', status: bmd.status, periods: stepSeries(bmd, pcode, 'wg') });
  if (hasOpenMeteo) gust.push({ provider: 'open-meteo', product: 'forecast-3h', status: openMeteo.status, periods: stepSeries(openMeteo, pcode, 'wg') });
  if (xweather?.hourly?.length) {
    gust.push({
      provider: 'xweather', product: 'forecast-1hr', status: xweather.status,
      periods: xweather.hourly.map((p) => ({ startMs: p.startMs, endMs: p.endMs, value: p.windGustKph })),
    });
  }

  // ----- thunderstorm potential (a sign of risk, not a prediction of strikes) -----
  const thunder = hasOpenMeteo ? stepSeries(openMeteo, pcode, 'ts') : [];

  // ----- daily rain and maximum temperature for the dry-spell rule (BMD daily values) -----
  const daily = bmd?.data?.daily;
  const dailyLocation = daily?.locations?.[pcode];
  const dailySeries = hasBmd && dailyLocation
    ? {
      provider: 'bmd', product: 'wrf-daily', status: bmd.status, rainUnitVerified: env.alerts.bmdRainVerified,
      days: daily.days.map((day, i) => ({ startMs: parseTime(day), rainMm: dailyLocation.rf?.[i] ?? null, tmaxC: dailyLocation.tmax?.[i] ?? null })),
    }
    : null;

  for (const [name, source, has] of [['bmd', bmd, hasBmd], ['open-meteo', openMeteo, hasOpenMeteo]]) {
    addProvider(name, null, has ? source.status : 'UNAVAILABLE', { checkedAt: source?.checkedAt ?? null, dataTime: source?.dataTime ?? null });
  }
  if (xweather) addProvider('xweather', 'forecast-1hr', xweather.status, { checkedAt: xweather.fetchedAt ?? null, dataTime: xweather.issuedAt ?? null });

  return {
    pcode,
    name: location.name,
    nameBn: location.nameBn ?? null,
    districtPcode: location.district,
    lat: location.lat,
    lon: location.lon,
    kind: location.kind,
    generatedAt: now,
    rain,
    heat,
    airTemp,
    gust,
    thunder,
    daily: dailySeries,
    providers,
  };
}

// Periods that overlap [fromMs, toMs).
export function inWindow(periods, fromMs, toMs) {
  return periods.filter((period) => period.endMs > fromMs && period.startMs < toMs);
}

