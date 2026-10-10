import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  airTempClass, detectAreaHazards, detectDrySpell, detectHeat, detectHeavyRain, detectMarine, detectWind, primaryStatus, rain3hMax,
} from '../src/services/alerts/hazards.js';
import {
  HOUR, NOW, emptyArea, period, rainSeries, threeHourly,
} from './support/alertFixtures.js';

const rainArea = (...series) => emptyArea({ rain: series });
const level = (area) => detectHeavyRain(area, NOW)?.level ?? 0;

test('the wettest 3 hours are found for hourly and 3-hourly forecasts alike', () => {
  assert.equal(rain3hMax(rainSeries([5, 9, 2]).periods), 9, 'each 3 h period stands for 3 hours');
  const hourly = [1, 4, 5, 6, 0, 0].map((mm, i) => period(i, 1, { mm }));
  assert.equal(rain3hMax(hourly), 15, '4 + 5 + 6 over three consecutive hours');
  assert.equal(rain3hMax([]), 0);
});

test('heavy rain levels sit exactly on the configured edges (3 h and 24 h amounts, probability)', () => {
  // L1: rain3h >= 7.5 mm and (probability >= 50 or unknown)
  assert.equal(level(rainArea(rainSeries([7.4], { pops: [90] }))), 0);
  assert.equal(level(rainArea(rainSeries([7.5], { pops: [90] }))), 1);
  assert.equal(level(rainArea(rainSeries([7.5], { pops: [49] }))), 0, 'a likely-dry forecast does not qualify');
  assert.equal(level(rainArea(rainSeries([7.5], { pops: [50] }))), 1);
  assert.equal(level(rainArea(rainSeries([7.5]))), 1, 'no probability available: the amount alone decides');
  // L2: 3 h >= 23 mm or 24 h >= 44 mm. L3: 3 h >= 50 mm or 24 h >= 89 mm.
  assert.equal(level(rainArea(rainSeries([22.9]))), 1);
  assert.equal(level(rainArea(rainSeries([23]))), 2);
  assert.equal(level(rainArea(rainSeries([14, 15, 14, 1]))), 2, '44 mm over 24 h');
  assert.equal(level(rainArea(rainSeries([14, 14, 14, 1]))), 1, '43 mm over 24 h is only moderately heavy');
  assert.equal(level(rainArea(rainSeries([49.9]))), 2);
  assert.equal(level(rainArea(rainSeries([50]))), 3);
  assert.equal(level(rainArea(rainSeries([22, 22, 22, 23]))), 3, '89 mm over 24 h');
  assert.equal(level(rainArea(rainSeries([0, 0, 0, 0]))), 0);
});

test('only the next 24 hours count', () => {
  assert.equal(level(rainArea(rainSeries([30], { startHours: 30 }))), 0, 'too far ahead');
  assert.equal(level(rainArea(rainSeries([30], { startHours: -6 }))), 0, 'already over');
  assert.equal(level(rainArea(rainSeries([30], { startHours: -2 }))), 2, 'still running');
});

test('a rain event reports its window, metrics, source and rule version', () => {
  const detection = detectHeavyRain(rainArea(rainSeries([0, 12, 14, 0], { pops: [20, 80, 90, 30] })), NOW);
  assert.equal(detection.hazardType, 'HEAVY_RAIN');
  assert.equal(detection.level, 1, '26 mm over 24 h is below 44 mm and the wettest 3 h is 14 mm, below 23 mm');
  assert.equal(detection.window.fromMs, NOW + 3 * HOUR);
  assert.equal(detection.window.untilMs, NOW + 9 * HOUR);
  assert.equal(detection.evidence.metrics.popPercent, 90);
  assert.equal(detection.evidence.rule.status, 'prototype');
  assert.equal(detection.evidence.rule.version, 'prototype-1');
  assert.equal(detection.source.provider, 'open-meteo');
});

test('BMD rainfall with an unconfirmed unit is never the source of an amount', () => {
  const bmd = rainSeries([60], { provider: 'bmd', unitVerified: false });
  assert.equal(detectHeavyRain(rainArea(bmd), NOW), null, 'BMD alone cannot create a rain event');

  const detection = detectHeavyRain(rainArea(rainSeries([8], { pops: [80] }), bmd), NOW);
  assert.equal(detection.level, 1);
  assert.equal(detection.source.provider, 'open-meteo');
  assert.equal(detection.evidence.agreement, 'single-source', 'the unverified provider does not count towards agreement');
  assert.equal(detection.evidence.alternatives[0].provider, 'bmd');
  assert.equal(detection.evidence.alternatives[0].unitVerified, false);

  const verified = detectHeavyRain(rainArea(bmd.periods && { ...bmd, unitVerified: true }), NOW);
  assert.equal(verified.level, 3, 'once the unit is confirmed BMD can be used');
});

