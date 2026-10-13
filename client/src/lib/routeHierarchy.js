import { stepIndexAt } from './time.js';
import { distanceKm } from './geometry.js';

// Keep travel order, including a later return to the same region. A route is a sequence, not a set of districts.
export function routeRegions(stops, catalogue, level) {
  const locations = new Map(catalogue.locations.map((item) => [item.pcode, item]));
  const districts = new Map(catalogue.districts.map((item) => [item.pcode, item]));
  const groups = [];

  for (const stop of stops) {
    const location = locations.get(stop.id) ?? locations.get(catalogue.polygons[stop.polygonPid]?.src[0]);
    const district = districts.get(location?.district);
    if (!district) continue;
    const id = level === 'division' ? district.division : district.pcode;
    const name = level === 'division' ? district.division : district.name;
    const nameBn = level === 'division' ? null : district.nameBn;
    let group = groups.at(-1);
    if (group?.id !== id) {
      group = { id, name, nameBn, progress: stop.progress, stops: [], children: [] };
      groups.push(group);
    }
    group.stops.push(stop);
    const child = level === 'division' ? district : stop;
    if (!group.children.some((item) => item.id === child.pcode || item.id === child.id)) {
      group.children.push({ id: child.pcode ?? child.id, name: child.name, nameBn: child.nameBn });
    }
  }
  return groups;
}

// District summaries already cover every upazila in that district. A division combines all its available district summaries,
// not just the towns the road passes through. Temperature is averaged; heat, rain and wind retain the highest local forecast.
export function regionWeather(group, level, snapshot, catalogue, arrivalMs) {
  const empty = { temp: null, hi: null, rf: null, wg: null, ts: null };
  if (!snapshot?.steps?.length) return empty;
  const index = stepIndexAt(snapshot.steps, arrivalMs);
  const districts = level === 'division'
    ? catalogue.districts.filter((district) => district.division === group.id).map((district) => snapshot.districts?.[district.pcode])
    : [snapshot.districts?.[group.id]];
  const values = (key) => districts.map((district) => district?.[key]?.[index]).filter(Number.isFinite);
  const average = (numbers) => numbers.length ? numbers.reduce((sum, number) => sum + number, 0) / numbers.length : null;
  const peak = (numbers) => numbers.length ? Math.max(...numbers) : null;
  return {
    temp: average(values('temp')),
    hi: peak(values('hiMax')),
    rf: peak(values('rfMax')),
    wg: peak(values('wgMax')),
    ts: snapshot.thunderSource ? peak(values('ts')) : null,
  };
}

// Lightning observations cover search radii, not administrative boundaries. Only attach samples to matched route stops.
export function routeLightning(stops, summaries) {
  if (!summaries) return null;
  const matches = (item, stop) => (
    summaries.mode === 'A'
      ? item.kind === 'upazila' && item.id === stop.polygonPid
      : item.kind === 'circle' && stop.point && distanceKm(stop.point[1], stop.point[0], item.lat, item.lon) <= item.radiusKm
  );
  const items = (summaries.items ?? []).filter((item) => stops.some((stop) => matches(item, stop)));
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const reported = unique.filter((item) => item.state === 'reported');
  return {
    items: unique,
    state: !unique.length ? 'no-coverage' : reported.length ? 'reported'
      : stops.every((stop) => unique.some((item) => matches(item, stop))) && unique.every((item) => item.state === 'none') ? 'none' : 'incomplete',
    reported: reported.length,
  };
}
