import { hazardRules } from '../../../config/alertRules.js';
import { heatIndexCategories } from '../../../config/thresholds.js';
import { districts } from '../../geo.js';
import { stormDataStatus, stormReach } from '../../stormOutlook.js';
import { placeById } from './places.js';
import {
  HOUR, STEP_MS, forecastFor, hasHailCode, isThunderCode, lowOf, peakOf, stepIndex, sumOf,
} from './readings.js';
import { weatherPlaceOf } from './routePlaces.js';

// What the /route reply says, as data (routeText.js words it): the trip in stops, the worst weather on the way and when, the destination
// after arrival, and, for a trip starting now, lightning checks, the satellite storm tracker and active alerts along the road. Everything
// is read from stored data; a missing forecast stays missing (level null) and is never shown as calm.
const MAX_STOPS = 8;
const MINUTE = 60_000;
const RAIN = hazardRules.HEAVY_RAIN.levels; // 3-hour mm: 1 moderate, 2 heavy, 3 very heavy
const GUST = hazardRules.STRONG_WIND.gustKph;
const HEAT = heatIndexCategories.map((category) => category.from); // caution, extreme caution, danger, extreme danger
const BRISK_GUST_KPH = 30; // readings.gustClass "brisk"
const LIGHT_RAIN_MM = 0.5;

const present = (value) => typeof value === 'number' && Number.isFinite(value);
const districtByCode = new Map(districts.map((district) => [district.pcode, district]));

// 0 calm, 1 watch, 2 caution, 3 severe; null without a forecast for that place and time.
export function sampleLevel(sample) {
  if (!sample?.place || !present(sample.temperatureC)) return null;
  let level = 0;
  const raise = (value) => { level = Math.max(level, value); };
  const {
    rainMm, windKph, thunderPotential, heatIndexC, weatherCode,
  } = sample;
  if (present(rainMm)) raise(rainMm >= RAIN[2].rain3hMm ? 3 : rainMm >= RAIN[1].rain3hMm ? 2 : rainMm >= LIGHT_RAIN_MM ? 1 : 0);
  if (present(windKph)) raise(windKph >= GUST[2] ? 3 : windKph >= GUST[1] ? 2 : windKph >= BRISK_GUST_KPH ? 1 : 0);
  if (present(thunderPotential)) raise(Math.min(Math.max(Math.round(thunderPotential), 0), 3));
  if (hasHailCode(weatherCode)) raise(3);
  else if (isThunderCode(weatherCode)) raise(2);
  if (present(heatIndexC)) raise(heatIndexC >= HEAT[3] ? 3 : heatIndexC >= HEAT[2] ? 2 : heatIndexC >= HEAT[1] ? 1 : 0);
  return level;
}

// ---------- the trip in stops ----------
// Consecutive samples in the same district make one stop; a trip inside one or two districts is shown by upazila/thana instead.
function runs(samples, keyOf) {
  const out = [];
  for (const sample of samples) {
    const key = keyOf(sample) ?? 'none';
    const last = out.at(-1);
    if (last?.key === key) last.samples.push(sample);
    else out.push({ key, samples: [sample] });
  }
  return out;
}

const maxOf = (samples, key) => {
  const values = samples.map((sample) => sample[key]).filter(present);
  return values.length ? Math.max(...values) : null;
};

function stopOf(group, byDistrict) {
  const known = group.samples.filter((sample) => sampleLevel(sample) !== null);
  const first = group.samples[0];
  const district = byDistrict ? districtByCode.get(group.key) : null;
  return {
    name: district?.name ?? first.place?.name ?? null,
    nameBn: district?.nameBn ?? first.place?.nameBn ?? null,
    // When the trip enters and leaves the stop: its figures are the worst over that time.
    etaMs: first.etaMs,
    untilMs: group.samples.at(-1).etaMs,
    place: (known[0] ?? first).place ?? null,
    level: known.length ? Math.max(...known.map(sampleLevel)) : null,
    temperatureC: maxOf(known, 'temperatureC'),
    heatIndexC: maxOf(known, 'heatIndexC'),
    rainMm: maxOf(known, 'rainMm'),
    rainChancePct: maxOf(known, 'rainChancePct'),
    windKph: maxOf(known, 'windKph'),
    thunderPotential: maxOf(known, 'thunderPotential'),
    weatherCode: maxOf(known, 'weatherCode'),
  };
}

export function routeStops(samples) {
  const byDistrict = runs(samples, (sample) => sample.place?.districtCode);
  const useDistricts = byDistrict.length > 2;
  return (useDistricts ? byDistrict : runs(samples, (sample) => sample.place?.id)).map((group) => stopOf(group, useDistricts));
}

