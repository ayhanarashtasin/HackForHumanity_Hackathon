import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { aggregateDistricts, circularMeanDegrees } from '../src/services/aggregate.js';
import { decodeDayTime, decodeStepTime, normalizeDaily, normalizeSteps } from '../src/services/bmdForecast.js';
import { frameTimeToIso, parseRadarIndex } from '../src/services/bmdRadar.js';
import { heatIndexC } from '../src/services/heatIndex.js';
import { thunderLevel, windowHourly } from '../src/services/openMeteo.js';
import { expandRanges, parseCapabilities } from '../src/services/satellite.js';
import {
  getSnapshotObject, recordCheck, recordFailure, resetForTests, setSnapshot, statusOf,
} from '../src/services/weatherStore.js';

afterEach(() => resetForTests());

test('heat index never drops below the air temperature and matches the NWS table', () => {
  assert.ok(Math.abs(heatIndexC(32, 60) - 37.3) < 1, 'about 37 C at 32 C and 60 % RH');
  assert.ok(heatIndexC(20, 50) >= 20);
  assert.equal(heatIndexC(NaN, 50), null);
  assert.equal(heatIndexC(30, undefined), null);
});

test('BMD step times decode the hour stored in the minutes field', () => {
  assert.equal(decodeStepTime('2026-10-10T00:06:00'), '2026-10-10T06:00:00+06:00');
  assert.equal(decodeStepTime('2026-10-14T00:03:00'), '2026-10-14T03:00:00+06:00');
  assert.equal(decodeStepTime('2026-10-10T06:00:00'), '2026-10-10T00:00:00+06:00');
  assert.throws(() => decodeStepTime('2026-10-10T00:30:00'), /Unexpected BMD step time/);
  assert.equal(decodeDayTime('2026-10-10T00:00:00'), '2026-10-10T00:00:00Z');
  assert.throws(() => decodeDayTime('2026-10-10T06:00:00'), /Unexpected BMD daily time/);
});

const entry = (start, avg, min = avg, max = avg) => ({ step_start: start, step_end: start, val_min: min, val_avg: avg, val_max: max });

test('normalizing BMD steps aligns variables on one grid, keeps gaps as null and computes the heat index', () => {
  const chunk = {
    updated_at: '2026-10-10T13:15:12.215',
    data: {
      302604: {
        forecast_data: {
          temp: [entry('2026-10-10T00:06:00', 26.07), entry('2026-10-10T00:09:00', 31.234)],
          rh: [entry('2026-10-10T00:06:00', 74.2), entry('2026-10-10T00:09:00', 51.4)],
          rf: [entry('2026-10-10T00:09:00', 0.456)],
          tempdew: [],
        },
      },
    },
  };

  const result = normalizeSteps([chunk]);
  assert.deepEqual(result.steps, ['2026-10-10T06:00:00+06:00', '2026-10-10T09:00:00+06:00']);
  const badda = result.locations['302604'];
  assert.deepEqual(badda.temp, [26.1, 31.2]);
  assert.deepEqual(badda.rf, [null, 0.46]);
  assert.deepEqual(badda.ws, [null, null]);
  assert.ok(badda.hi[1] > badda.temp[1], 'heat index exceeds air temperature in humid heat');
  assert.equal(result.updatedAt, '2026-10-10T13:15:12.215');
  assert.ok(result.missing.length > 500, 'locations not returned by BMD are reported as missing');
});

test('normalizing BMD daily values reads min/max/avg per UTC day', () => {
  const chunk = {
    data: {
      302604: {
        forecast_data: {
          temp: [entry('2026-10-10T00:00:00', 28.2, 24.04, 31.29), entry('2026-10-11T00:00:00', 29, 25, 33)],
          rf: [entry('2026-10-10T00:00:00', 5.32, 0, 6.83)],
        },
      },
    },
  };

  const { days, locations } = normalizeDaily([chunk]);
  assert.deepEqual(days, ['2026-10-10T00:00:00Z', '2026-10-11T00:00:00Z']);
  assert.deepEqual(locations['302604'].tmin, [24, 25]);
  assert.deepEqual(locations['302604'].tmax, [31.3, 33]);
  assert.deepEqual(locations['302604'].rf, [5.32, null]);
});

test('district summaries keep both the mean and the worst upazila and average wind direction on the circle', () => {
  const districts = [{ pcode: '3026', upazilas: ['a', 'b'] }, { pcode: '9999', upazilas: ['missing'] }];
  const locations = {
    a: { temp: [30, null], rf: [0, 10], wd: [350, 90], ts: [1, 0] },
    b: { temp: [34, null], rf: [2, 0], wd: [10, 90], ts: [3, 0] },
  };

  const result = aggregateDistricts(districts, locations, 2);
  assert.deepEqual(result['3026'].temp, [32, null]);
  assert.deepEqual(result['3026'].tempMax, [34, null]);
  assert.deepEqual(result['3026'].rf, [1, 5]);
  assert.deepEqual(result['3026'].rfMax, [2, 10]);
  assert.deepEqual(result['3026'].ts, [3, 0]);
  assert.equal(result['3026'].wd[0], 0);
  assert.equal(result['9999'], undefined, 'districts without data are omitted');
  assert.ok(Math.abs(circularMeanDegrees([350, 10]) - 0) < 1e-9 || Math.abs(circularMeanDegrees([350, 10]) - 360) < 1e-9);
});

