import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFloodReadings, classifyWaterLevel, groupFloodReadings, matchStationArea, normaliseName,
} from '../src/services/alerts/floodStations.js';
import { nearestShelters, normaliseShelters, parseShelterHtml, shelterSnapshotStatus } from '../src/services/alerts/floodShelters.js';
import { floodSnapshotStatus, sameCoverage } from '../src/services/alerts/floodSense.js';

const observedRow = (overrides = {}) => ({
  st_id: 1,
  station_serial_no: 1,
  name: 'Badda',
  lat: 23.78,
  long: 90.42,
  district: 'Dhaka',
  upazilla: 'Badda',
  waterlevel: '9.6',
  dangerlevel: 9.2,
  wl_date: '2026-10-11T04:00:00Z',
  ...overrides,
});

test('river readings sit exactly on the half-metre approach band and the one-metre significant line', () => {
  assert.deepEqual(classifyWaterLevel(9.2, 9.2), { classification: 'ABOVE', level: 2, aboveDangerM: 0 });
  assert.equal(classifyWaterLevel(8.69, 9.2).classification, 'NORMAL');
  assert.equal(classifyWaterLevel(8.71, 9.2).classification, 'APPROACHING', '0.49 m below is inside the half-metre band');
  assert.deepEqual(classifyWaterLevel(8.7, 9.2), { classification: 'APPROACHING', level: 1, aboveDangerM: -0.5 });
  assert.deepEqual(classifyWaterLevel(10.2, 9.2), { classification: 'SIGNIFICANTLY_ABOVE', level: 3, aboveDangerM: 1 });
  assert.deepEqual(classifyWaterLevel(9.19, 9.2), { classification: 'APPROACHING', level: 1, aboveDangerM: -0.01 });
  assert.deepEqual(classifyWaterLevel(null, 9.2), { classification: 'UNAVAILABLE', level: 0, aboveDangerM: null });
  assert.deepEqual(classifyWaterLevel(9.2, 0), { classification: 'UNAVAILABLE', level: 0, aboveDangerM: null }, 'a zero danger level is a missing one');
});

test('FFWC spellings and the catalogue spellings agree, including Chapai Nawabganj and Brahmanbaria', () => {
  assert.equal(normaliseName("Cox's Bazar"), 'coxsbazar');
  assert.equal(normaliseName('Chittagong'), 'chattogram');
  assert.equal(normaliseName('Chapai-Nawabganj'), normaliseName('Chapainababganj'));
  assert.equal(normaliseName('B. Baria'), normaliseName('Brahmanbaria'));
  assert.equal(normaliseName('B. Baria Sadar'), normaliseName('Brahmanbaria Sadar'));
  assert.equal(matchStationArea({ district: 'Chapai Nawabganj', upazilla: 'Nawabganj Sadar' }).districtPcode, '5070');
  assert.equal(matchStationArea({ district: 'B. Baria', upazilla: 'B. Baria Sadar' }).scope, 'upazila');
  assert.equal(matchStationArea({ district: 'Not a district' }), null, 'an unknown district is never guessed');
});

test('one bundle becomes one row per gauge, with rain and the registry river attached', () => {
  const bundle = buildFloodReadings({
    stations: [{ web_id: 1, station: 'Badda', river: 'Buriganga', dl: 9.2, latitude: 23.78, longitude: 90.42 }],
    observed: [observedRow({ dangerlevel: undefined })],
    rainfall: [{ st_id: 1, total_rainfall: 142, normal_rainfall: 210, max_rainfall: 300 }],
    threeDayRainfall: { 1: [{ '09-10-2026': '3.0' }, { '10-10-2026': '5.0' }, { '11-10-2026': '7.0' }] },
  });
  assert.equal(bundle.unmatched.length, 0);
  assert.equal(bundle.readings.length, 1);
  const [reading] = bundle.readings;
  assert.equal(reading.river, 'Buriganga');
  assert.equal(reading.waterLevelM, 9.6);
  assert.equal(reading.dangerLevelM, 9.2);
  assert.equal(reading.classification, 'ABOVE');
  assert.equal(reading.rainfallMonthMm, 142);
  assert.equal(reading.rainfall24hMm, 7);
  assert.equal(reading.rainfall3dMm, 15);
  assert.equal(reading.area.name, 'Badda');
  assert.equal(reading.wlAt, '2026-10-11T04:00:00.000Z');
});

