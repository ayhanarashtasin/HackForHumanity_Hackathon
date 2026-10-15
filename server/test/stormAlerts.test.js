import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hazardRules } from '../src/config/alertRules.js';
import { env } from '../src/config/env.js';
import { composeNotification } from '../src/services/alerts/compose.js';
import { decideProbe } from '../src/services/alerts/lightningGate.js';
import { evaluateSubscriber } from '../src/services/alerts/scenarios/index.js';
import { stormEpisodeState } from '../src/services/alerts/stormEpisodes.js';
import { hazardAllowsChannel, skipsQuietHours } from '../src/services/delivery/policy.js';
import {
  approaching, stormArrivals, stormDataStatus, stormNear, stormReach, warnableCell, withArrivals,
} from '../src/services/stormOutlook.js';
import {
  BADDA, DHAKA, HOUR, NOW, SAVAR, makeSubscriber, stormEvent,
} from './support/alertFixtures.js';

// Satellite storm-approach warnings (stormOutlook.js, stormEpisodes.js, scenario PUBLIC-06, delivery policy). Pure: no database.
const MINUTE = 60_000;
const cell = (reaches, extra = {}) => ({
  id: 'c1', intensity: 6, trend: 'growing', minTempC: -78.2, areaKm2: 8062, motion: { speedKmh: 24.9, towards: 'S', bearingDeg: 180 }, reaches, ...extra,
});
// An image taken 15 minutes before NOW, like a NOAA frame.
const snapshot = (cells, ageMinutes = 15) => ({ observedAtMs: NOW - ageMinutes * MINUTE, cells });

test('outlook: arrival times are counted from now, not from the image, and the soonest cell wins', () => {
  const snap = snapshot([
    cell([{ pcode: BADDA, etaMin: 60 }, { pcode: SAVAR, etaMin: 0 }]),
    cell([{ pcode: BADDA, etaMin: 40 }], { id: 'c2' }),
  ]);
  const hits = stormReach(snap, [BADDA, SAVAR, '999999'], NOW);
  assert.equal(hits.get(BADDA).minutesFromNow, 25, 'the 40-minute cell on a 15-minute-old image arrives 25 minutes from now');
  assert.equal(hits.get(BADDA).cell.id, 'c2');
  assert.equal(hits.get(SAVAR).over, true);
  assert.equal(hits.has('999999'), false);
  assert.equal(stormReach(null, [BADDA], NOW).size, 0);
});

test('outlook: the map\'s arrivals are exactly the places the rule would warn, soonest first, with the reference time', () => {
  const snap = snapshot([
    cell([{ pcode: BADDA, etaMin: 40 }, { pcode: SAVAR, etaMin: 70 }, { pcode: '302650', etaMin: 0 }]),
    cell([{ pcode: '100409', etaMin: 30 }], { id: 'c2', trend: 'weakening' }),
  ]);
  const arrivals = stormArrivals(snap, NOW);
  assert.deepEqual(arrivals.map((arrival) => [arrival.pcode, arrival.minutesFromNow, arrival.soon]), [[BADDA, 25, true], [SAVAR, 55, false]]);
  assert.equal(arrivals[0].arrivalAt, new Date(NOW + 25 * MINUTE).toISOString());
  assert.deepEqual(stormArrivals(snapshot([cell([{ pcode: BADDA, etaMin: 40 }])], 70), NOW), [], 'a stale image shades nothing');

  const sent = withArrivals({ observedAt: new Date(snap.observedAtMs).toISOString(), cells: snap.cells }, NOW);
  assert.equal(sent.arrivalsAt, new Date(NOW).toISOString());
  assert.equal(sent.arrivals.length, 2);
  assert.equal(withArrivals(null, NOW), null);
});

test('outlook: an image is usable for an hour, then STALE; no image is UNAVAILABLE', () => {
  assert.equal(stormDataStatus(snapshot([], 15), NOW), 'FRESH');
  assert.equal(stormDataStatus(snapshot([], hazardRules.STORM_APPROACH.maxImageAgeMinutes + 1), NOW), 'STALE');
  assert.equal(stormDataStatus(null, NOW), 'UNAVAILABLE');
});

