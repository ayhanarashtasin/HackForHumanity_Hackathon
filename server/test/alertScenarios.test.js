import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeNotification } from '../src/services/alerts/compose.js';
import { evaluateSubscriber, scenarioIds } from '../src/services/alerts/scenarios/index.js';
import { heatClassFor, heatSeverity, heatTimingOk } from '../src/services/alerts/scenarios/helpers.js';
import {
  AMTALI, BADDA, DHAKA, HOUR, NOW, SAVAR, heatEvent, lightningEvent, makeEvent, makeSubscriber, officialEvent, rainEvent, windEvent,
} from './support/alertFixtures.js';

// Runs every scenario for one subscriber and one event, returning { SCENARIO-ID: result }.
function run(subscriber, event, nowMs = NOW) {
  return Object.fromEntries(evaluateSubscriber({ subscriber, event, nowMs }).map((entry) => [entry.scenario.id, entry.result]));
}

const dryEvent = (opts = {}) => makeEvent({ hazardType: 'DRY_SPELL', level: 1, from: 0, until: 200, metrics: { dryDays: 9, meanTmaxC: 33 }, ...opts });
const marineEvent = (level = 2, opts = {}) => makeEvent({
  hazardType: 'MARINE_WEATHER', level, scope: 'marine-zone', upazilas: [], marineZone: 'north_bay', metrics: { maxWaveM: 2.4, maxGustKph: 45 }, ...opts,
});

// ---------- the heat load class and the per-class lines ----------
test('the heat load class starts from workload, moves one class for heavy gear, no shelter or long hours, and is floored by sensitivity', () => {
  assert.equal(heatClassFor(makeSubscriber('farmer', { workload: 'light', outdoorHours: 'lt4' })), 'light');
  assert.equal(heatClassFor(makeSubscriber('farmer', { workload: 'light', outdoorHours: 'gt8' })), 'moderate');
  assert.equal(heatClassFor(makeSubscriber('farmer', { workload: 'heavy', outdoorHours: 'gt8' })), 'heavy', 'capped at heavy');
  assert.equal(heatClassFor(makeSubscriber('construction', { workload: 'moderate', ppeHeatBurden: 'heavy' })), 'heavy');
  assert.equal(heatClassFor(makeSubscriber('vendor', { shelterAccess: 'none', hoursOutdoor: 'lt4' })), 'moderate');
  assert.equal(heatClassFor(makeSubscriber('vendor', { shelterAccess: 'full', hoursOutdoor: 'lt4' })), 'light');
  assert.equal(heatClassFor(makeSubscriber('student_public', {}, { isHeatSensitive: true })), 'moderate');
  assert.equal(heatClassFor(makeSubscriber('student_public')), 'light', 'the general public starts as light work');
});