test('sources are compared, never averaged: agree, differ or single source', () => {
  const agree = detectHeavyRain(rainArea(rainSeries([30], { provider: 'xweather' }), rainSeries([31])), NOW);
  assert.equal(agree.evidence.agreement, 'agree');
  const differ = detectHeavyRain(rainArea(rainSeries([30], { provider: 'xweather' }), rainSeries([9])), NOW);
  assert.equal(differ.evidence.agreement, 'differ');
  assert.equal(differ.level, 2, 'the preferred fresh source decides');
});

test('a fresh source is preferred over a stale one, and a stale only source is reported as stale', () => {
  const stale = rainSeries([40], { provider: 'xweather', status: 'STALE' });
  const fresh = rainSeries([8]);
  assert.equal(detectHeavyRain(rainArea(stale, fresh), NOW).source.provider, 'open-meteo');
  const onlyStale = detectHeavyRain(rainArea(stale), NOW);
  assert.equal(onlyStale.dataStatus, 'STALE', 'the engine will refuse to create or escalate from this');
  assert.equal(primaryStatus(rainArea(stale), 'HEAVY_RAIN'), 'STALE');
  assert.equal(primaryStatus(rainArea(), 'HEAVY_RAIN'), null);
});

const heatArea = (indicator, values, { provider = 'xweather', status = 'FRESH', airTemp = [] } = {}) => emptyArea({
  heat: [{ provider, product: 'p', indicator, status, periods: threeHourly(0, values) }],
  airTemp: threeHourly(0, airTemp),
});

test('heat stress levels follow WBGT (23 / 28 / 31) and the computed heat index (27 / 32 / 39)', () => {
  const wbgt = (value) => detectHeat(heatArea('wbgt', [value]), NOW)?.level ?? 0;
  assert.deepEqual([22.9, 23, 27.9, 28, 30.9, 31].map(wbgt), [0, 1, 1, 2, 2, 3]);
  const index = (value) => detectHeat(heatArea('heat_index', [value], { provider: 'bmd' }), NOW)?.level ?? 0;
  assert.deepEqual([26.9, 27, 31.9, 32, 38.9, 39].map(index), [0, 1, 1, 2, 2, 3]);
});

test('heat events record the peak, the indicator, BMD heat-wave class and mark a heat-index fallback as partial', () => {
  const detection = detectHeat(heatArea('heat_index', [20, 33, 36, 30], { provider: 'bmd', airTemp: [30, 36.5, 38.5, 33] }), NOW);
  assert.equal(detection.level, 2);
  assert.equal(detection.evidence.metrics.indicator, 'heat_index');
  assert.equal(detection.evidence.metrics.peakValueC, 36);
  assert.equal(detection.evidence.metrics.peakStartMs, NOW + 6 * HOUR);
  assert.equal(detection.evidence.metrics.airTempMaxC, 38.5);
  assert.equal(detection.evidence.metrics.airTempClass, 'moderate');
  assert.equal(detection.dataStatus, 'PARTIAL', 'a computed index is usable but not the preferred WBGT');
  assert.equal(detection.window.fromMs, NOW + 3 * HOUR, 'the run of periods at or above level 1 around the peak');
  assert.equal(detection.window.untilMs, NOW + 12 * HOUR, 'the last period (30) is still above level 1');
  assert.equal(detectHeat(heatArea('wbgt', [24]), NOW).dataStatus, 'FRESH');
});

test('BMD heat-wave classes are recorded as evidence only', () => {
  assert.deepEqual([35.9, 36, 37.9, 38, 39.9, 40, 41.9, 42].map(airTempClass), [null, 'mild', 'mild', 'moderate', 'moderate', 'severe', 'severe', 'very_severe']);
  assert.equal(airTempClass(null), null);
});

test('WBGT beats the heat index when both are fresh', () => {
  const area = emptyArea({
    heat: [
      { provider: 'xweather', product: 'p', indicator: 'wbgt', status: 'FRESH', periods: threeHourly(0, [29]) },
      { provider: 'bmd', product: 'p', indicator: 'heat_index', status: 'FRESH', periods: threeHourly(0, [40]) },
    ],
  });
  const detection = detectHeat(area, NOW);
  assert.equal(detection.evidence.metrics.indicator, 'wbgt');
  assert.equal(detection.level, 2);
});