test('thunderstorm potential needs a precipitation signal, not CAPE alone', () => {
  assert.equal(thunderLevel({ wmo: 0, cape: 2600, pop: 5 }), 0);
  assert.equal(thunderLevel({ wmo: 3, cape: 1100, pop: 55 }), 1);
  assert.equal(thunderLevel({ wmo: 3, cape: 1600, pop: 65 }), 2);
  assert.equal(thunderLevel({ wmo: 80, cape: 1500, pop: 20 }), 2);
  assert.equal(thunderLevel({ wmo: 3, cape: 2100, pop: 75 }), 3);
  assert.equal(thunderLevel({ wmo: 95, cape: 0, pop: 0 }), 3);
  assert.equal(thunderLevel({ wmo: null, cape: null, pop: null }), 0);
});

test('hourly Open-Meteo data is windowed into 3-hour steps on the BMD grid', () => {
  const hourly = {
    time: ['2026-10-10T06:00', '2026-10-10T07:00', '2026-10-10T08:00', '2026-10-10T09:00', '2026-10-10T10:00', '2026-10-10T11:00'],
    temperature_2m: [26, 28, 30, 32, 32, 32],
    relative_humidity_2m: [70, 70, 70, 50, 50, 50],
    precipitation: [0.5, 0.25, 0, 0, 0, 0],
    precipitation_probability: [10, 20, 30, 60, 80, 70],
    weather_code: [1, 3, 61, 95, 3, 3],
    cloud_cover: [50, 50, 50, 100, 100, 100],
    wind_speed_10m: [4, 6, 8, 10, 10, 10],
    wind_direction_10m: [350, 10, 0, 90, 90, 90],
    wind_gusts_10m: [8, 12, 20, 18, 18, 18],
    cape: [100, 200, 300, 2500, 100, 100],
  };

  const { steps, columns } = windowHourly(hourly);
  assert.deepEqual(steps, ['2026-10-10T06:00:00+06:00', '2026-10-10T09:00:00+06:00']);
  assert.deepEqual(columns.temp, [28, 32]);
  assert.deepEqual(columns.rf, [0.75, 0]);
  assert.deepEqual(columns.wg, [20, 18]);
  assert.deepEqual(columns.cc, [4, 8], 'cloud cover % converts to okta like BMD');
  assert.equal(columns.wd[0], 0);
  assert.deepEqual(columns.wmo, [61, 95]);
  assert.deepEqual(columns.ts, [0, 3]);
  assert.deepEqual(columns.pop, [30, 80]);
});

test('radar index parsing keeps known products, converts local times and skips unsafe file names', () => {
  const index = {
    radarSites: [{
      id: 'dhaka', name: 'Dhaka', isMaintenance: false, center: [23.98, 90.4],
      imageBounds: { 450: [[28.05, 85.98], [19.92, 94.83]] },
    }],
    radarImages: [
      { radarSiteId: 'dhaka', radius: '450', product: 'Surface-R', datetime: '2026-10-10 16:51', url: 'images/radar/068/a.png', file: 'a.png' },
      { radarSiteId: 'dhaka', radius: '450', product: 'Surface-R', datetime: '2026-10-10 16:41', url: 'images/radar/068/b.png', file: 'b.png' },
      { radarSiteId: 'dhaka', radius: '450', product: 'Surface-R', datetime: '2026-10-10 16:31', url: 'x', file: '../etc/passwd' },
      { radarSiteId: 'dhaka', radius: '450', product: 'Mystery', datetime: '2026-10-10 16:51', url: 'images/c.png', file: 'c.png' },
      { radarSiteId: 'dhaka', radius: '200', product: 'CAPPI-R (01km)', datetime: '2026-10-10 16:51', url: 'images/d.png', file: 'd.png' },
    ],
  };

  const { sites, files } = parseRadarIndex(index);
  assert.deepEqual(sites[0].bounds['450'], { north: 28.05, west: 85.98, south: 19.92, east: 94.83 });
  assert.deepEqual(sites[0].frames.sri.map((frame) => frame.time), ['2026-10-10T16:41:00+06:00', '2026-10-10T16:51:00+06:00']);
  assert.equal(sites[0].frames.cappi, undefined, 'a frame without matching bounds for its radius is dropped');
  assert.equal(files.get('dhaka/a.png'), 'images/radar/068/a.png');
  assert.equal(files.has('dhaka/c.png'), false);
  assert.equal(frameTimeToIso('bad'), null);
});