test('outlook: only cold, moving, not-weakening cells warn, inside the window, and never for a place already under the cell', () => {
  assert.equal(warnableCell(cell([])), true);
  assert.equal(warnableCell(cell([], { intensity: 4 })), false, 'class 4 (-58 C) is shown on the map only');
  assert.equal(warnableCell(cell([], { trend: 'weakening' })), false);
  assert.equal(warnableCell(cell([], { motion: null })), false);

  const at = (minutesFromNow, over = false) => ({ minutesFromNow, over });
  assert.equal(approaching(at(45)), true);
  assert.equal(approaching(at(-10)), true, 'arrived 10 minutes ago: not yet warned, still worth it');
  assert.equal(approaching(at(-11)), false);
  assert.equal(approaching(at(61)), false);
  assert.equal(approaching(at(-15, true)), false, 'already under the cell on the image: the lightning checks take over');
  assert.equal(stormNear(at(-15, true)), true, 'but it does open the lightning gate');
  assert.equal(stormNear(at(80)), false);
});

test('episode: level 3 within 30 minutes, never lower than before, valid until an hour after the arrival', () => {
  const hit = (minutesFromNow) => ({ over: false, minutesFromNow, arrivalMs: NOW + minutesFromNow * MINUTE, cell: cell([]) });
  const far = stormEpisodeState({ hit: hit(45), nowMs: NOW, observedAtMs: NOW - 15 * MINUTE });
  assert.equal(far.level, 2);
  assert.equal(far.untilMs, NOW + 105 * MINUTE);
  assert.deepEqual(far.evidence.metrics, { arrivalAtMs: NOW + 45 * MINUTE, minTempC: -78.2 });
  assert.equal(far.evidence.rule.key, 'STORM_APPROACH.L2');

  const soon = stormEpisodeState({ hit: hit(20), previous: far.evidence, nowMs: NOW + 5 * MINUTE, observedAtMs: NOW });
  assert.equal(soon.level, 3);
  assert.equal(soon.startMs, NOW, 'the episode keeps its start');
  const slower = stormEpisodeState({ hit: hit(50), previous: soon.evidence, nowMs: NOW + 10 * MINUTE, observedAtMs: NOW });
  assert.equal(slower.level, 3, 'a warning is not toned down by one frame');
  assert.ok(slower.untilMs >= soon.untilMs);

  assert.equal(stormEpisodeState({ hit: undefined, nowMs: NOW }), null);
  assert.equal(stormEpisodeState({ hit: { ...hit(-20), over: true }, nowMs: NOW }), null);
});