test('per-class lines: WBGT 28/31 light, 25/28 moderate, 23/26 heavy; heat index 39/51, 32/39, 27/32', () => {
  const wbgt = (peak, cls) => heatSeverity(heatEvent(peak, 'wbgt'), cls);
  assert.deepEqual([27.9, 28, 30.9, 31].map((peak) => wbgt(peak, 'light')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  assert.deepEqual([24.9, 25, 27.9, 28].map((peak) => wbgt(peak, 'moderate')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  assert.deepEqual([22.9, 23, 25.9, 26].map((peak) => wbgt(peak, 'heavy')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  const index = (peak, cls) => heatSeverity(heatEvent(peak, 'heat_index'), cls);
  assert.deepEqual([26.9, 27, 31.9, 32].map((peak) => index(peak, 'heavy')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  assert.deepEqual([31.9, 32, 38.9, 39].map((peak) => index(peak, 'moderate')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  assert.deepEqual([38.9, 39, 50.9, 51].map((peak) => index(peak, 'light')), [null, 'ADVISORY', 'ADVISORY', 'WARNING']);
  assert.equal(heatSeverity(makeEvent({ hazardType: 'HEAT_STRESS', origin: 'admin-declared', level: 1 }), 'light'), 'ADVISORY');
  assert.equal(heatSeverity(makeEvent({ hazardType: 'HEAT_STRESS', origin: 'admin-declared', level: 3 }), 'light'), 'WARNING', 'declared heat is never critical');
});

test('worker heat alerts wait for daylight, speak up to six hours ahead and need an overlap with the working window', () => {
  const window = { start: '06:00', end: '18:00' };
  assert.equal(heatTimingOk(heatEvent(), window, NOW), true);
  assert.equal(heatTimingOk(heatEvent(29, 'wbgt', { from: 8, until: 12 }), window, NOW), false, 'more than six hours away');
  assert.equal(heatTimingOk(heatEvent(), window, Date.parse('2026-10-10T22:00:00Z')), false, 'before 06:00 local');
  assert.equal(heatTimingOk(heatEvent(), { start: '20:00', end: '23:00' }, NOW), false, 'the shift does not overlap the heat');
  assert.equal(heatTimingOk(heatEvent(), null, NOW), false);
});

// ---------- farmers ----------
test('FARM-01 and FARM-02: harvest gets crop protection, planting gets planning; both stay advisory unless rain is near and heavy', () => {
  const harvest = makeSubscriber('farmer', { cropStage: 'harvesting' });
  assert.equal(run(harvest, rainEvent(1))['FARM-01'].severity, 'ADVISORY');
  assert.equal(run(harvest, rainEvent(2, { from: 1 }))['FARM-01'].severity, 'WARNING', 'heavy rain within six hours');
  assert.equal(run(harvest, rainEvent(2, { from: 8, until: 12 }))['FARM-01'].severity, 'ADVISORY', 'heavy but not yet near');
  assert.equal(run(harvest, rainEvent(1, { from: 13, until: 16 }))['FARM-01'], undefined, 'beyond the 12 hour lead');
  assert.equal(run(harvest, rainEvent(1, { from: -8, until: -1 }))['FARM-01'], undefined, 'already over');
  assert.equal(run(harvest, rainEvent(1))['FARM-02'], undefined);
  assert.equal(run(harvest, rainEvent(1))['FARM-01'].advice[0].key, 'rain_harvest');

  const planting = makeSubscriber('farmer', { cropStage: 'planting' });
  const result = run(planting, rainEvent(2, { from: 1 }));
  assert.equal(result['FARM-01'], undefined, 'planting never gets harvest advice');
  assert.equal(result['FARM-02'].severity, 'ADVISORY');
  assert.equal(result['FARM-02'].advice[0].key, 'rain_planting');

  assert.equal(run(makeSubscriber('farmer', { cropStage: 'post_harvest' }), rainEvent(1))['FARM-01'].advice[0].key, 'rain_post_harvest');
  assert.equal(run(makeSubscriber('farmer', { cropStage: 'growing' }), rainEvent(1))['FARM-02'].advice[0].key, 'rain_growing');
});

test('FARM-03: a dry spell is a field check for crops that are still being planted or grown, with or without irrigation', () => {
  const irrigated = run(makeSubscriber('farmer', { cropStage: 'growing', irrigationAccess: 'pump' }), dryEvent())['FARM-03'];
  assert.equal(irrigated.severity, 'ADVISORY');
  assert.ok(irrigated.actions.includes('use_irrigation'));
  const rainFed = run(makeSubscriber('farmer', { cropStage: 'planting', irrigationAccess: 'none' }), dryEvent())['FARM-03'];
  assert.ok(rainFed.actions.includes('save_water'));
  assert.equal(run(makeSubscriber('farmer', { cropStage: 'harvesting' }), dryEvent())['FARM-03'], undefined);
  assert.equal(run(makeSubscriber('vendor'), dryEvent())['FARM-03'], undefined);
});

test('FARM-04: lightning is CRITICAL for farmers, observed or threat, and only while the event is current', () => {
  const farmer = makeSubscriber('farmer');
  assert.equal(run(farmer, lightningEvent('OBSERVED_LIGHTNING'))['FARM-04'].severity, 'CRITICAL');
  assert.equal(run(farmer, lightningEvent('LIGHTNING_THREAT', 2))['FARM-04'].severity, 'CRITICAL');
  assert.equal(run(farmer, lightningEvent('LIGHTNING_THREAT', 3))['FARM-04'].severity, 'CRITICAL');
  assert.equal(run(farmer, lightningEvent('OBSERVED_LIGHTNING', 2, { from: -2, until: -1 }))['FARM-04'], undefined, 'an ended episode sends nothing');
  assert.equal(run(farmer, lightningEvent('OBSERVED_LIGHTNING', 2, { upazilas: [SAVAR] }))['FARM-04'], undefined, 'another area');
  assert.deepEqual(run(makeSubscriber('construction', { activityType: 'ground' }), lightningEvent()), {}, 'a ground worker with no relevant activity has no lightning rule');
});

test('FARM-05: heat for farmers uses their own class, so the same forecast gives different advice to different work', () => {
  const moderate = makeSubscriber('farmer', { workload: 'moderate', outdoorHours: '4to8' });
  assert.equal(run(moderate, heatEvent(27))['FARM-05'].severity, 'ADVISORY');
  assert.equal(run(moderate, heatEvent(28))['FARM-05'].severity, 'WARNING');
  assert.equal(run(moderate, heatEvent(24))['FARM-05'], undefined);
  const heavy = makeSubscriber('farmer', { workload: 'heavy', outdoorHours: 'gt8' });
  assert.equal(run(heavy, heatEvent(24))['FARM-05'].severity, 'ADVISORY');
  assert.equal(run(heavy, heatEvent(26))['FARM-05'].severity, 'WARNING');
  const light = makeSubscriber('farmer', { workload: 'light', outdoorHours: 'lt4' });
  assert.equal(run(light, heatEvent(27))['FARM-05'], undefined);
  assert.equal(run(heavy, heatEvent(29, 'wbgt', { from: 9, until: 12 }))['FARM-05'], undefined, 'too far ahead');
  assert.equal(run(heavy, heatEvent(29), Date.parse('2026-10-10T22:00:00Z'))['FARM-05'], undefined, 'not in the small hours');
});

// ---------- fishermen ----------
test('FISH-01 and FISH-03 keep official warnings and withdrawal reminders separate, within their water-area scope', () => {
  const coastal = makeSubscriber('fisherman', { waterBody: 'coastal' });
  const warning = officialEvent();
  assert.equal(run(coastal, warning)['FISH-01'].severity, 'WARNING');
  assert.equal(run(coastal, warning)['FISH-03'], undefined);
  assert.equal(run(coastal, officialEvent('warning', { evidence: { kind: 'warning', greatDanger: true } }))['FISH-01'].severity, 'CRITICAL');
  assert.ok(run(makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'pre_departure' } }), warning)['FISH-01'].actions.includes('postpone_departure'));
  assert.deepEqual(run(makeSubscriber('fisherman', { waterBody: 'river' }), warning), {});
  assert.deepEqual(run(makeSubscriber('farmer'), warning), {});
  assert.deepEqual(run(coastal, officialEvent('warning', { marineZone: 'unverified' })), {});
  assert.deepEqual(run(coastal, officialEvent('warning', { until: -1 })), {});
  const transition = run(coastal, officialEvent('withdrawal'));
  assert.equal(transition['FISH-01'], undefined);
  assert.equal(transition['FISH-03'].severity, 'ADVISORY');
  assert.ok(transition['FISH-03'].actions.includes('check_official_forecast'));
});

test('FISH-02: lightning near a boat that is on the water is CRITICAL and never promises a safe trip', () => {
  const onWater = makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'on_water' } });
  const result = run(onWater, lightningEvent())['FISH-02'];
  assert.equal(result.severity, 'CRITICAL');
  assert.ok(result.actions.includes('return_to_shore'));
  assert.equal(run(makeSubscriber('fisherman', { waterBody: 'river' }), lightningEvent())['FISH-02'], undefined, 'on shore');
  assert.equal(run(makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'pre_departure' } }), lightningEvent())['FISH-02'], undefined);
  const expired = makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'on_water', expiresAt: NOW - HOUR } });
  assert.equal(run(expired, lightningEvent())['FISH-02'], undefined, 'an expired status is unknown, never a guess');
  assert.equal(run(makeSubscriber('farmer', {}, { activity: { key: 'on_water' } }), lightningEvent())['FISH-02'].severity, 'CRITICAL', 'CTX-01: the activity decides, not the occupation');
});

