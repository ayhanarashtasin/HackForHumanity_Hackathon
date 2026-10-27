import { validateSubscription } from '../../src/services/alerts/schema.js';
import { locationByPcode } from '../../src/services/geo.js';

// Builders shared by the alert tests. Times are fixed so every expectation is exact.
export const HOUR = 3_600_000;
export const NOW = Date.parse('2026-10-11T04:00:00Z'); // 10:00 in Bangladesh
export const BADDA = '302604'; // a Dhaka city thana
export const SAVAR = '302672'; // a Dhaka-district upazila
export const AMTALI = '100409'; // Barguna
export const COXS_BAZAR = '202224';
export const DHAKA = '3026';

let counter = 0;
export const id = () => `64b0000000000000000${String(++counter).padStart(5, '0')}`;

// Per-occupation answers that pass validation, overridable per test.
const BASE_DATA = {
  farmer: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
  fisherman: { waterBody: 'coastal', status: 'ashore' },
  construction: { activityType: 'roof', workload: 'heavy', ppeHeatBurden: 'light', siteExposure: 'open', shiftStart: '08:00', shiftEnd: '17:00' },
  vendor: { outdoorStall: true, shelterAccess: 'partial', hoursOutdoor: '4to8' },
  student_public: { outdoorPlay: false },
  rickshaw_labourer: { shiftStart: '07:00', shiftEnd: '19:00', workload: 'heavy', outdoorExposure: 'on_road' },
};

// A subscriber document as the engine sees it (lean), built through the real validator so the fixtures cannot drift from the schema.
export function makeSubscriber(occupation, data = {}, { home = BADDA, extra = {}, activity = null, ...top } = {}) {
  const input = {
    occupation, language: 'en', homeAreaPcode: home, occupationData: { ...BASE_DATA[occupation], ...data }, consent: true, ...top,
  };
  const { value, errors } = validateSubscription(input, { locations: locationByPcode });
  if (!value) throw new Error(`fixture is invalid: ${JSON.stringify(errors)}`);
  return {
    _id: id(),
    ...value,
    activeActivity: activity ? { key: activity.key, since: new Date(activity.since ?? NOW - HOUR), expiresAt: new Date(activity.expiresAt ?? NOW + 6 * HOUR) } : null,
    status: 'active',
    isDemo: false,
    expiresAt: new Date(NOW + 90 * 24 * HOUR),
    ...extra,
  };
}

// A hazard event document. `from`/`until` are offsets in hours from NOW.
export function makeEvent({
  hazardType, level = 1, from = 1, until = 5, metrics = null, evidence = {}, upazilas = [BADDA], districts = [], scope = 'upazila',
  origin = 'detected', marineZone = null, dataStatus = 'FRESH',
}) {
  return {
    _id: id(),
    eventKey: `test:${id()}`,
    hazardType,
    origin,
    source: { provider: 'open-meteo', product: 'forecast-3h' },
    coverage: { scope, upazilaPcodes: upazilas, districtPcodes: districts, marineZone, matchMethod: 'representative_point' },
    level,
    evidence: { metrics, agreement: 'single-source', coverage: 'exact', rule: { key: hazardType, version: 'prototype-1', status: 'prototype' }, ...evidence },
    validFrom: new Date(NOW + from * HOUR),
    validUntil: new Date(NOW + until * HOUR),
    lifecycle: 'active',
    dataStatus,
  };
}

export const rainEvent = (level = 1, opts = {}) => makeEvent({ hazardType: 'HEAVY_RAIN', level, metrics: { rain3hMm: 12, rain24hMm: 20, popPercent: 70 }, ...opts });
export const windEvent = (level = 1, opts = {}) => makeEvent({ hazardType: 'STRONG_WIND', level, metrics: { maxGustKph: 55 }, ...opts });
export const heatEvent = (peak = 29, indicator = 'wbgt', opts = {}) => makeEvent({
  hazardType: 'HEAT_STRESS',
  level: 2,
  from: 1,
  until: 6,
  metrics: { indicator, peakValueC: peak, peakStartMs: NOW + 3 * HOUR, peakEndMs: NOW + 6 * HOUR, airTempMaxC: 35, airTempClass: null },
  ...opts,
}); // peak at 13:00 local
export const lightningEvent = (type = 'OBSERVED_LIGHTNING', level = 2, opts = {}) => makeEvent({
  hazardType: type, level, from: -0.1, until: 0.5, metrics: { count: 3, nearestKm: 8, lastStrikeAtMs: NOW - 5 * 60_000 }, ...opts,
});

