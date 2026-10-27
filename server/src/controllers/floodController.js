import { env } from '../config/env.js';
import { locationByPcode } from '../services/geo.js';
import { loadFloodSnapshot } from '../services/alerts/floodSense.js';
import { loadShelterSnapshot, nearestShelters, shelterSnapshotStatus } from '../services/alerts/floodShelters.js';
import { hazardRules, freshness } from '../config/alertRules.js';

// Read-only public view of the same cached snapshots the alert engine uses. No provider call happens on a page load, and no
// subscriber, contact or shelter-guard data is exposed.
const stationView = (station) => ({
  stationId: station.stationId,
  name: station.stationName,
  river: station.river,
  waterLevelM: station.waterLevelM,
  dangerLevelM: station.dangerLevelM,
  aboveDangerM: station.aboveDangerM,
  highestWaterLevelM: station.highestWaterLevelM,
  classification: station.classification,
  level: station.level,
  measuredAt: station.wlAt,
  rainfall24hMm: station.rainfall24hMm,
  rainfall3dMm: station.rainfall3dMm,
  rainfallMonthMm: station.rainfallMonthMm,
  normalRainfallMm: station.normalRainfallMm,
  area: station.area
    ? {
      scope: station.area.scope,
      name: station.area.name,
      nameBn: station.area.nameBn,
      upazilaPcode: station.area.upazilaPcode,
      districtPcode: station.area.districtPcode,
      matchMethod: station.area.matchMethod,
    }
    : null,
});

const shelterView = (shelter) => ({
  id: shelter.id,
  name: shelter.name,
  upazila: shelter.upazila,
  district: shelter.district,
  union: shelter.union,
  lat: shelter.lat,
  lon: shelter.lon,
  capacity: shelter.capacity,
  distanceKm: shelter.distanceKm ?? null,
  disabledFriendly: shelter.disabledFriendly,
  womenSpace: shelter.womenSpace,
  womenToilet: shelter.womenToilet,
  safeWater: shelter.safeWater,
  childrenFriendly: shelter.childrenFriendly,
  elderlyFriendly: shelter.elderlyFriendly,
  toilets: shelter.toilets,
  mapsUrl: shelter.mapsUrl ?? `https://www.google.com/maps/dir/?api=1&destination=${shelter.lat},${shelter.lon}`,
});

async function shelterContext(nowMs) {
  const unavailable = { status: 'UNAVAILABLE', fetchedAt: null, shelters: [], sourceUrl: env.flood.shelterUrl };
  if (!env.flood.sheltersEnabled) return unavailable;
  try {
    const row = await loadShelterSnapshot();
    if (!row) return unavailable;
    return {
      status: shelterSnapshotStatus(row, nowMs),
      fetchedAt: row.fetchedAt ?? null,
      shelters: row.data?.shelters ?? [],
      sourceUrl: row.data?.sourceUrl ?? env.flood.shelterUrl,
    };
  } catch {
    return unavailable;
  }
}

export async function getFloodStatus(req, res) {
  const nowMs = Date.now();
  const { snapshot, status, data } = await loadFloodSnapshot(nowMs);
  const shelter = await shelterContext(nowMs);
  const groups = (data?.groups ?? []).map((group) => ({
    key: group.key,
    scope: group.scope,
    name: group.name,
    nameBn: group.nameBn,
    upazilaPcode: group.upazilaPcode,
    districtPcode: group.districtPcode,
    lat: group.lat,
    lon: group.lon,
    classification: group.classification,
    level: group.level,
    aboveDangerM: group.aboveDangerM,
    matchMethod: group.matchMethod,
    stations: group.stations.map(stationView),
    shelters: nearestShelters(shelter.shelters, group.lat, group.lon).map(shelterView),
    shelterStatus: shelter.status,
  }));

  const alerting = groups.filter((group) => group.level > 0);
  res.json({ data: {
    demo: false,
    enabled: env.flood.enabled,
    configured: Boolean(env.flood.apiKey),
    status,
    staleAfterMinutes: Math.round(freshness.flood.maxCheckAgeMs / 60_000),
    fetchedAt: snapshot?.fetchedAt ?? null,
    updateDate: data?.updateDate ?? null,
    issuedAt: data?.issuedAt ?? null,
    thresholds: {
      approachingBandM: hazardRules.RIVER_FLOOD.approachingBandM,
      significantAboveM: hazardRules.RIVER_FLOOD.significantAboveM,
      validityHours: hazardRules.RIVER_FLOOD.validityHours,
    },
    summary: {
      observedStations: data?.readings?.length ?? 0,
      matchedAreas: groups.length,
      alertingAreas: alerting.length,
      approaching: groups.filter((group) => group.classification === 'APPROACHING').length,
      above: groups.filter((group) => group.classification === 'ABOVE').length,
      significantlyAbove: groups.filter((group) => group.classification === 'SIGNIFICANTLY_ABOVE').length,
      unmatchedStations: data?.unmatched?.length ?? 0,
    },
    shelters: {
      status: shelter.status,
      matched: alerting.reduce((sum, group) => sum + group.shelters.length, 0),
      sourceUrl: shelter.sourceUrl,
    },
    groups,
    unmatched: (data?.unmatched ?? []).map((station) => ({
      station: station.stationName,
      river: station.river,
      district: station.district,
      upazila: station.upazila,
      classification: station.classification,
    })),
  } });
}