test('FISH-05: an old on-the-water status is flagged as an uncertain location', () => {
  const fresh = makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water', since: NOW - 2 * HOUR } });
  assert.equal(run(fresh, lightningEvent())['FISH-02'].evidence.scopeUncertain, undefined);
  const old = makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water', since: NOW - 8 * HOUR, expiresAt: NOW + HOUR } });
  const result = run(old, lightningEvent())['FISH-02'];
  assert.equal(result.evidence.scopeUncertain, true);
  assert.equal(result.evidence.statusAgeHours, 8);
  assert.deepEqual(result.evidence.relatedRules, ['FISH-05']);
  assert.ok(result.actions.includes('update_status'));
  assert.ok(result.advice.some((item) => item.key === 'fish_stale_status'));
});

test('FISH-04: "postpone departure" and "return to shore" are different actions for the same hazard', () => {
  const coastal = { waterBody: 'coastal' };
  const pre = makeSubscriber('fisherman', coastal, { activity: { key: 'pre_departure' } });
  const preResult = run(pre, windEvent(1))['FISH-04'];
  assert.equal(preResult.severity, 'WARNING');
  assert.ok(preResult.actions.includes('postpone_departure'));
  assert.ok(!preResult.actions.includes('return_to_shore'));

  const onWater = makeSubscriber('fisherman', coastal, { activity: { key: 'on_water' } });
  assert.equal(run(onWater, windEvent(1))['FISH-04'].severity, 'WARNING');
  assert.equal(run(onWater, windEvent(3))['FISH-04'].severity, 'CRITICAL');
  assert.ok(run(onWater, windEvent(2))['FISH-04'].actions.includes('return_to_shore'));

  const ashore = makeSubscriber('fisherman', coastal);
  assert.equal(run(ashore, windEvent(1))['FISH-04'], undefined, 'a mild hazard does not interrupt someone on shore');
  assert.equal(run(ashore, windEvent(2))['FISH-04'].severity, 'ADVISORY');
});

