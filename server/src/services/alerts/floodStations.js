import { hazardRules } from '../../config/alertRules.js';
import { districts, locations } from '../geo.js';
import { haversineKm } from '../time.js';

// FFWC reports a gauge by district/upazila name, while every alert is matched by BMD/HDX pcode. This module joins the two and turns
// a gauge reading into the one classification the rest of the pipeline uses. A station that cannot be placed is reported, never guessed
// onto a random area: the API keeps it in an "unmatched" row for the operator.

const ALIASES = {
  bogra: 'bogura',
  chittagong: 'chattogram',
  comilla: 'cumilla',
  jessore: 'jashore',
  barisal: 'barishal',
  coxsbazar: 'coxsbazar',
  jhalokathi: 'jhalokati',
  khagrachari: 'khagrachhari',
  laxmipur: 'lakshmipur',
  maulvibazar: 'moulvibazar',
  munshigonj: 'munshiganj',
  kishorganj: 'kishoreganj',
  gopalgonj: 'gopalganj',
  narayangonj: 'narayanganj',
  netrokona: 'netrakona',
  chapainawabgonj: 'chapainababganj',
  chapainawabganj: 'chapainababganj',
  bbaria: 'brahmanbaria',
  brahmonbaria: 'brahmanbaria',
  brahmmonbaria: 'brahmanbaria',
  bbariasadar: 'brahmanbariasadar',
};

export function normaliseName(value) {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ALIASES[cleaned] ?? cleaned;
}

const districtByPcode = new Map(districts.map((district) => [district.pcode, district]));
const districtByName = new Map(districts.map((district) => [normaliseName(district.name), district]));
const upazilaByDistrictAndName = new Map(locations.map((location) => [`${location.district}|${normaliseName(location.name)}`, location]));
const upazilasByDistrict = new Map();
for (const location of locations) {
  if (!upazilasByDistrict.has(location.district)) upazilasByDistrict.set(location.district, []);
  upazilasByDistrict.get(location.district).push(location);
}

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// Exact upazila name first, then the nearest upazila of the same district (a gauge sits at a river point, not at a town hall), and only
// then the whole district. matchMethod is stored so the alert can be honest about how the gauge was placed.
export function matchStationArea(station) {
  const district = districtByName.get(normaliseName(station.district));
  if (!district) return null;

  const upazilaName = normaliseName(station.upazilla ?? station.upazila ?? station.upzila);
  if (upazilaName) {
    const exact = upazilaByDistrictAndName.get(`${district.pcode}|${upazilaName}`);
    if (exact) {
      return { scope: 'upazila', upazilaPcode: exact.pcode, districtPcode: district.pcode, name: exact.name, nameBn: exact.nameBn, lat: exact.lat, lon: exact.lon, distanceKm: 0, matchMethod: 'station_upazila_name' };
    }
  }

  const lat = finite(station.lat ?? station.latitude);
  const lon = finite(station.lon ?? station.longitude);
  if (lat !== null && lon !== null) {
    let nearest = null;
    for (const location of upazilasByDistrict.get(district.pcode) ?? []) {
      const distanceKm = haversineKm(lat, lon, location.lat, location.lon);
      if (!nearest || distanceKm < nearest.distanceKm) nearest = { location, distanceKm };
    }
    if (nearest && nearest.distanceKm <= 35) {
      return {
        scope: 'upazila',
        upazilaPcode: nearest.location.pcode,
        districtPcode: district.pcode,
        name: nearest.location.name,
        nameBn: nearest.location.nameBn,
        lat: nearest.location.lat,
        lon: nearest.location.lon,
        distanceKm: Math.round(nearest.distanceKm * 10) / 10,
        matchMethod: 'nearest_upazila_centroid',
      };
    }
  }

  return { scope: 'district', upazilaPcode: null, districtPcode: district.pcode, name: district.name, nameBn: district.nameBn, lat: district.lat, lon: district.lon, distanceKm: null, matchMethod: 'district_name' };
}