// At most 8 lines: the first and last stop, and between them the roughest ones, kept in travel order.
export function pickStops(stops) {
  if (stops.length <= MAX_STOPS) return { shown: stops, hidden: 0 };
  const middle = stops.slice(1, -1)
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => ((b.stop.level ?? -1) - (a.stop.level ?? -1)) || (a.index - b.index))
    .slice(0, MAX_STOPS - 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.stop);
  return { shown: [stops[0], ...middle, stops.at(-1)], hidden: stops.length - MAX_STOPS };
}

// ---------- the worst weather on the way ----------
const WATCH = {
  thunder: (sample) => {
    const potential = sample.thunderPotential;
    if (!(potential >= 2) && !isThunderCode(sample.weatherCode)) return null;
    const hail = hasHailCode(sample.weatherCode);
    return { level: potential >= 3 || hail ? 3 : 2, value: present(potential) ? potential : 2, hail };
  },
  rain: (sample) => (sample.rainMm >= RAIN[1].rain3hMm ? { level: sample.rainMm >= RAIN[2].rain3hMm ? 3 : 2, value: sample.rainMm } : null),
  wind: (sample) => (sample.windKph >= GUST[1] ? { level: sample.windKph >= GUST[2] ? 3 : 2, value: sample.windKph } : null),
  heat: (sample) => (sample.heatIndexC >= HEAT[2] ? { level: sample.heatIndexC >= HEAT[3] ? 3 : 2, value: sample.heatIndexC } : null),
};

// One line per kind of hazard: where and when it is worst, and on how many other places of the road it also reaches that level.
export function watchList(samples) {
  const items = [];
  for (const [type, test] of Object.entries(WATCH)) {
    let worst = null;
    const places = new Set();
    for (const sample of samples) {
      if (sampleLevel(sample) === null) continue;
      const hit = test(sample);
      if (!hit) continue;
      places.add(sample.place.id);
      if (!worst || hit.value > worst.value) worst = { ...hit, sample };
    }
    if (worst) {
      items.push({
        type, level: worst.level, value: worst.value, hail: Boolean(worst.hail), place: worst.sample.place, etaMs: worst.sample.etaMs, otherPlaces: places.size - 1,
      });
    }
  }
  return items.sort((a, b) => (b.level - a.level) || (a.etaMs - b.etaMs));
}

// ---------- the destination ----------
function destinationOutlook(to, ctx, arriveMs) {
  const place = weatherPlaceOf(to);
  if (!place || !ctx) return null;
  const f = forecastFor(place, ctx);
  if (!f.available) return { place, available: false };
  const i = stepIndex(f.steps, arriveMs);
  const next = f.steps.map((start, k) => k).filter((k) => f.steps[k] + STEP_MS > arriveMs && f.steps[k] < arriveMs + 24 * HOUR);
  const codes = next.map((k) => f.cols.wmo?.[k]).filter(present);
  return {
    place,
    available: true,
    arrival: i >= 0 ? {
      weatherCode: f.cols.wmo?.[i] ?? null,
      temperatureC: f.cols.temp?.[i] ?? null,
      rainMm: f.rain.values?.[i] ?? null,
      rainChancePct: f.cols.pop?.[i] ?? null,
    } : null,
    next: next.length ? {
      low: lowOf(f.cols.temp, next)?.value ?? null,
      high: peakOf(f.cols.temp, next)?.value ?? null,
      rain: f.rain.values ? sumOf(f.rain.values, next) : { total: null, partial: true },
      rainChancePct: peakOf(f.cols.pop, next)?.value ?? null,
      thunderPotential: f.thunder.values ? (peakOf(f.thunder.values, next)?.value ?? null) : null,
      weatherCode: codes.length ? Math.max(...codes) : null,
    } : null,
    rainUnverified: Boolean(f.rain.unverified),
  };
}

// ---------- now-only extras: lightning, the storm tracker, active alerts ----------
async function lightningAlong(stops, lightningFor, nowMs) {
  const seen = new Set();
  const places = stops.map((stop) => stop.place).filter((place) => place && !seen.has(place.id) && seen.add(place.id));
  const results = await Promise.all(places.map((place) => lightningFor(place, { nowMs }).catch(() => ({ pick: null, error: true }))));
  return results.map((result, index) => ({ place: places[index], pick: result?.pick ?? null, error: Boolean(result?.error) }));
}

// The strong cell (as the storm-approach rule counts them) that meets the road nearest the time the trip passes: it reaches a place from
// half an hour after the trip passes to two hours before, or was already over a place the trip reaches within two hours.
async function stormAlong(samples, stormSnapshot, nowMs) {
  const snapshot = await stormSnapshot();
  const status = stormDataStatus(snapshot, nowMs);
  if (status !== 'FRESH') return { status, observedAtMs: snapshot?.observedAtMs ?? null, hit: null };
  const rules = hazardRules.STORM_APPROACH;
  const strong = (cell) => (cell.intensity ?? 0) >= rules.minIntensity && cell.trend !== 'weakening';
  const reach = stormReach(snapshot, samples.map((sample) => sample.place?.id).filter(Boolean), nowMs, strong);
  let hit = null;
  for (const sample of samples) {
    const found = sample.place ? reach.get(sample.place.id) : null;
    if (!found) continue;
    const passMs = sample.etaMs;
    const relevant = found.over
      ? passMs - nowMs <= 2 * HOUR
      : passMs >= found.arrivalMs - 30 * MINUTE && passMs <= found.arrivalMs + 2 * HOUR;
    if (relevant && (!hit || passMs < hit.passMs)) hit = { place: sample.place, arrivalMs: found.arrivalMs, passMs, over: found.over };
  }
  return { status, observedAtMs: snapshot.observedAtMs, hit };
}

