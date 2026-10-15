import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeAdminMessage, composeNotification } from '../src/services/alerts/compose.js';
import {
  ACTIONS, ADVICE, fill, localizeDigits, windowText,
} from '../src/services/alerts/messages.js';
import { evaluateSubscriber, scenarioIds } from '../src/services/alerts/scenarios/index.js';
import {
  AMTALI, BADDA, DHAKA, HOUR, NOW, SAVAR, heatEvent, lightningEvent, makeEvent, makeSubscriber, officialEvent, rainEvent, stormEvent, windEvent,
} from './support/alertFixtures.js';

// Style rules from the plan (section 11): no claim that anything is safe, no "all clear", no flooding claims, no certainty.
const BANNED = [
  /\ball[- ]clear\b/i,
  /\b(is|are|will be|was|were)\s+safe\b/i,
  /\bsafe to\b/i,
  /\byou(?:'re| are) safe\b/i,
  /\bguarantee/i,
  /\bflood/i,
  /\bwaterlog/i,
  /\bno (?:risk|danger)\b/i,
  /\bdiagnos(?:ed|is) with\b/i,
];

const dryEvent = () => makeEvent({ hazardType: 'DRY_SPELL', level: 1, from: 0, until: 200, metrics: { dryDays: 9, meanTmaxC: 33 } });
const marineEvent = () => makeEvent({ hazardType: 'MARINE_WEATHER', level: 2, scope: 'marine-zone', upazilas: [], marineZone: 'north_bay', metrics: { maxWaveM: 2.4, maxGustKph: 45 } });

// One subscriber and event for every implemented scenario, so the lint covers the whole catalogue.
function cases() {
  const farmer = (stage) => makeSubscriber('farmer', { cropStage: stage, workload: 'heavy', outdoorHours: 'gt8' }, { language: 'en' });
  return [
    ['FARM-01', farmer('harvesting'), rainEvent(2, { from: 1 })],
    ['FARM-02', farmer('planting'), rainEvent(1)],
    ['FARM-03', makeSubscriber('farmer', { cropStage: 'growing', irrigationAccess: 'none' }), dryEvent()],
    ['FARM-04', farmer('harvesting'), lightningEvent('OBSERVED_LIGHTNING', 3)],
    ['FARM-04', farmer('harvesting'), lightningEvent('LIGHTNING_THREAT', 3)],
    ['FARM-04', farmer('harvesting'), lightningEvent('LIGHTNING_THREAT', 2)],
    ['FARM-05', farmer('harvesting'), heatEvent(27)],
    ['FISH-01', makeSubscriber('fisherman', { waterBody: 'coastal' }), officialEvent()],
    ['FISH-03', makeSubscriber('fisherman', { waterBody: 'marine', marineZone: 'north_bay' }), officialEvent('withdrawal')],
    ['FISH-02', makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'on_water', since: NOW - 8 * HOUR, expiresAt: NOW + HOUR } }), lightningEvent()],
    ['FISH-04', makeSubscriber('fisherman', { waterBody: 'coastal' }, { activity: { key: 'pre_departure' } }), marineEvent()],
    ['FISH-04', makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'on_water' } }), windEvent(3)],
    ['FISH-04', makeSubscriber('fisherman', { waterBody: 'coastal' }), windEvent(2)],
    ['CONS-01', makeSubscriber('construction', { activityType: 'roof' }), lightningEvent()],
    ['CONS-02', makeSubscriber('construction', { workload: 'heavy', ppeHeatBurden: 'heavy' }), heatEvent(27)],
    ['CONS-03', makeSubscriber('construction', { activityType: 'scaffolding' }), windEvent(2)],
    ['VEND-01', makeSubscriber('vendor', { outdoorStall: true }), windEvent(2)],
    ['CONS-04', makeSubscriber('construction', { siteExposure: 'open' }), rainEvent(1)],
    ['VEND-02', makeSubscriber('vendor', { shelterAccess: 'none' }), heatEvent(29)],
    ['VEND-03', { ...makeSubscriber('vendor'), currentArea: { upazilaPcode: SAVAR, districtPcode: DHAKA, expiresAt: new Date(NOW - HOUR) } }, rainEvent(1)],
    ['PUBLIC-01', makeSubscriber('student_public', { commuteStart: '11:00', commuteEnd: '12:00' }), rainEvent(1)],
    ['PUBLIC-02', makeSubscriber('student_public', { outdoorPlay: true }), lightningEvent()],
    ['PUBLIC-03', makeSubscriber('student_public', {}, { isHeatSensitive: true }), heatEvent(27)],
    ['WORK-01', makeSubscriber('rickshaw_labourer', { workload: 'heavy' }), heatEvent(27)],
    ['WORK-03', makeSubscriber('rickshaw_labourer'), lightningEvent()],
    ['WORK-04', makeSubscriber('rickshaw_labourer', { shiftStart: '09:00', shiftEnd: '18:00' }), rainEvent(1)],
    ['PUBLIC-06', farmer('growing'), stormEvent(2)],
    ['PUBLIC-06', makeSubscriber('fisherman', { waterBody: 'river' }, { activity: { key: 'on_water', since: NOW - HOUR, expiresAt: NOW + HOUR } }), stormEvent(3)],
    ['PUBLIC-06', makeSubscriber('vendor'), stormEvent(2, { metrics: { arrivalAtMs: NOW - 5 * 60_000, minTempC: null } })],
    ['PUBLIC-06', makeSubscriber('student_public'), stormEvent(3)],
  ];
}