test('FISH-04 marine weather reaches coastal and open-sea fishermen, not river fishermen or other occupations', () => {
  const event = marineEvent(2);
  assert.equal(run(makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water' } }), event)['FISH-04'].severity, 'WARNING');
  assert.ok(run(makeSubscriber('fisherman', { waterBody: 'marine', marineZone: 'north_bay' }, { activity: { key: 'pre_departure' } }), event)['FISH-04']);
  assert.equal(run(makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'on_water' } }), event)['FISH-04'], undefined);
  assert.deepEqual(run(makeSubscriber('farmer'), event), {});
  assert.equal(run(makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water' } }), marineEvent(2, { marineZone: 'other_zone' }))['FISH-04'], undefined);
});

// ---------- construction ----------
test('CONS-01 and CONS-03: work at height, from the profile or from what the person says they are doing now', () => {
  const roof = makeSubscriber('construction', { activityType: 'roof' });
  assert.equal(run(roof, lightningEvent())['CONS-01'].severity, 'CRITICAL');
  assert.equal(run(roof, windEvent(1))['CONS-03'].severity, 'WARNING');
  assert.equal(run(roof, windEvent(3))['CONS-03'].severity, 'WARNING', 'wind never becomes critical in the catalogue');

  const ground = makeSubscriber('construction', { activityType: 'ground' });
  assert.deepEqual(run(ground, lightningEvent()), {});
  assert.deepEqual(run(ground, windEvent(2)), {});

  const viaActivity = makeSubscriber('construction', { activityType: 'ground' }, { activity: { key: 'scaffolding' } });
  const result = run(viaActivity, lightningEvent())['CONS-01'];
  assert.equal(result.severity, 'CRITICAL');
  assert.equal(result.activityKey, 'scaffolding');
  assert.equal(run(makeSubscriber('rickshaw_labourer', {}, { activity: { key: 'roof_work' } }), lightningEvent())['CONS-01'].severity, 'CRITICAL');
  assert.equal(run(makeSubscriber('construction', { activityType: 'other_elevated' }), windEvent(1))['CONS-03'].severity, 'WARNING');
});

test('CONS-02: heavy work with protective equipment, judged over the shift', () => {
  const heavyGear = makeSubscriber('construction', { workload: 'heavy', ppeHeatBurden: 'heavy', shiftStart: '08:00', shiftEnd: '17:00' });
  assert.equal(run(heavyGear, heatEvent(24))['CONS-02'].severity, 'ADVISORY');
  assert.equal(run(heavyGear, heatEvent(26))['CONS-02'].severity, 'WARNING');
  const light = makeSubscriber('construction', { workload: 'light', ppeHeatBurden: 'none' });
  assert.equal(run(light, heatEvent(27))['CONS-02'], undefined, 'light work in light gear has a higher line');
  const nightShift = makeSubscriber('construction', { shiftStart: '19:00', shiftEnd: '23:00' });
  assert.equal(run(nightShift, heatEvent(29))['CONS-02'], undefined, 'the shift does not overlap the heat');
});

test('CONS-04: rain at an open or partly covered site asks for an inspection, including the hours after the rain', () => {
  const open = makeSubscriber('construction', { siteExposure: 'open' });
  const result = run(open, rainEvent(1))['CONS-04'];
  assert.equal(result.severity, 'ADVISORY');
  assert.ok(result.actions.includes('inspect_site'));
  assert.equal(result.evidence.siteCheckRequired, true);
  assert.equal(run(makeSubscriber('construction', { siteExposure: 'partly_covered' }), rainEvent(2))['CONS-04'].severity, 'ADVISORY', 'rain level does not make it urgent');
  assert.equal(run(makeSubscriber('construction', { siteExposure: 'indoor' }), rainEvent(1))['CONS-04'], undefined);
  // Rain 11:00-15:00 local: a 19:00 shift starts while surfaces can still be wet, a 22:00 shift starts after the six hours.
  assert.ok(run(makeSubscriber('construction', { shiftStart: '19:00', shiftEnd: '21:30' }), rainEvent(1))['CONS-04']);
  assert.equal(run(makeSubscriber('construction', { shiftStart: '22:00', shiftEnd: '05:00' }), rainEvent(1))['CONS-04'], undefined);
  assert.equal(run(open, rainEvent(1, { from: 13, until: 16 }))['CONS-04'], undefined, 'beyond the 12 hour lead');
  assert.equal(run(makeSubscriber('rickshaw_labourer'), rainEvent(1))['CONS-04'], undefined);
});

// ---------- vendors ----------
test('VEND-03: rain at the main market, a saved market or the shared location, during market hours', () => {
  const vendor = makeSubscriber('vendor', { marketAreaPcode: BADDA, savedMarketPcodes: [SAVAR] });
  const main = run(vendor, rainEvent(1, { upazilas: [BADDA] }))['VEND-03'];
  assert.equal(main.severity, 'ADVISORY');
  assert.equal(main.details[0].en, 'this is your main market');
  const saved = run(vendor, rainEvent(1, { upazilas: [SAVAR] }))['VEND-03'];
  assert.equal(saved.details[0].en, 'this is one of the other markets you work at');
  assert.equal(run(vendor, rainEvent(1, { upazilas: [AMTALI] }))['VEND-03'], undefined, 'not one of their markets');
  assert.equal(run(vendor, rainEvent(1, { upazilas: [BADDA], from: 15, until: 18 }))['VEND-03'], undefined, 'beyond the 12 hour lead');

  const travelling = { ...vendor, currentArea: { upazilaPcode: AMTALI, districtPcode: '1004', expiresAt: new Date(NOW + HOUR) } };
  assert.equal(run(travelling, rainEvent(1, { upazilas: [AMTALI] }))['VEND-03'].details[0].en, 'you shared your location near this market');

  const old = { ...vendor, currentArea: { upazilaPcode: AMTALI, districtPcode: '1004', expiresAt: new Date(NOW - HOUR) } };
  assert.equal(run(old, rainEvent(1, { upazilas: [AMTALI] }))['VEND-03'], undefined, 'an old location is not used');
  const flagged = run(old, rainEvent(1, { upazilas: [BADDA] }))['VEND-03'];
  assert.equal(flagged.evidence.scopeUncertain, true);
  assert.ok(flagged.advice.some((item) => item.key === 'location_old'));
  assert.equal(run(makeSubscriber('construction'), rainEvent(1))['VEND-03'], undefined);
});

test('VEND-01: wind at an outdoor stall is a warning; an indoor stall is not told to rush out', () => {
  assert.equal(run(makeSubscriber('vendor', { outdoorStall: true }), windEvent(1))['VEND-01'].severity, 'WARNING');
  assert.equal(run(makeSubscriber('vendor', { outdoorStall: false }), windEvent(2))['VEND-01'], undefined);
  assert.equal(run(makeSubscriber('vendor', { outdoorStall: false }, { activity: { key: 'stall_outdoor' } }), windEvent(1))['VEND-01'].activityKey, 'stall_outdoor');
  assert.ok(run(makeSubscriber('vendor', { outdoorStall: true }), windEvent(1))['VEND-01'].actions.includes('stay_in'));
});

test('VEND-02: heat in an open-air market depends on hours outdoors and shelter', () => {
  const sheltered = makeSubscriber('vendor', { shelterAccess: 'full', hoursOutdoor: 'lt4' });
  assert.equal(run(sheltered, heatEvent(29))['VEND-02'].severity, 'ADVISORY');
  assert.equal(run(sheltered, heatEvent(31))['VEND-02'].severity, 'WARNING');
  const exposed = makeSubscriber('vendor', { shelterAccess: 'none', hoursOutdoor: 'lt4' });
  assert.equal(run(exposed, heatEvent(26))['VEND-02'].severity, 'ADVISORY');
  assert.equal(run(exposed, heatEvent(28))['VEND-02'].severity, 'WARNING');
});

// ---------- the public ----------
test('PUBLIC-01: commute rain only when the forecast overlaps the commute, and it makes no claim about roads', () => {
  const student = makeSubscriber('student_public', { commuteStart: '11:00', commuteEnd: '12:30' });
  const result = run(student, rainEvent(1))['PUBLIC-01'];
  assert.equal(result.severity, 'ADVISORY');
  assert.ok(result.actions.includes('check_roads'));
  assert.equal(run(makeSubscriber('student_public'), rainEvent(1))['PUBLIC-01'], undefined, 'the default 07:00-09:00 commute is not in this rain');
  assert.equal(run(makeSubscriber('farmer'), rainEvent(1))['PUBLIC-01'], undefined);
});

test('PUBLIC-02: outdoor play and lightning is CRITICAL, from the profile or from the current activity', () => {
  assert.equal(run(makeSubscriber('student_public', { outdoorPlay: true }), lightningEvent())['PUBLIC-02'].severity, 'CRITICAL');
  assert.equal(run(makeSubscriber('student_public', { outdoorPlay: false }), lightningEvent())['PUBLIC-02'], undefined);
  assert.equal(run(makeSubscriber('student_public', { outdoorPlay: false }, { activity: { key: 'outdoor_play' } }), lightningEvent())['PUBLIC-02'].activityKey, 'outdoor_play');
  assert.ok(run(makeSubscriber('student_public', { outdoorPlay: true }), lightningEvent())['PUBLIC-02'].actions.includes('wait_30'));
});

test('PUBLIC-03: only people who chose heat guidance and have no occupation heat rule of their own', () => {
  const student = makeSubscriber('student_public', {}, { isHeatSensitive: true });
  assert.equal(run(student, heatEvent(26))['PUBLIC-03'].severity, 'ADVISORY');
  assert.equal(run(student, heatEvent(28))['PUBLIC-03'].severity, 'WARNING');
  assert.equal(run(makeSubscriber('student_public'), heatEvent(29))['PUBLIC-03'], undefined, 'not selected');
  const farmer = makeSubscriber('farmer', {}, { isHeatSensitive: true });
  assert.equal(run(farmer, heatEvent(29))['PUBLIC-03'], undefined, 'a sensitive farmer gets one heat alert (FARM-05), not two');
  assert.ok(run(farmer, heatEvent(29))['FARM-05']);
  assert.ok(run(makeSubscriber('fisherman', { waterBody: 'river' }, { isHeatSensitive: true }), heatEvent(29))['PUBLIC-03']);
});

// ---------- rickshaw pullers and day labourers ----------
test('WORK-01 with WORK-02 and WORK-05 as extras: one heat message, traceable to every rule that shaped it', () => {
  const thana = makeSubscriber('rickshaw_labourer', { shiftStart: '07:00', shiftEnd: '19:00', workload: 'heavy' });
  const result = run(thana, heatEvent(24))['WORK-01'];
  assert.equal(result.severity, 'ADVISORY');
  assert.deepEqual(result.evidence.relatedRules, ['WORK-02', 'WORK-05'], 'a city thana and a 12 hour heavy shift');
  assert.equal(run(thana, heatEvent(26))['WORK-01'].severity, 'WARNING');

  const rural = makeSubscriber('rickshaw_labourer', { shiftStart: '08:00', shiftEnd: '15:00', workload: 'heavy' }, { home: SAVAR });
  const ruralResult = run(rural, heatEvent(24, 'wbgt', { upazilas: [SAVAR] }))['WORK-01'];
  assert.deepEqual(ruralResult.evidence.relatedRules, [], 'no urban note and a 7 hour shift');
  assert.equal(ruralResult.advice.length, 1);

  assert.equal(run(makeSubscriber('rickshaw_labourer', { shiftStart: '20:00', shiftEnd: '23:00' }), heatEvent(29))['WORK-01'], undefined, 'the shift is after the heat');
});

test('WORK-03: a thunderstorm on the road is CRITICAL, and anyone who says they are on the road is covered', () => {
  assert.equal(run(makeSubscriber('rickshaw_labourer', { outdoorExposure: 'on_road' }), lightningEvent())['WORK-03'].severity, 'CRITICAL');
  assert.equal(run(makeSubscriber('rickshaw_labourer', { outdoorExposure: 'mixed' }), lightningEvent())['WORK-03'].severity, 'CRITICAL');
  assert.equal(run(makeSubscriber('rickshaw_labourer', { outdoorExposure: 'open_site' }), lightningEvent())['WORK-03'], undefined);
  const farmer = run(makeSubscriber('farmer', {}, { activity: { key: 'on_road' } }), lightningEvent());
  assert.equal(farmer['WORK-03'].activityKey, 'on_road');
  assert.equal(farmer['FARM-04'].severity, 'CRITICAL', 'and the farmer still gets the field warning: hazards stay visible');
  assert.ok(run(makeSubscriber('rickshaw_labourer', { outdoorExposure: 'on_road' }), lightningEvent())['WORK-03'].actions.includes('avoid_trees'));
});

test('WORK-04: rain during the shift is an advisory with no flooding claim', () => {
  const shift = makeSubscriber('rickshaw_labourer', { shiftStart: '09:00', shiftEnd: '18:00' });
  const result = run(shift, rainEvent(1))['WORK-04'];
  assert.equal(result.severity, 'ADVISORY');
  assert.equal(result.evidence.floodClaim, false);
  assert.equal(run(makeSubscriber('rickshaw_labourer', { shiftStart: '22:00', shiftEnd: '06:00' }), rainEvent(1))['WORK-04'], undefined);
});

// ---------- location, scope and catalogue coverage ----------
test('a district-wide event reaches every area in that district, and an upazila event only its own', () => {
  const districtEvent = rainEvent(1, { upazilas: [], districts: [DHAKA], scope: 'district' });
  assert.ok(run(makeSubscriber('farmer', {}, { home: SAVAR }), districtEvent)['FARM-01']);
  assert.ok(run(makeSubscriber('farmer', {}, { home: BADDA }), districtEvent)['FARM-01']);
  assert.equal(run(makeSubscriber('farmer', {}, { home: AMTALI }), districtEvent)['FARM-01'], undefined);
  assert.equal(run(makeSubscriber('farmer', {}, { home: SAVAR }), rainEvent(1))['FARM-01'], undefined, 'an upazila event is not widened to a district');
});

test('a farmer is matched through the field area, not just the home area', () => {
  const farmer = makeSubscriber('farmer', { fieldAreaPcode: SAVAR }, { home: BADDA });
  assert.equal(run(farmer, rainEvent(1, { upazilas: [BADDA] }))['FARM-01'], undefined, 'home is not the place the crop is in');
  assert.ok(run(farmer, rainEvent(1, { upazilas: [SAVAR] }))['FARM-01']);
});

test('the catalogue rule IDs that are implemented as scenarios', () => {
  assert.deepEqual([...scenarioIds].sort(), [
    'CONS-01', 'CONS-02', 'CONS-03', 'CONS-04', 'FARM-01', 'FARM-02', 'FARM-03', 'FARM-04', 'FARM-05', 'FISH-01', 'FISH-02', 'FISH-03', 'FISH-04',
    'PUBLIC-01', 'PUBLIC-02', 'PUBLIC-03', 'PUBLIC-06', 'VEND-01', 'VEND-02', 'VEND-03', 'WORK-01', 'WORK-03', 'WORK-04',
  ]);
});

test('composing a notification carries every field the plan requires, in both languages', () => {
  const farmer = makeSubscriber('farmer', { cropStage: 'harvesting' });
  const event = rainEvent(2, { from: 1 });
  const [{ scenario, area, result }] = evaluateSubscriber({ subscriber: farmer, event, nowMs: NOW });

  for (const lang of ['en', 'bn']) {
    const content = composeNotification({ scenarioId: scenario.id, result, event, subscriber: farmer, area, nowMs: NOW, lang });
    assert.equal(content.scenarioId, 'FARM-01');
    assert.equal(content.severity, 'WARNING');
    assert.ok(content.title && content.message && content.reasonForSelection, lang);
    assert.ok(content.recommendedActions.length > 0);
    assert.equal(content.affectedArea.scope, 'upazila');
    assert.equal(content.affectedArea.upazilaPcode, BADDA);
    assert.equal(content.sourceReferences[0].provider, 'open-meteo');
    assert.equal(content.ruleVersion, 'prototype-1');
    assert.equal(content.ruleStatus, 'prototype');
    assert.equal(content.origin, 'automatic');
    assert.equal(content.hazardType, 'HEAVY_RAIN');
    assert.ok(+new Date(content.validUntil) > +new Date(content.validFrom));
    assert.equal(content.evidence.rule.status, 'prototype');
  }
});