async function hazardsAlong(samples, routeHazards, { fromMs, untilMs }) {
  const pcodes = [...new Set(samples.map((sample) => sample.place?.id).filter(Boolean))];
  const districtCodes = [...new Set(samples.map((sample) => sample.place?.districtCode).filter(Boolean))];
  const events = await routeHazards({ pcodes, districtCodes, fromMs, untilMs });
  const onRoute = new Set(pcodes);
  const inDistricts = new Set(districtCodes);
  const seen = new Set();
  const items = [];
  for (const event of events ?? []) {
    if (!(+new Date(event.validUntil) > fromMs)) continue;
    const pcode = (event.coverage?.upazilaPcodes ?? []).find((code) => onRoute.has(code));
    const district = pcode ? null : (event.coverage?.districtPcodes ?? []).find((code) => inDistricts.has(code));
    if (!pcode && !district) continue;
    const key = `${event.hazardType}|${pcode ?? district}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const area = pcode ? placeById(pcode) : districtByCode.get(district);
    items.push({
      type: event.hazardType, areaName: area?.name ?? null, areaNameBn: area?.nameBn ?? null, validUntilMs: +new Date(event.validUntil),
    });
  }
  return items;
}

// ---------- the other road ----------
function roughness(samples) {
  const levels = samples.map(sampleLevel).filter((level) => level !== null);
  return levels.length ? { worst: Math.max(...levels), rough: levels.filter((level) => level >= 2).length } : null;
}

function alternativeOf(route) {
  const other = route.alternatives?.[0];
  if (!other) return null;
  const mainDistricts = new Set((route.samples ?? []).map((sample) => sample.place?.districtCode).filter(Boolean));
  const via = (other.samples ?? []).find((sample) => sample.place?.districtCode && !mainDistricts.has(sample.place.districtCode));
  const mine = roughness(route.samples ?? []);
  const theirs = roughness(other.samples ?? []);
  return {
    distanceKm: other.distanceKm,
    durationMinutes: other.durationMinutes,
    via: via ? districtByCode.get(via.place.districtCode) ?? null : null,
    // -1 calmer than the main road, 0 about the same, 1 rougher; null when either has no forecast.
    comparison: mine && theirs ? Math.sign((theirs.worst - mine.worst) || (theirs.rough - mine.rough)) : null,
  };
}

// `route` is buildRouteWeather's result for a departure at `departMs`. `deps` may lack any of lightningFor, stormSnapshot and routeHazards:
// that part is then left out. Extras that read live observations are only gathered for a trip that starts now.
export async function buildRouteReport({
  route, from, to, departure = '0', departMs, nowMs, ctx, deps = {},
}) {
  const samples = route.samples ?? [];
  const arriveMs = departMs + route.durationMinutes * MINUTE;
  const stops = routeStops(samples);
  const { shown, hidden } = pickStops(stops);
  const startsNow = departure === '0';

  const [lightning, storm, hazards] = await Promise.all([
    startsNow && deps.lightningFor ? lightningAlong(shown, deps.lightningFor, nowMs).catch(() => null) : null,
    startsNow && deps.stormSnapshot ? stormAlong(samples, deps.stormSnapshot, nowMs).catch(() => ({ status: 'UNAVAILABLE', observedAtMs: null, hit: null })) : null,
    deps.routeHazards ? hazardsAlong(samples, deps.routeHazards, { fromMs: departMs, untilMs: arriveMs }).catch(() => null) : null,
  ]);

  const covered = samples.filter((sample) => sampleLevel(sample) !== null).length;
  return {
    from,
    to,
    departure,
    departMs,
    arriveMs,
    distanceKm: route.distanceKm,
    durationMinutes: route.durationMinutes,
    snap: route.snap ?? { startKm: null, endKm: null },
    stops: shown,
    hiddenStops: hidden,
    watch: watchList(samples),
    coverage: { covered, total: samples.length },
    destination: destinationOutlook(to, ctx, arriveMs),
    alternative: alternativeOf(route),
    lightning,
    storm,
    hazards,
    rainUnverified: Boolean(route.summary?.rainUnitUnverified),
    infos: ctx ? (ctx.base === 'bmd' ? [ctx.bmd?.info, ctx.openMeteo?.info] : [ctx.openMeteo?.info]) : [],
  };
}