function composeAll() {
  const out = [];
  for (const [scenarioId, subscriber, event] of cases()) {
    const entry = evaluateSubscriber({ subscriber, event, nowMs: NOW }).find((item) => item.scenario.id === scenarioId);
    assert.ok(entry, `${scenarioId} must apply to its test case`);
    for (const lang of ['en', 'bn']) {
      out.push({ scenarioId, lang, event, content: composeNotification({ scenarioId, result: entry.result, event, subscriber, area: entry.area, nowMs: NOW, lang }) });
    }
  }
  return out;
}

const textsOf = (content) => [content.title, content.message, content.reasonForSelection, ...content.recommendedActions.map((action) => action.text), content.affectedArea.text];

test('the cases cover every implemented scenario', () => {
  assert.deepEqual([...new Set(cases().map(([id]) => id))].sort(), [...scenarioIds].sort());
});

test('no alert, in either language, claims safety, says "all clear", claims flooding or promises anything', () => {
  for (const { scenarioId, lang, content } of composeAll()) {
    for (const text of textsOf(content)) {
      for (const pattern of BANNED) assert.doesNotMatch(text, pattern, `${scenarioId} ${lang}: "${text}"`);
    }
  }
});

test('nothing is left as an unfilled {placeholder}, and every field is present and non-empty', () => {
  for (const { scenarioId, lang, content } of composeAll()) {
    for (const text of textsOf(content)) {
      assert.doesNotMatch(text, /\{\w+\}/, `${scenarioId} ${lang}: ${text}`);
      assert.ok(text.trim().length > 0, `${scenarioId} ${lang}`);
    }
    assert.ok(content.recommendedActions.length >= 1, scenarioId);
    assert.ok(content.sourceReferences.length >= 1, scenarioId);
    assert.ok(['ADVISORY', 'WARNING', 'CRITICAL'].includes(content.severity), scenarioId);
    assert.ok(content.affectedArea.text, scenarioId);
    assert.ok(content.validUntil, scenarioId);
  }
});

test('Bangla alerts use Bengali digits throughout', () => {
  for (const { scenarioId, content } of composeAll().filter((item) => item.lang === 'bn')) {
    for (const text of textsOf(content)) assert.doesNotMatch(text, /[0-9]/, `${scenarioId}: ${text}`);
    assert.match(content.message, /[ঀ-৿]/, `${scenarioId} message is Bangla`);
  }
  assert.equal(localizeDigits('15:30 and 7.5', 'bn'), '১৫:৩০ and ৭.৫');
  assert.equal(localizeDigits('15:30', 'en'), '15:30');
});

test('rain alerts always carry uncertainty; heat alerts never diagnose; lightning is observed or a threat, never both', () => {
  for (const { scenarioId, lang, event, content } of composeAll()) {
    if (event.hazardType === 'HEAVY_RAIN') assert.match(content.message, lang === 'en' ? /uncertain/i : /অনিশ্চয়তা/, scenarioId);
    if (scenarioId === 'FARM-05' && lang === 'en') assert.match(content.message, /urgent medical help/i);
    if (event.hazardType === 'OBSERVED_LIGHTNING' && lang === 'en') {
      assert.match(content.message, /detected/i, scenarioId);
      assert.match(content.message, /does not predict/i, scenarioId);
    }
    if (event.hazardType === 'LIGHTNING_THREAT' && lang === 'en') {
      assert.doesNotMatch(content.message, /\bdetected\b/i, `${scenarioId}: a threat is not an observation`);
      assert.match(content.message, /nowcast/i, scenarioId);
    }
  }
});