test('rainfall totals use calendar order, not the order the provider lists days in', () => {
  const bundle = buildFloodReadings({
    observed: [observedRow()],
    threeDayRainfall: { 1: [{ '11-10-2026': '7.0' }, { '09-10-2026': '3.0' }, { '10-10-2026': '5.0' }] },
  });
  assert.equal(bundle.readings[0].rainfall24hMm, 7, 'the latest day is 11 October even when listed first');
  assert.equal(bundle.readings[0].rainfall3dMm, 15);
});

test('an unplaceable gauge is reported, and a suspended or incomplete row is dropped', () => {
  const bundle = buildFloodReadings({
    observed: [
      observedRow({ name: 'Unknown', district: 'Atlantis' }),
      observedRow({ st_id: 2, name: 'Suspended', status: 0 }),
      observedRow({ st_id: 3, name: 'No level', waterlevel: '' }),
      observedRow({ st_id: 4, name: 'No danger', dangerlevel: null }),
    ],
  });
  assert.equal(bundle.readings.length, 0);
  assert.equal(bundle.unmatched.length, 1);
  assert.equal(bundle.unmatched[0].stationName, 'Unknown');
});

test('several gauges in one upazila make one group led by the highest level, and no district duplicate survives', () => {
  const bundle = buildFloodReadings({
    observed: [
      observedRow({ st_id: 1, name: 'Badda A', waterlevel: 8.8 }),
      observedRow({ st_id: 2, name: 'Badda B', waterlevel: 9.6 }),
      observedRow({ st_id: 3, name: 'Savar', lat: 23.858, long: 90.266, upazilla: 'Savar', waterlevel: 10.3 }),
      observedRow({ st_id: 4, name: 'Dhaka district gauge', upazilla: '', lat: null, long: null, waterlevel: 10.1 }),
    ],
  });
  const groups = groupFloodReadings(bundle.readings);
  const badda = groups.find((group) => group.upazilaPcode === '302604');
  assert.equal(badda.stations.length, 2);
  assert.equal(badda.lead.stationName, 'Badda B');
  assert.equal(badda.classification, 'ABOVE');
  assert.equal(groups.filter((group) => group.districtPcode === '3026').length, 2, 'the district fallback is dropped when upazila groups exist');
  assert.equal(groups[0].name, 'Savar', 'groups are ordered by the highest level');
});

test('the DDM HTML list is parsed and only usable Flood shelters in Bangladesh are kept', () => {
  const html = '<script>let shelter = ['
    + '{"id":"1","name":"School","shelter_type_id":"Flood","status":"Useable","lat":"23.8","lon":"90.4","upazila_name":"Badda","district_name":"Dhaka","capacity":"200","safe_water":"Yes","seperate_womens_toilet":"No"},'
    + '{"id":"2","name":"Cyclone","shelter_type_id":"Cyclone","lat":"23.8","lon":"90.4"},'
    + '{"id":"3","name":"Closed","shelter_type_id":"Flood","status":"Damaged","lat":"23.8","lon":"90.4"},'
    + '{"id":"4","name":"Wrong place","shelter_type_id":"Flood","lat":"0","lon":"0"}'
    + '];</script>';
  const rows = parseShelterHtml(html);
  assert.equal(rows.length, 4);
  const shelters = normaliseShelters(rows);
  assert.equal(shelters.length, 1);
  assert.equal(shelters[0].name, 'School');
  assert.equal(shelters[0].capacity, 200);
  assert.equal(shelters[0].safeWater, true);
  assert.equal(shelters[0].womenToilet, false);
  assert.equal(shelters[0].source, 'ddm');
  assert.throws(() => parseShelterHtml('<html>maintenance</html>'), /shelter list/);
});

