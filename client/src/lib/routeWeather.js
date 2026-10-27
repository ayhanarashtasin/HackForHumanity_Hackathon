import { resolveSelection } from './series.js';
import { STEP_MS, stepIndexAt, toMs } from './time.js';

const EARTH_KM = 6371;
const toRad = (value) => (value * Math.PI) / 180;
function kmBetween(a, b) {
  const h = Math.sin(toRad(b[1] - a[1]) / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// A lighter copy of a road for the hospital search: ~1 m rounding and no point closer than `minKm` to the last one kept (both ends always
// kept). The server measures every 500 m, so nothing it uses is lost; a 250 km trip goes from ~50 kB to well under the request limit.
// Mirrors server/src/services/hospitals.js compactRoute, which the Telegram bot uses, so both search the same road and list the same hospitals.
export function compactRoute(coordinates, minKm = 0.1) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return coordinates ?? [];
  const round = ([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
  const kept = [round(coordinates[0])];
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    if (kmBetween(kept.at(-1), coordinates[index]) >= minKm) kept.push(round(coordinates[index]));
  }
  kept.push(round(coordinates.at(-1)));
  return kept;
}

// A hospital's name and place line in the page language when OpenStreetMap has it in that language, else the name as mapped (never
// translated). Mirrors server/src/services/hospitals.js hospitalLabels, so the website and Telegram agree.
export function hospitalLabels(hospital, lang) {
  const name = lang === 'bn' ? hospital.nameBn || hospital.nameEn || hospital.name : hospital.nameEn || hospital.nameBn || hospital.name;
  const area = lang === 'bn' ? hospital.areaBn || hospital.area : hospital.area || hospital.areaBn;
  return { name: name || null, area: area || null };
}

// Do not silently reuse the first/last forecast outside its published window.
export function routeForecastIndex(steps, arrivalMs) {
  if (!steps?.length || !Number.isFinite(arrivalMs) || !Number.isFinite(toMs(steps[0])) || !Number.isFinite(toMs(steps.at(-1))) || arrivalMs < toMs(steps[0]) || arrivalMs >= toMs(steps.at(-1)) + STEP_MS) return -1;
  return stepIndexAt(steps, arrivalMs);
}

export function routeForecastStatus(snapshot) {
  if (!snapshot?.steps?.length) return 'unavailable';
  const base = snapshot.base === 'open-meteo' ? 'openMeteo' : 'bmd';
  return snapshot.sources?.[base]?.status === 'ok' && snapshot.thunderSource && snapshot.sources?.openMeteo?.status === 'ok' ? 'ok' : 'partial';
}

export function stopWeather(parent, routeData, snapshot, catalogue, lang) {
  const resolved = resolveSelection({ level: parent.level ?? 'polygon', id: parent.id }, snapshot, catalogue, lang);
  const arrivalMs = routeData.places.checkedAt + routeData.result.durationMinutes * 60_000 * parent.progress;
  const index = routeForecastIndex(snapshot?.steps, arrivalMs);
  const at = (key) => index >= 0 ? resolved?.series?.[key]?.[index] ?? null : null;
  return { arrivalMs, temp: at('temp'), hi: at('hi'), rf: at('rf'), wg: at('wg'), ts: snapshot?.thunderSource ? at('ts') : null };
}

// Geometry/ETAs stay fixed; refresh the samples and summary from the shared forecast cache, without another OSRM request.
export function refreshRouteWeather(route, snapshot) {
  if (!route || !snapshot) return route;
  const samples = (route.samples ?? []).map((sample) => {
    const index = routeForecastIndex(snapshot.steps, sample.etaMs);
    const series = snapshot.locations?.[sample.place?.id];
    const at = key => index >= 0 && Number.isFinite(series?.[key]?.[index]) ? series[key][index] : null;
    return { ...sample, temperatureC: at('temp'), heatIndexC: at('hi'), rainMm: at('rf'), rainChancePct: at('pop'), windKph: at('wg'), thunderPotential: snapshot.thunderSource ? at('ts') : null };
  });
  const peak = key => {
    const values = samples.map(sample => sample[key]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const coveredCount = samples.filter(sample => Number.isFinite(sample.temperatureC)).length;
  return { ...route, samples, summary: {
    ...route.summary,
    sampleCount: samples.length, coveredCount,
    rainUnitUnverified: snapshot.base === 'bmd',
    maxTemperatureC: peak('temperatureC'), maxHeatIndexC: peak('heatIndexC'), maxRainMm: peak('rainMm'),
    maxRainChancePct: peak('rainChancePct'), maxWindKph: peak('windKph'), maxThunderPotential: peak('thunderPotential'),
    forecastStatus: !coveredCount ? 'unavailable' : coveredCount < samples.length || routeForecastStatus(snapshot) !== 'ok' ? 'partial' : 'ok',
  } };
}

// A displayed region is anchored to the road's entry point, never the region's distant centre.
export function routeMapPoint(item, index, total, coordinates) {
  // The trip starts where the road starts: the first stop sits on it, not on the chosen place's own point, which can be kilometres off
  // the road (a district's coordinates, a point away from any road) and drifts away from the line as the map is zoomed in.
  if (index === 0 && coordinates?.length) return coordinates[0];
  if (item.stops?.length) return item.stops[0].point;
  if (index === 0) return coordinates?.[0];
  if (index === total - 1) return coordinates?.at(-1);
  return item.point ?? item.stops?.[0]?.point;
}
