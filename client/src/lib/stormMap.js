import { circlePolygon, destinationPoint } from './geometry.js';
import { formatClock } from './time.js';

// Storm movement on the map (WeatherMap.setStorms), kept pure so it is tested without a map.
export const STORM_STEPS = [30, 60, 90];
export const STORM_LABEL_CELLS = 8;
// The upazilas a storm warning applies to are drawn in the WARNING amber of the alert ramp (docs/design.md): they are the same places.
export const STORM_WARNING_COLOR = '#F2A03D';
export const STORM_COLORS = { 4: '#E9B949', 5: '#E0703A', 6: '#B8322A' };
export const STORM_INTENSITY = { 4: 'Strong', 5: 'Severe', 6: 'Extreme' };

// Canvas text stays in English like every other map label.
const clock = (ms) => formatClock(ms, 'en');

// Arrivals (server: stormOutlook.stormArrivals) -> Map(upazila polygon pid -> 1 within 30 minutes | 2 within the hour). A polygon
// stands for one or more BMD locations (polygon.src); the soonest of them decides.
export function arrivalTiers(arrivals = [], polygons = {}) {
  const tierByPcode = new Map(arrivals.map((arrival) => [arrival.pcode, arrival.soon ? 1 : 2]));
  const tiers = new Map();
  for (const [pid, polygon] of Object.entries(polygons)) {
    let tier = 0;
    for (const pcode of polygon.src ?? []) {
      const own = tierByPcode.get(pcode);
      if (own && (!tier || own < tier)) tier = own;
    }
    if (tier) tiers.set(pid, tier);
  }
  return tiers;
}

// GeoJSON features for the storm layers: each cell's outline; for a moving cell its 30, 60 and 90-minute circles, a dot on each with
// the clock time it may be there, the track and an arrow; speed labels on the biggest cells; and the expected arrival time beside every
// upazila a storm warning applies to.
export function stormFeatures(snapshot, locationByPcode = new Map()) {
  const features = [];
  const feature = (geometry, properties) => features.push({ type: 'Feature', geometry, properties });
  const observedMs = snapshot?.observedAt ? Date.parse(snapshot.observedAt) : null;

  for (const [index, cell] of (snapshot?.cells ?? []).entries()) {
    const props = { id: cell.id, intensity: cell.intensity };
    const labelled = index < STORM_LABEL_CELLS && Boolean(cell.motion);
    if (cell.polygon?.length > 3) feature({ type: 'Polygon', coordinates: [cell.polygon] }, { ...props, kind: 'cell' });

    const steps = cell.motion ? (cell.forecast ?? []).filter((step) => STORM_STEPS.includes(step.minutes)) : [];
    if (steps.length) {
      for (const step of steps) {
        feature({ type: 'Polygon', coordinates: circlePolygon(step.lat, step.lon, step.radiusKm) }, { ...props, kind: 'ring', minutes: step.minutes });
        const label = labelled && observedMs !== null ? clock(observedMs + step.minutes * 60_000) : '';
        feature({ type: 'Point', coordinates: [step.lon, step.lat] }, { ...props, kind: 'step', minutes: step.minutes, label });
      }
      const last = steps.at(-1);
      feature({ type: 'LineString', coordinates: [[cell.center.lon, cell.center.lat], ...steps.map((step) => [step.lon, step.lat])] }, { ...props, kind: 'track' });
      const { bearingDeg } = cell.motion;
      const head = [destinationPoint(last.lat, last.lon, bearingDeg, 7), destinationPoint(last.lat, last.lon, bearingDeg + 140, 6), destinationPoint(last.lat, last.lon, bearingDeg - 140, 6)];
      feature({ type: 'Polygon', coordinates: [[...head, head[0]]] }, { ...props, kind: 'arrow' });
    }
    if (labelled) {
      feature({ type: 'Point', coordinates: [cell.center.lon, cell.center.lat] }, { ...props, kind: 'label', label: `${Math.round(cell.motion.speedKmh)} km/h ${cell.motion.towards}` });
    }
  }

  // "Ramu 4:40pm": a time alone beside a dot does not say which place it is for.
  for (const arrival of snapshot?.arrivals ?? []) {
    const location = locationByPcode.get(arrival.pcode);
    if (!location) continue;
    const label = [location.name, clock(Date.parse(arrival.arrivalAt))].filter(Boolean).join(' ');
    feature({ type: 'Point', coordinates: [location.lon, location.lat] }, { id: arrival.pcode, kind: 'arrival', soon: Boolean(arrival.soon), label });
  }
  return features;
}