const round1 = (value) => Math.round(value * 10) / 10;

// NORMAL / APPROACHING / ABOVE / SIGNIFICANTLY_ABOVE, with the margin above/below the FFWC danger level in metres.
export function classifyWaterLevel(waterLevelM, dangerLevelM, rules = hazardRules.RIVER_FLOOD) {
  if (!Number.isFinite(waterLevelM) || !Number.isFinite(dangerLevelM) || dangerLevelM <= 0) {
    return { classification: 'UNAVAILABLE', level: 0, aboveDangerM: null };
  }
  const aboveDangerM = Math.round((waterLevelM - dangerLevelM) * 100) / 100;
  if (aboveDangerM >= rules.significantAboveM) return { classification: 'SIGNIFICANTLY_ABOVE', level: 3, aboveDangerM };
  if (aboveDangerM >= 0) return { classification: 'ABOVE', level: 2, aboveDangerM };
  if (aboveDangerM >= -rules.approachingBandM) return { classification: 'APPROACHING', level: 1, aboveDangerM };
  return { classification: 'NORMAL', level: 0, aboveDangerM };
}

function rainfallBySerial(observedRainfall) {
  const rows = Array.isArray(observedRainfall) ? observedRainfall : [];
  const bySerial = new Map();
  for (const row of rows) {
    const serial = finite(row.station_serial_no ?? row.serial_no ?? row.st_id ?? row.id);
    if (serial !== null) bySerial.set(serial, row);
    if (row.name) bySerial.set(`name:${normaliseName(row.name)}`, row);
  }
  return bySerial;
}

function recentRainfall(threeDayRainfall, serial) {
  const entry = threeDayRainfall?.[serial] ?? threeDayRainfall?.[String(serial)];
  if (!Array.isArray(entry) || !entry.length) return { rainfall24hMm: null, rainfall3dMm: null };
  const days = entry.map((item) => {
    const [date, amount] = Object.entries(item)[0] ?? [];
    const parsed = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date ?? ''));
    return { date, at: parsed ? Date.parse(`${parsed[3]}-${parsed[2]}-${parsed[1]}`) : Number.NaN, amount: finite(amount) };
  }).filter((item) => item.date && item.amount !== null)
    .sort((a, b) => (Number.isFinite(a.at) && Number.isFinite(b.at) ? a.at - b.at : 0));
  const last = days.at(-1);
  const last3 = days.slice(-3);
  return {
    rainfall24hMm: last ? round1(last.amount) : null,
    rainfall3dMm: last3.length ? round1(last3.reduce((sum, item) => sum + item.amount, 0)) : null,
  };
}

// The station registry has web_id (what `observed` calls st_id), while the rainfall endpoint is keyed by station_serial_no.
function registryIndex(stations) {
  const map = new Map();
  for (const row of Array.isArray(stations) ? stations : []) {
    const webId = finite(row.web_id ?? row.st_id?.replace?.(/\D/g, ''));
    if (webId !== null) map.set(webId, row);
    if (row.station) map.set(`name:${normaliseName(row.station)}`, row);
  }
  return map;
}