test('lightning wording differs by lead time and observed lightning names its distance', () => {
  const farmer = makeSubscriber('farmer');
  const compose = (event) => {
    const entry = evaluateSubscriber({ subscriber: farmer, event, nowMs: NOW }).find((item) => item.scenario.id === 'FARM-04');
    return composeNotification({ scenarioId: 'FARM-04', result: entry.result, event, subscriber: farmer, area: entry.area, nowMs: NOW, lang: 'en' });
  };
  assert.match(compose(lightningEvent('LIGHTNING_THREAT', 3)).message, /within about 30 minutes/);
  assert.match(compose(lightningEvent('LIGHTNING_THREAT', 2)).message, /within the next hour/);
  assert.match(compose(lightningEvent('OBSERVED_LIGHTNING', 2)).message, /8 km from/);
  assert.match(compose(lightningEvent('OBSERVED_LIGHTNING', 2)).title, /^Lightning detected near/);
  assert.match(compose(lightningEvent('LIGHTNING_THREAT', 3)).title, /expected near/);
});

test('a district-wide notice says so and never narrows itself to an upazila', () => {
  const farmer = makeSubscriber('farmer', {}, { home: SAVAR });
  const event = rainEvent(1, { upazilas: [], districts: [DHAKA], scope: 'district' });
  const entry = evaluateSubscriber({ subscriber: farmer, event, nowMs: NOW }).find((item) => item.scenario.id === 'FARM-01');
  const content = composeNotification({ scenarioId: 'FARM-01', result: entry.result, event, subscriber: farmer, area: entry.area, nowMs: NOW, lang: 'en' });
  assert.equal(content.affectedArea.scope, 'district');
  assert.equal(content.affectedArea.upazilaPcode, null);
  assert.match(content.affectedArea.text, /Dhaka district \(district-wide notice\)/);
  assert.doesNotMatch(content.message, /Savar/);
});

test('every alert names who sent it and the rule it came from', () => {
  const [first] = composeAll();
  assert.equal(first.content.origin, 'automatic');
  assert.equal(first.content.ruleStatus, 'prototype');
  assert.equal(first.content.templateKey, first.scenarioId);

  const declared = heatEvent(27, 'wbgt', { origin: 'admin-declared', metrics: null });
  const farmer = makeSubscriber('farmer', { workload: 'heavy' });
  const entry = evaluateSubscriber({ subscriber: farmer, event: declared, nowMs: NOW }).find((item) => item.scenario.id === 'FARM-05');
  const content = composeNotification({ scenarioId: 'FARM-05', result: entry.result, event: declared, subscriber: farmer, area: entry.area, nowMs: NOW, lang: 'en' });
  assert.equal(content.origin, 'admin-declared');
  assert.equal(content.ruleStatus, 'admin');
  assert.match(content.message, /An administrator has declared heat stress/);
  assert.match(content.message, /not detected from weather data/);
  assert.match(content.title, /^Administrator alert/);
});

test('administrator free messages keep the administrator\'s own words and mark a missing Bangla translation', () => {
  const event = makeEvent({ hazardType: 'ADMIN_NOTICE', level: 0, origin: 'admin-message', upazilas: [BADDA] });
  const subscriber = makeSubscriber('vendor', {}, { language: 'bn' });
  const area = subscriber.areas[0];
  const content = composeAdminMessage({
    event, subscriber, area, severity: 'ADVISORY', title: { en: 'Market closed' }, text: { en: 'The market is closed on Friday.' }, actions: ['check_forecast'], referenceUrl: 'https://example.org/notice', nowMs: NOW,
  });
  assert.equal(content.scenarioId, 'ADMIN-MSG');
  assert.equal(content.origin, 'admin-message');
  assert.equal(content.ruleStatus, 'admin');
  assert.match(content.message, /The market is closed on Friday\./);
  assert.match(content.message, /বাংলা অনুবাদ দেওয়া হয়নি/);
  assert.equal(content.sourceReferences[0].provider, 'admin');
  assert.equal(content.sourceReferences[0].url, 'https://example.org/notice');
});

test('time and window wording is relative to now and bilingual', () => {
  assert.equal(windowText(NOW - HOUR, NOW + 5 * HOUR, NOW, 'en'), 'from now until today 15:00');
  assert.equal(windowText(NOW + 3 * HOUR, NOW + 20 * HOUR, NOW, 'en'), 'from today 13:00 until tomorrow 06:00');
  assert.equal(windowText(NOW + 3 * HOUR, NOW + 5 * HOUR, NOW, 'bn'), 'আজ 13:00 থেকে আজ 15:00 পর্যন্ত');
  assert.equal(fill('a {x} b {y}', { x: 1 }), 'a 1 b {y}', 'a missing value stays visible instead of disappearing');
});

test('every advice sentence and action exists in both languages', () => {
  for (const [key, value] of Object.entries(ADVICE)) assert.ok(value.en && value.bn, `ADVICE.${key}`);
  for (const [key, value] of Object.entries(ACTIONS)) assert.ok(value.en && value.bn, `ACTIONS.${key}`);
  for (const [key, value] of Object.entries(ADVICE)) for (const text of [value.en, value.bn]) for (const pattern of BANNED) assert.doesNotMatch(text, pattern, key);
  assert.ok(AMTALI && BADDA);
});