// A storm-approach episode (stormEpisodes.js): a growing satellite cell, image 15 minutes old, expected over the area 40 minutes from now.
export const stormEvent = (level = 2, opts = {}) => ({
  ...makeEvent({
    hazardType: 'STORM_APPROACH',
    level,
    from: 0,
    until: 1.7,
    metrics: { arrivalAtMs: NOW + 40 * 60_000, minTempC: -78.2 },
    evidence: { storm: { observedAtMs: NOW - 15 * 60_000, intensity: 6, trend: 'growing', areaKm2: 8062, speedKmh: 24.9, towards: 'S' } },
    ...opts,
  }),
  source: { provider: 'himawari', product: 'storm-tracker', referenceId: '2026-10-11T03:45:00Z' },
});

// An FFWC gauge reading as floodStations/alertCycle build an event: observed, matched to Badda, with a shelter list.
export const floodEvent = (level = 2, opts = {}) => {
  const { evidence = {}, ...rest } = opts;
  return {
    ...makeEvent({
      hazardType: 'RIVER_FLOOD',
      level,
      from: -1,
      until: 5,
      ...rest,
      evidence: {
        observedAt: new Date(NOW - HOUR).toISOString(),
        metrics: {
          waterLevelM: 9.6, dangerLevelM: 9.2, aboveDangerM: 0.4, rainfall24hMm: 22, rainfall3dMm: 61, rainfallMonthMm: 142, normalRainfallMm: 210,
        },
        area: { scope: 'upazila', name: 'Badda', upazilaPcode: BADDA, districtPcode: DHAKA, matchMethod: 'exact' },
        stations: [{ stationId: 'SW270', name: 'Badda (Buriganga)', river: 'Buriganga', waterLevelM: 9.6, dangerLevelM: 9.2, aboveDangerM: 0.4, measuredAt: new Date(NOW - HOUR).toISOString() }],
        shelters: [{ id: 'shelter-1', name: 'Badda High School', upazila: 'Badda', distanceKm: 2.3, mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=23.78,90.42' }],
        shelterStatus: 'FRESH',
        rule: { key: `RIVER_FLOOD.L${level}`, version: 'prototype-1', status: 'prototype' },
        ...evidence,
      },
    }),
    source: { provider: 'ffwc', product: 'observed', url: 'https://ffwc.gov.bd/' },
  };
};

export const officialEvent = (kind = 'warning', opts = {}) => ({
  ...makeEvent({ hazardType: 'OFFICIAL_NOTICE', level: kind === 'warning' ? 2 : 1, from: 0, scope: 'marine-zone', upazilas: [], marineZone: 'north_bay', evidence: { kind, greatDanger: false }, ...opts }),
  source: { provider: 'bmd', product: 'fishermen-forecast', referenceId: 'synthetic-123' },
  official: { issuer: 'BMD', signalText: kind === 'warning' ? 'LOCAL CAUTIONARY SIGNAL NO. 3' : null, issuedAt: new Date(NOW), documentUrl: 'https://www.bmd.gov.bd/file/2026/10/11/pdf/123.pdf' },
});

// A forecast area as normalize.js builds it, for hazard tests. Series periods are { startMs, endMs, ... }.
export function period(startHours, lengthHours, fields) {
  return { startMs: NOW + startHours * HOUR, endMs: NOW + (startHours + lengthHours) * HOUR, ...fields };
}

export function threeHourly(startHours, values, key = 'value') {
  return values.map((value, i) => period(startHours + i * 3, 3, { [key]: value }));
}

export function emptyArea(overrides = {}) {
  return {
    pcode: BADDA, name: 'Badda', nameBn: null, districtPcode: DHAKA, lat: 23.78, lon: 90.42, kind: 'thana', generatedAt: NOW,
    rain: [], heat: [], airTemp: [], gust: [], thunder: [], daily: null, providers: [],
    ...overrides,
  };
}

export function rainSeries(amounts, { pops = null, provider = 'open-meteo', status = 'FRESH', unitVerified = true, startHours = 0, lengthHours = 3 } = {}) {
  return {
    provider,
    product: 'forecast',
    status,
    unitVerified,
    periods: amounts.map((mm, i) => period(startHours + i * lengthHours, lengthHours, { mm, pop: pops ? pops[i] : null })),
  };
}