test('PUBLIC-06: everyone with an area in the path is warned, with advice for their occupation', () => {
  const event = stormEvent(2);
  const adviceOf = (subscriber) => evaluateSubscriber({ subscriber, event, nowMs: NOW }).find((entry) => entry.scenario.id === 'PUBLIC-06')?.result;
  const cases = [
    [makeSubscriber('farmer'), 'storm_field'],
    [makeSubscriber('fisherman', { waterBody: 'river' }), 'storm_departure'],
    [makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water', since: NOW - HOUR, expiresAt: NOW + HOUR } }), 'storm_water'],
    [makeSubscriber('construction'), 'storm_site'],
    [makeSubscriber('vendor'), 'storm_stall'],
    [makeSubscriber('rickshaw_labourer'), 'storm_road'],
    [makeSubscriber('student_public'), 'storm_public'],
  ];
  for (const [subscriber, key] of cases) {
    const result = adviceOf(subscriber);
    assert.equal(result?.severity, 'WARNING', subscriber.occupation);
    assert.equal(result.advice[0].key, key, subscriber.occupation);
  }
  assert.equal(adviceOf(makeSubscriber('farmer', {}, { home: SAVAR })), undefined, 'not for an area the storm is not heading for');
  assert.equal(evaluateSubscriber({ subscriber: makeSubscriber('farmer'), event: stormEvent(2, { from: -2, until: -0.5 }), nowMs: NOW }).length, 0, 'not after it ended');
});

test('PUBLIC-06: a shared live location counts, wherever the saved areas are', () => {
  const traveller = { ...makeSubscriber('vendor', {}, { home: SAVAR }), currentArea: { upazilaPcode: BADDA, districtPcode: DHAKA, expiresAt: new Date(NOW + 10 * MINUTE) } };
  const [entry] = evaluateSubscriber({ subscriber: traveller, event: stormEvent(2), nowMs: NOW });
  assert.equal(entry?.area.role, 'current');
});

test('PUBLIC-06: the message gives the image time, the arrival and what the estimate is not', () => {
  const subscriber = makeSubscriber('student_public');
  const event = stormEvent(3);
  const { result, area } = evaluateSubscriber({ subscriber, event, nowMs: NOW })[0];
  const en = composeNotification({ scenarioId: 'PUBLIC-06', result, event, subscriber, area, nowMs: NOW, lang: 'en' });
  assert.equal(en.title, 'Storm may reach Badda within 30 minutes');
  assert.match(en.message, /satellite image of today 09:45 is moving south at about 25 km\/h and may reach Badda, Dhaka around today 10:40/);
  assert.match(en.message, /about -78 °C/);
  assert.match(en.message, /not a lightning observation/);
  assert.deepEqual(en.sourceReferences.map((ref) => ref.provider), ['himawari']);

  const late = stormEvent(3, { metrics: { arrivalAtMs: NOW - 5 * MINUTE, minTempC: null } });
  const lateText = composeNotification({ scenarioId: 'PUBLIC-06', result, event: late, subscriber, area, nowMs: NOW, lang: 'en' }).message;
  assert.match(lateText, /may already be reaching Badda, Dhaka \(expected today 09:55\)/);
  assert.doesNotMatch(lateText, /cloud top/, 'no temperature from a GIBS image');

  const bn = composeNotification({ scenarioId: 'PUBLIC-06', result, event, subscriber, area, nowMs: NOW, lang: 'bn' });
  assert.match(bn.title, /৩০ মিনিটের মধ্যে ঝড়/);
  assert.doesNotMatch(bn.message, /[0-9]/, 'Bengali digits');
});

test('delivery: a storm warning is not held for quiet hours, and goes only to the storm channels (Telegram by default)', () => {
  assert.equal(skipsQuietHours({ severity: 'WARNING', hazardType: 'STORM_APPROACH' }), true);
  assert.equal(skipsQuietHours({ severity: 'CRITICAL', hazardType: 'OBSERVED_LIGHTNING' }), true);
  assert.equal(skipsQuietHours({ severity: 'WARNING', hazardType: 'HEAVY_RAIN' }), false);

  assert.deepEqual(env.channels.stormChannels, ['telegram']);
  assert.equal(hazardAllowsChannel('STORM_APPROACH', 'telegram'), true);
  assert.equal(hazardAllowsChannel('STORM_APPROACH', 'sms'), false);
  assert.equal(hazardAllowsChannel('STORM_APPROACH', 'whatsapp'), false);
  assert.equal(hazardAllowsChannel('STORM_APPROACH', 'sms', ['telegram', 'sms']), true);
  assert.equal(hazardAllowsChannel('HEAVY_RAIN', 'sms'), true, 'other hazards are unchanged');
});

test('lightning gate: a satellite storm opens it, day or night, and says why', () => {
  const base = { nowMs: NOW, lastProbeAttemptMs: null, lastPositiveMs: null, forecastSignal: false, baselineEnabled: false, localHour: 2 };
  assert.deepEqual(decideProbe({ ...base, stormSignal: true }), { gate: 'open', due: true, reasons: ['satellite-storm'] });
  assert.equal(decideProbe(base).gate, 'closed');
});