export async function getFloodStations(req, res) {
  const { snapshot, data, status } = await loadFloodSnapshot();
  const district = String(req.query.district ?? '').trim();
  const upazila = String(req.query.upazila ?? '').trim();
  let readings = data?.readings ?? [];
  if (onFilter(district)) readings = readings.filter((reading) => reading.area?.districtPcode === district);
  if (onFilter(upazila)) readings = readings.filter((reading) => reading.area?.upazilaPcode === upazila);
  res.json({ data: {
    status,
    fetchedAt: snapshot?.fetchedAt ?? null,
    stations: readings.map(stationView),
    unmatched: (data?.unmatched ?? []).map(stationView),
  } });
}

export async function getFloodShelters(req, res) {
  const nowMs = Date.now();
  const shelter = await shelterContext(nowMs);
  const limit = Math.min(Math.max(Number(req.query.limit) || env.flood.maxShelters, 1), 10);
  let lat = Number(req.query.lat);
  let lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const location = locationByPcode.get(String(req.query.upazila ?? ''));
    if (location) {
      lat = location.lat;
      lon = location.lon;
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ message: 'Provide lat and lon, or a known upazila pcode.' });
  }
  return res.json({ data: {
    status: shelter.status,
    fetchedAt: shelter.fetchedAt,
    sourceUrl: shelter.sourceUrl,
    shelters: nearestShelters(shelter.shelters, lat, lon, limit).map(shelterView),
    disclaimer: 'DDM shelter locations only. Occupancy and open/closed status are not published; check before travelling.',
  } });
}

// UI preview only. It produces no events, no notifications and no writes, and is explicitly marked demo in every response.
const DEMO = [
  {
    key: 'demo:kurigram', scope: 'upazila', name: 'Kurigram Sadar', nameBn: 'কুড়িগ্রাম সদর', level: 3, classification: 'SIGNIFICANTLY_ABOVE',
    lat: 25.807, lon: 89.63, aboveDangerM: 1.3, stations: [{ name: 'Kurigram (Dharla)', river: 'Dharla', waterLevelM: 27.1, dangerLevelM: 25.8, aboveDangerM: 1.3, measuredAt: new Date().toISOString() }],
  },
  {
    key: 'demo:sirajganj', scope: 'upazila', name: 'Sirajganj Sadar', nameBn: 'সিরাজগঞ্জ সদর', level: 2, classification: 'ABOVE',
    lat: 24.45, lon: 89.7, aboveDangerM: 0.3, stations: [{ name: 'Sirajganj (Jamuna)', river: 'Jamuna', waterLevelM: 13.2, dangerLevelM: 12.9, aboveDangerM: 0.3, measuredAt: new Date().toISOString() }],
  },
  {
    key: 'demo:sylhet', scope: 'upazila', name: 'Sylhet Sadar', nameBn: 'সিলেট সদর', level: 1, classification: 'APPROACHING',
    lat: 24.9, lon: 91.87, aboveDangerM: -0.3, stations: [{ name: 'Sylhet (Surma)', river: 'Surma', waterLevelM: 11.1, dangerLevelM: 11.4, aboveDangerM: -0.3, measuredAt: new Date().toISOString() }],
  },
];

export async function getFloodDemo(req, res) {
  const nowMs = Date.now();
  const shelter = await shelterContext(nowMs);
  const groups = DEMO.map((group) => ({
    ...group,
    lat: group.lat,
    lon: group.lon,
    stations: group.stations,
    shelters: nearestShelters(shelter.shelters, group.lat, group.lon).map(shelterView),
    shelterStatus: shelter.status,
  }));
  res.json({ data: {
    demo: true,
    label: 'DEMO DATA: illustrative gauges for the interface only. Nothing here creates an alert or is sent to anyone.',
    status: 'DEMO',
    fetchedAt: null,
    summary: { observedStations: DEMO.length, matchedAreas: DEMO.length, alertingAreas: DEMO.length, approaching: 1, above: 1, significantlyAbove: 1, unmatchedStations: 0 },
    thresholds: {
      approachingBandM: hazardRules.RIVER_FLOOD.approachingBandM,
      significantAboveM: hazardRules.RIVER_FLOOD.significantAboveM,
      validityHours: hazardRules.RIVER_FLOOD.validityHours,
    },
    shelters: { status: shelter.status, matched: groups.reduce((sum, group) => sum + group.shelters.length, 0), sourceUrl: shelter.sourceUrl },
    groups,
    unmatched: [],
  } });
}

const onFilter = (value) => Boolean(value) && value !== 'all';