test('a failed FFWC refresh keeps old gauge rows as STALE, not unavailable', () => {
  const nowMs = Date.parse('2026-10-27T12:00:00Z');
  const data = { readings: [{ stationName: 'Kurigram' }] };
  assert.equal(floodSnapshotStatus({ status: 'UNAVAILABLE', data, fetchedAt: new Date(nowMs - 3_600_000) }, nowMs), 'STALE');
  assert.equal(floodSnapshotStatus({ status: 'UNAVAILABLE', data: null, fetchedAt: new Date(nowMs) }, nowMs), 'UNAVAILABLE');
  assert.equal(floodSnapshotStatus({ status: 'FRESH', data, fetchedAt: new Date(nowMs - 4 * 3_600_000) }, nowMs), 'STALE');
  assert.equal(floodSnapshotStatus(null, nowMs), 'UNAVAILABLE');
});

test('a district fallback cannot update or withdraw an upazila event in the same district', () => {
  const districtEvent = { coverage: { scope: 'district', districtPcodes: ['3026'], upazilaPcodes: [] } };
  const upazilaEvent = { coverage: { scope: 'upazila', districtPcodes: ['3026'], upazilaPcodes: ['302604'] } };
  const upazilaGroup = { scope: 'upazila', upazilaPcode: '302604', districtPcode: '3026' };
  const districtGroup = { scope: 'district', upazilaPcode: null, districtPcode: '3026' };
  assert.equal(sameCoverage(upazilaEvent, upazilaGroup), true);
  assert.equal(sameCoverage(districtEvent, upazilaGroup), false, 'the parent district does not make it the same event');
  assert.equal(sameCoverage(upazilaEvent, districtGroup), false, 'a district group must not withdraw a narrower upazila event');
  assert.equal(sameCoverage(districtEvent, districtGroup), true);
});

test('a failed DDM refresh keeps the last good shelter list as STALE, not unavailable', () => {
  const nowMs = Date.parse('2026-10-27T12:00:00Z');
  const data = { shelters: [{ id: 'a', name: 'School', lat: 23.8, lon: 90.4 }] };
  assert.equal(shelterSnapshotStatus({ status: 'UNAVAILABLE', data, fetchedAt: new Date(nowMs - 3_600_000) }, nowMs), 'STALE');
  assert.equal(shelterSnapshotStatus({ status: 'UNAVAILABLE', data: null, fetchedAt: new Date(nowMs) }, nowMs), 'UNAVAILABLE');
  assert.equal(shelterSnapshotStatus({ status: 'FRESH', data, fetchedAt: new Date(nowMs - 25 * 3_600_000) }, nowMs), 'STALE');
  assert.equal(shelterSnapshotStatus({ status: 'FRESH', data, fetchedAt: new Date(nowMs - 3_600_000) }, nowMs), 'FRESH');
  assert.equal(shelterSnapshotStatus(null, nowMs), 'UNAVAILABLE');
});

test('nearest shelters are ranked by distance, capped and never reach across the country', () => {
  const shelters = [
    { id: 'a', name: 'Near', lat: 23.8009, lon: 90.42 },
    { id: 'b', name: 'Close', lat: 23.79, lon: 90.42 },
    { id: 'c', name: 'Far', lat: 24.9, lon: 91.8 },
    { id: 'd', name: 'Mid', lat: 23.2, lon: 91.1 },
  ];
  const result = nearestShelters(shelters, 23.8, 90.42, 2);
  assert.deepEqual(result.map((shelter) => shelter.name), ['Near', 'Close']);
  assert.ok(result[0].distanceKm < result[1].distanceKm);
  assert.match(result[0].mapsUrl, /^https:\/\/www\.google\.com\/maps\/dir\//);
  assert.deepEqual(nearestShelters(shelters, 23.0, 91.0, 5).map((shelter) => shelter.name), ['Mid'], 'a shelter 50 km away or more is not offered');
  assert.deepEqual(nearestShelters(shelters, null, null), []);
});