test('strong gusts follow 40 / 60 / 80 km/h within the next 12 hours', () => {
  const wind = (...values) => detectWind(emptyArea({ gust: [{ provider: 'bmd', product: 'p', status: 'FRESH', periods: threeHourly(0, values) }] }), NOW)?.level ?? 0;
  assert.deepEqual([39.9, 40, 59.9, 60, 79.9, 80].map((value) => wind(value)), [0, 1, 1, 2, 2, 3]);
  assert.equal(wind(10, 10, 10, 10, 90), 0, 'the fifth period starts after 12 hours');
  const detection = detectWind(emptyArea({ gust: [{ provider: 'bmd', product: 'p', status: 'FRESH', periods: threeHourly(0, [30, 62]) }] }), NOW);
  assert.equal(detection.evidence.metrics.maxGustKph, 62);
  assert.equal(detection.window.fromMs, NOW + 3 * HOUR);
});

test('marine weather combines wave height and gusts and reports partial data honestly', () => {
  const periods = [period(0, 6, { waveM: 1.4, gustKph: 30 }), period(6, 6, { waveM: 2.2, gustKph: 45 })];
  const detection = detectMarine({ periods, status: 'FRESH' }, NOW);
  assert.equal(detection.level, 2, 'waves of 2.2 m reach level 2');
  assert.equal(detection.evidence.metrics.maxWaveM, 2.2);
  assert.equal(detection.hazardType, 'MARINE_WEATHER');
  assert.equal(detection.evidence.coverage, 'regional');
  assert.equal(detectMarine({ periods: [period(0, 6, { waveM: 0.8, gustKph: 52 })], status: 'FRESH' }, NOW).level, 2, 'gusts alone can set the level');
  assert.equal(detectMarine({ periods: [period(0, 6, { waveM: 0.8, gustKph: 10 })], status: 'FRESH' }, NOW).level, 0);
  assert.equal(detectMarine({ periods: [period(0, 6, { waveM: 3.1, gustKph: null })], status: 'FRESH' }, NOW).dataStatus, 'PARTIAL');
  assert.equal(detectMarine({ periods: [], status: 'FRESH' }, NOW), null);
});

const dailyArea = (days, { verified = false, status = 'FRESH' } = {}) => emptyArea({
  daily: {
    provider: 'bmd', product: 'wrf-daily', status, rainUnitVerified: verified,
    days: days.map(([rainMm, tmaxC], i) => ({ startMs: Date.parse('2026-10-10T18:00:00Z') + i * 24 * HOUR, rainMm, tmaxC })),
  },
});

test('a dry spell needs seven forecast dry days and hot weather, and never says drought', () => {
  const dry = Array.from({ length: 8 }, () => [0, 33]);
  const detection = detectDrySpell(dailyArea(dry), NOW);
  assert.equal(detection.level, 1);
  assert.equal(detection.evidence.metrics.dryDays, 8);
  assert.equal(detection.evidence.forecastOnly, true);
  assert.equal(detection.dataStatus, 'PARTIAL', 'BMD rainfall unit is unconfirmed');

  assert.equal(detectDrySpell(dailyArea(Array.from({ length: 6 }, () => [0, 33])), NOW), null, 'six days is not enough');
  assert.equal(detectDrySpell(dailyArea(Array.from({ length: 8 }, () => [0, 31])), NOW), null, 'cool weather');
  assert.equal(detectDrySpell(dailyArea([[0, 33], [0, 33], [0, 33], [4, 33], ...Array.from({ length: 5 }, () => [0, 33])]), NOW), null, 'a wet day breaks the run');
});

test('until the BMD unit is confirmed only an exact zero counts as dry; afterwards the 2.5 mm line applies', () => {
  const light = Array.from({ length: 8 }, () => [1.2, 33]);
  assert.equal(detectDrySpell(dailyArea(light), NOW), null);
  const verified = detectDrySpell(dailyArea(light, { verified: true }), NOW);
  assert.equal(verified.evidence.metrics.dryDays, 8);
  assert.equal(verified.dataStatus, 'FRESH');
});

test('area detection returns only real hazards with a window', () => {
  const area = emptyArea({
    rain: [rainSeries([8], { pops: [80] })],
    heat: [{ provider: 'bmd', product: 'p', indicator: 'heat_index', status: 'FRESH', periods: threeHourly(0, [20]) }],
    gust: [{ provider: 'bmd', product: 'p', status: 'FRESH', periods: threeHourly(0, [10]) }],
  });
  const detections = detectAreaHazards(area, NOW);
  assert.deepEqual(detections.map((item) => item.hazardType), ['HEAVY_RAIN']);
  assert.deepEqual(detectAreaHazards(emptyArea(), NOW), []);
});