// One normalised row per usable gauge. `observed` is authoritative for the current level and danger level; the registry adds the
// verified spelling of the river and any missing danger level.
export function buildFloodReadings({ stations = [], observed = [], rainfall = [], threeDayRainfall = {} } = {}) {
  const registry = registryIndex(stations);
  const rainfallRows = rainfallBySerial(rainfall);
  const readings = [];
  const unmatched = [];

  for (const row of Array.isArray(observed) ? observed : []) {
    if (row.status !== undefined && Number(row.status) !== 1) continue;
    const waterLevelM = finite(row.waterlevel);
    const registryRow = registry.get(finite(row.st_id)) ?? registry.get(`name:${normaliseName(row.name)}`);
    const dangerLevelM = finite(row.dangerlevel) ?? finite(registryRow?.dl);
    if (waterLevelM === null || dangerLevelM === null) continue;

    const area = matchStationArea({
      ...row,
      district: row.district ?? registryRow?.district,
      upazilla: row.upazilla ?? registryRow?.upazilla,
      lat: row.lat ?? registryRow?.latitude,
      lon: row.long ?? registryRow?.longitude,
    });
    const serial = finite(row.station_serial_no ?? registryRow?.station_serial_no);
    const rain = rainfallRows.get(serial) ?? rainfallRows.get(`name:${normaliseName(row.name)}`) ?? null;
    const recent = recentRainfall(threeDayRainfall, serial);
    const classification = classifyWaterLevel(waterLevelM, dangerLevelM);
    const name = String(row.name ?? registryRow?.station ?? '').trim();
    const river = String(row.river ?? registryRow?.river ?? '').trim();
    const wlAt = row.wl_date ? new Date(row.wl_date) : null;

    const reading = {
      stationId: row.st_id ?? registryRow?.web_id ?? null,
      stationSerial: serial,
      stationName: name && name !== '0' ? name : `Gauge ${row.st_id ?? ''}`.trim(),
      river: river || null,
      waterLevelM: round1(waterLevelM),
      dangerLevelM: round1(dangerLevelM),
      highestWaterLevelM: finite(row.riverhighestwaterlevel) !== null ? round1(finite(row.riverhighestwaterlevel)) : null,
      ...classification,
      wlAt: wlAt && !Number.isNaN(+wlAt) ? wlAt.toISOString() : null,
      rainfallMonthMm: finite(rain?.total_rainfall) !== null ? round1(finite(rain?.total_rainfall)) : null,
      normalRainfallMm: finite(rain?.normal_rainfall) !== null ? round1(finite(rain?.normal_rainfall)) : null,
      maxRainfallMm: finite(rain?.max_rainfall) !== null ? round1(finite(rain?.max_rainfall)) : null,
      rainfall24hMm: recent.rainfall24hMm,
      rainfall3dMm: recent.rainfall3dMm,
      area,
      source: 'ffwc',
    };

    if (!area) {
      unmatched.push({ ...reading, district: row.district ?? null, upazila: row.upazilla ?? null });
      continue;
    }
    readings.push(reading);
  }

  return { readings, unmatched };
}

// One alert per upazila: several gauges on the same river can cross the line together, and nobody should receive one card per gauge.
// The highest reading leads; the others are kept as context. A district-wide group is only used where no upazila was matched.
export function groupFloodReadings(readings) {
  const groups = new Map();
  for (const reading of readings) {
    const key = `${reading.area.scope}:${reading.area.scope === 'upazila' ? reading.area.upazilaPcode : reading.area.districtPcode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        scope: reading.area.scope,
        upazilaPcode: reading.area.upazilaPcode,
        districtPcode: reading.area.districtPcode,
        name: reading.area.name,
        nameBn: reading.area.nameBn,
        lat: reading.area.lat,
        lon: reading.area.lon,
        matchMethod: reading.area.matchMethod,
        classification: reading.classification,
        level: reading.level,
        aboveDangerM: reading.aboveDangerM,
        lead: reading,
        stations: [],
      });
    }
    const group = groups.get(key);
    group.stations.push(reading);
    if (reading.level > group.level) {
      group.classification = reading.classification;
      group.level = reading.level;
      group.aboveDangerM = reading.aboveDangerM;
      group.lead = reading;
      group.matchMethod = reading.area.matchMethod;
    }
  }

  const upazilaDistricts = new Set([...groups.values()].filter((group) => group.scope === 'upazila').map((group) => group.districtPcode));
  return [...groups.values()]
    .filter((group) => group.scope === 'upazila' || !upazilaDistricts.has(group.districtPcode))
    .map((group) => ({ ...group, stations: group.stations.sort((a, b) => b.level - a.level || a.stationName.localeCompare(b.stationName)).slice(0, 3) }))
    .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
}

export const floodAreaName = (group, lang = 'en') => (lang === 'bn' ? group.nameBn ?? group.name : group.name);
export { districtByPcode };