test('satellite ranges expand into 10-minute frames and capabilities parsing finds the layer', () => {
  const now = Date.parse('2026-10-10T11:30:00Z');
  assert.deepEqual(expandRanges(['2026-10-10T10:00:00Z/2026-10-10T10:20:00Z/PT10M'], now), [
    '2026-10-10T10:00:00Z', '2026-10-10T10:10:00Z', '2026-10-10T10:20:00Z',
  ]);
  assert.deepEqual(expandRanges(['2026-09-01T10:00:00Z/2026-09-01T10:20:00Z/PT10M'], now), [], 'old ranges are ignored');

  const xml = `<Layer><ows:Identifier>Himawari_AHI_Band13_Clean_Infrared</ows:Identifier>
    <TileMatrixSet>GoogleMapsCompatible_Level6</TileMatrixSet>
    <Dimension><Value>2026-10-10T10:00:00Z/2026-10-10T10:20:00Z/PT10M</Value></Dimension></Layer>`;
  const layers = parseCapabilities(xml, now);
  assert.equal(layers.ir.maxZoom, 6);
  assert.equal(layers.ir.frames.length, 3);
  assert.match(layers.ir.tileUrl, /Himawari_AHI_Band13_Clean_Infrared\/default\/\{time\}\/GoogleMapsCompatible_Level6\/\{z\}\/\{y\}\/\{x\}\.png$/);
  assert.equal(layers.visible, undefined);
});

test('source status moves from not-checked to ok, stale and unavailable', () => {
  assert.equal(statusOf('radar').status, 'not-checked');

  recordFailure('radar', new Error('boom'));
  assert.equal(statusOf('radar').status, 'unavailable');
  assert.equal(statusOf('radar').message, 'boom');

  recordCheck('radar', { dataTime: new Date().toISOString() });
  assert.equal(statusOf('radar').status, 'ok');
  assert.equal(statusOf('radar').message, null);

  const twoHoursLater = Date.now() + 2 * 3_600_000;
  assert.equal(statusOf('radar', twoHoursLater).status, 'stale', 'radar data older than an hour is stale, never silently ok');
});

test('the snapshot prefers a healthy BMD forecast and adds Open-Meteo thunder data aligned to its steps', async () => {
  const steps = ['2026-10-10T06:00:00+06:00', '2026-10-10T09:00:00+06:00', '2026-10-10T12:00:00+06:00'];
  await setSnapshot('bmd', {
    sourceUpdatedAt: new Date().toISOString(),
    steps,
    locations: { 302604: { temp: [26, 30, 31], rf: [0, 0, 1] } },
    districts: { 3026: { temp: [26, 30, 31] } },
    daily: { days: ['2026-10-10T00:00:00Z'], locations: {} },
  }, { dataTime: new Date().toISOString(), persistToDb: false });

  await setSnapshot('openMeteo', {
    steps: ['2026-10-10T09:00:00+06:00', '2026-10-10T12:00:00+06:00'],
    locations: { 302604: { temp: [99, 99], cape: [1, 1], wmo: [3, 95], ts: [0, 3], pop: [10, 90] } },
    districts: { 3026: { ts: [0, 2] } },
  }, { persistToDb: false });

  const snapshot = getSnapshotObject();
  assert.equal(snapshot.base, 'bmd');
  assert.deepEqual(snapshot.locations['302604'].temp, [26, 30, 31], 'BMD stays the source of temperature');
  assert.deepEqual(snapshot.locations['302604'].ts, [null, 0, 3], 'extras are aligned by step start time');
  assert.deepEqual(snapshot.locations['302604'].wmo, [null, 3, 95]);
  assert.equal(snapshot.locations['302604'].cape, undefined, 'raw CAPE is not sent to the browser');
  assert.deepEqual(snapshot.districts['3026'].ts, [null, 0, 2]);
  assert.equal(snapshot.sources.bmd.status, 'ok');
  assert.equal(snapshot.thunderSource, 'open-meteo');
});

test('when BMD has no data the snapshot falls back to Open-Meteo and says so', async () => {
  await setSnapshot('openMeteo', {
    steps: ['2026-10-10T09:00:00+06:00'],
    locations: { 302604: { temp: [30], wmo: [3], ts: [0], pop: [10], cape: [1] } },
    districts: {},
  }, { persistToDb: false });

  const snapshot = getSnapshotObject();
  assert.equal(snapshot.base, 'open-meteo');
  assert.equal(snapshot.sources.bmd.status, 'not-checked');
  assert.deepEqual(snapshot.locations['302604'].temp, [30]);
});

test('with no data at all the snapshot is empty rather than inventing a calm state', () => {
  const snapshot = getSnapshotObject();
  assert.equal(snapshot.base, null);
  assert.deepEqual(snapshot.steps, []);
  assert.deepEqual(snapshot.locations, {});
  assert.equal(snapshot.sources.bmd.status, 'not-checked');
});
