import { locations } from './geo.js';
import { forecastFor, loadForecast, stepIndex } from './delivery/botReports/readings.js';

const BOUNDS = { minLat: 20.3, maxLat: 26.9, minLon: 87.5, maxLon: 93.2 };
const MAX_SAMPLES = 16;
const EARTH_KM = 6371;
const ROUTING_SERVICE_URL = 'https://router.project-osrm.org/route/v1/driving';

const radians = (value) => (value * Math.PI) / 180;

function distanceKm(a, b) {
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const dLat = lat2 - lat1;
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
    && point.lat >= BOUNDS.minLat && point.lat <= BOUNDS.maxLat
    && point.lon >= BOUNDS.minLon && point.lon <= BOUNDS.maxLon;
}

function routeSamples(coordinates) {
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    total += distanceKm(coordinates[index - 1], coordinates[index]);
    lengths.push(total);
  }
  if (!total) return [];
  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(total / 30) + 1));
  const points = [];
  for (let sample = 0; sample < count; sample += 1) {
    const target = total * sample / (count - 1);
    let segment = lengths.findIndex((length) => length >= target);
    if (segment < 0) segment = lengths.length - 1;
    const startDistance = segment ? lengths[segment - 1] : 0;
    const segmentDistance = lengths[segment] - startDistance;
    const fraction = segmentDistance ? (target - startDistance) / segmentDistance : 0;
    const start = coordinates[segment];
    const end = coordinates[segment + 1];
    points.push({
      coordinates: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction],
      progress: target / total,
    });
  }
  return points;
}

function closestLocation(point, catalog) {
  let closest = null;
  let shortest = Infinity;
  for (const location of catalog) {
    const distance = distanceKm(point, [location.lon, location.lat]);
    if (distance < shortest) { closest = location; shortest = distance; }
  }
  if (!closest || shortest > 75) return null;
  return { location: closest, distanceKm: shortest };
}

function at(values, index) {
  return Number.isInteger(index) && index >= 0 && Number.isFinite(values?.[index]) ? values[index] : null;
}

function maxOf(samples, key) {
  const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

async function fetchRoadRoute(start, end, fetchImpl) {
  const coordinates = `${start.lon},${start.lat};${end.lon},${end.lat}`;
  const url = `${ROUTING_SERVICE_URL}/${coordinates}?overview=full&geometries=geojson&steps=false`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Route service is unavailable. Please try again.');
  const payload = await response.json();
  const route = payload.code === 'Ok' ? payload.routes?.[0] : null;
  if (!route?.geometry?.coordinates?.length || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) {
    throw new Error('No road route was found between those locations.');
  }
  return route;
}

export async function buildRouteWeather({
  start, end, nowMs = Date.now(), fetchImpl = fetch, forecast = loadForecast({ now: nowMs }), locationList = locations,
}) {
  if (!validPoint(start) || !validPoint(end)) throw new Error('Choose two locations in Bangladesh.');
  if (start.lat === end.lat && start.lon === end.lon) throw new Error('Start and end locations must be different.');

  const route = await fetchRoadRoute(start, end, fetchImpl);
  const points = routeSamples(route.geometry.coordinates);
  const samples = points.map(({ coordinates, progress }) => {
    const nearest = closestLocation(coordinates, locationList);
    if (!nearest) return { lat: coordinates[1], lon: coordinates[0], place: null, distanceKm: null, etaMs: null };

    const place = {
      id: nearest.location.pcode,
      level: 'location',
      kind: nearest.location.kind === 'thana' ? 'thana' : 'upazila',
      name: nearest.location.name,
      nameBn: nearest.location.nameBn ?? null,
      districtCode: nearest.location.district,
      members: [nearest.location.pcode],
      lat: nearest.location.lat,
      lon: nearest.location.lon,
    };
    const etaMs = nowMs + route.duration * 1000 * progress;
    const local = forecastFor(place, forecast);
    const index = local.available ? stepIndex(local.steps, etaMs) : -1;
    const sourceStatuses = [local.coreInfo?.status, local.rain?.info?.status, local.thunder?.info?.status].filter(Boolean);
    return {
      lat: coordinates[1], lon: coordinates[0], place, distanceKm: nearest.distanceKm, etaMs,
      dataStatus: local.available ? (sourceStatuses.every((status) => status === 'ok') ? 'ok' : 'partial') : 'unavailable',
      temperatureC: at(local.cols?.temp, index),
      heatIndexC: at(local.cols?.hi, index),
      rainMm: at(local.rain?.values, index),
      rainUnitUnverified: Boolean(local.rain?.unverified),
      rainChancePct: at(local.cols?.pop, index),
      windKph: at(local.cols?.wg, index),
      thunderPotential: at(local.thunder?.values, index),
    };
  });
  const available = samples.filter((sample) => sample.place && sample.temperatureC !== null);

  return {
    start: { name: String(start.name ?? ''), lat: start.lat, lon: start.lon },
    end: { name: String(end.name ?? ''), lat: end.lat, lon: end.lon },
    coordinates: route.geometry.coordinates,
    distanceKm: Math.round(route.distance / 100) / 10,
    durationMinutes: Math.round(route.duration / 60),
    samples,
    summary: {
      sampleCount: samples.length,
      coveredCount: available.length,
      maxTemperatureC: maxOf(available, 'temperatureC'),
      maxHeatIndexC: maxOf(available, 'heatIndexC'),
      maxRainMm: maxOf(available, 'rainMm'),
      rainUnitUnverified: available.some((sample) => sample.rainUnitUnverified),
      maxRainChancePct: maxOf(available, 'rainChancePct'),
      maxWindKph: maxOf(available, 'windKph'),
      maxThunderPotential: maxOf(available, 'thunderPotential'),
      forecastStatus: available.length ? (available.some((sample) => sample.dataStatus !== 'ok') ? 'partial' : 'ok') : 'unavailable',
    },
  };
}

export const routeWeatherInternals = { closestLocation, distanceKm, routeSamples, validPoint };