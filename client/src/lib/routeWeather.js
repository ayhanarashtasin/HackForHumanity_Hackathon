import { resolveSelection } from './series.js';
import { STEP_MS, stepIndexAt, toMs } from './time.js';

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
  if (item.stops?.length) return item.stops[0].point;
  if (index === 0) return coordinates?.[0];
  if (index === total - 1) return coordinates?.at(-1);
  return item.point ?? item.stops?.[0]?.point;
}
