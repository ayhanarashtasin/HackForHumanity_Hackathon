import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeNotification } from '../src/services/alerts/compose.js';
import { attachForecastConfidence, confidenceInput, fetchConfidence, resetConfidenceCoolOff } from '../src/services/alerts/forecastConfidence.js';
import { detectHeavyRain } from '../src/services/alerts/hazards.js';
import { confidenceLine } from '../src/services/alerts/messages.js';
import { evaluateSubscriber } from '../src/services/alerts/scenarios/index.js';
import { renderMessage } from '../src/services/delivery/format.js';
import { BADDA, HOUR, NOW, emptyArea, makeSubscriber, rainEvent, rainSeries } from './support/alertFixtures.js';

const ML_URL = 'http://ml.test';

// The Open-Meteo cache as weatherStore holds it: 3-hour steps and per-location columns.
function openMeteo({ rh = 88, cape = 1800 } = {}) {
  const steps = Array.from({ length: 10 }, (_, i) => new Date(NOW + i * 3 * HOUR).toISOString());
  return { data: { steps, locations: { [BADDA]: { rh: steps.map(() => rh), cape: steps.map((_, i) => (i === 2 ? cape : 300)) } } } };
}

const heavyArea = (provider = 'open-meteo') => emptyArea({ rain: [rainSeries([10, 30, 8, 5, 2, 0, 0, 0], { provider })] });

function reply(items, { ok = true, version = 'heavy-rain-rf-test' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status: ok ? 200 : 503, json: async () => ({ model_version: version, items }) };
  };
  return { fetchImpl, calls };
}

test('only Level 2+ heavy rain from Open-Meteo is sent to the model, with the rule\'s own amounts', () => {
  const sources = { openMeteo: openMeteo() };
  const detection = detectHeavyRain(heavyArea(), NOW);
  assert.equal(detection.level, 2);

  const input = confidenceInput(detection, heavyArea(), sources, NOW);
  assert.deepEqual(
    { id: input.id, lead: input.lead_day, rain24: input.rain24_mm, rain3h: input.rain3h_max_mm, rh: input.rh_mean, cape: input.cape_max },
    { id: BADDA, lead: 0, rain24: detection.evidence.metrics.rain24hMm, rain3h: detection.evidence.metrics.rain3hMm, rh: 88, cape: 1800 },
  );
  assert.match(input.date, /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(confidenceInput(detectHeavyRain(heavyArea('xweather'), NOW), heavyArea(), sources, NOW), null, 'the model only knows Open-Meteo');
  assert.equal(confidenceInput({ ...detection, level: 1 }, heavyArea(), sources, NOW), null);
  assert.equal(confidenceInput({ ...detection, hazardType: 'STRONG_WIND' }, heavyArea(), sources, NOW), null);
  assert.equal(confidenceInput(detection, heavyArea(), { openMeteo: { data: { steps: [], locations: {} } } }, NOW), null, 'no humidity, no input');
});

test('the service is optional: off, failing or slow means no label and no error', async () => {
  resetConfidenceCoolOff();
  const input = [{ id: BADDA }];

  const off = reply([{ id: BADDA, band: 'high' }]);
  assert.equal((await fetchConfidence(input, { fetchImpl: off.fetchImpl, nowMs: NOW, url: '' })).size, 0);
  assert.equal(off.calls.length, 0);

  const down = reply([], { ok: false });
  assert.equal((await fetchConfidence(input, { fetchImpl: down.fetchImpl, nowMs: NOW, url: ML_URL })).size, 0);
  const later = reply([{ id: BADDA, band: 'high' }]);
  assert.equal((await fetchConfidence(input, { fetchImpl: later.fetchImpl, nowMs: NOW + 60_000, url: ML_URL })).size, 0);
  assert.equal(later.calls.length, 0, 'a failure pauses the service so a dead service cannot slow every tick');
  assert.equal((await fetchConfidence(input, { fetchImpl: later.fetchImpl, nowMs: NOW + 10 * 60_000, url: ML_URL })).get(BADDA).band, 'high');

  resetConfidenceCoolOff();
  const odd = reply([{ id: BADDA, band: 'certain' }, { id: 7, band: 'high' }]);
  assert.equal((await fetchConfidence(input, { fetchImpl: odd.fetchImpl, nowMs: NOW, url: ML_URL })).size, 0, 'unknown bands are ignored');
});

test('a tick sends one batch and labels the matching detection', async () => {
  resetConfidenceCoolOff();
  const area = heavyArea();
  const detection = detectHeavyRain(area, NOW);
  const { fetchImpl, calls } = reply([{ id: BADDA, band: 'medium', risk_score: 0.81, predicted_class: 1 }]);
  const process = await import('../src/config/env.js');
  const saved = process.env.alerts.mlServiceUrl;
  process.env.alerts.mlServiceUrl = ML_URL;
  try {
    const attached = await attachForecastConfidence([{ area, detections: [detection] }], { sources: { openMeteo: openMeteo() }, nowMs: NOW, fetchImpl });
    assert.equal(attached, 1);
  } finally {
    process.env.alerts.mlServiceUrl = saved;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ML_URL}/predict`);
  assert.equal(calls[0].body.items.length, 1);
  assert.deepEqual(
    { band: detection.evidence.forecastConfidence.band, score: detection.evidence.forecastConfidence.riskScore, version: detection.evidence.forecastConfidence.modelVersion },
    { band: 'medium', score: 0.81, version: 'heavy-rain-rf-test' },
  );
});

function composeRain(evidence, lang) {
  const subscriber = makeSubscriber('farmer', { cropStage: 'harvesting', workload: 'heavy', outdoorHours: 'gt8' }, { language: lang });
  const event = rainEvent(2, { from: 1, evidence });
  const entry = evaluateSubscriber({ subscriber, event, nowMs: NOW }).find((item) => item.scenario.id === 'FARM-01');
  return composeNotification({ scenarioId: 'FARM-01', result: entry.result, event, subscriber, area: entry.area, nowMs: NOW, lang });
}

test('the alert text is unchanged and gains one last confidence line', () => {
  for (const lang of ['en', 'bn']) {
    const plain = composeRain({}, lang);
    const labelled = composeRain({ forecastConfidence: { band: 'high', riskScore: 0.9, modelVersion: 'v' } }, lang);
    assert.equal(labelled.message, `${plain.message}\n${confidenceLine('high', lang)}`);
    assert.equal(plain.message.includes('\n'), false);
    assert.equal(labelled.title, plain.title);
    assert.deepEqual(labelled.evidence.forecastConfidence, { band: 'high', modelVersion: 'v' }, 'no raw score on the notification');
  }
  assert.equal(confidenceLine('high', 'bn'), 'পূর্বাভাসের নির্ভরযোগ্যতা: উচ্চ।');
  assert.equal(confidenceLine('medium', 'bn'), 'পূর্বাভাসের নির্ভরযোগ্যতা: মাঝারি।');
  assert.equal(confidenceLine('low', 'en'), 'Forecast confidence: Low.');
  assert.equal(confidenceLine(undefined, 'en'), '');
  assert.doesNotMatch(composeRain({ forecastConfidence: { band: 'low' } }, 'en').message.split('\n').at(-1), /\d|%/, 'never a number or a percentage');
});

test('every channel carries the line: Telegram on its own line, WhatsApp flat, SMS when it fits', () => {
  for (const lang of ['en', 'bn']) {
    const notification = { ...composeRain({ forecastConfidence: { band: 'low', modelVersion: 'v' } }, lang), origin: 'automatic' };
    const line = confidenceLine('low', lang);

    assert.ok(renderMessage('telegram', notification, { nowMs: NOW }).text.includes(`\n${line}`));

    const { parts } = renderMessage('whatsapp', notification, { nowMs: NOW });
    assert.equal(parts.some((part) => /\n/.test(part)), false);
    assert.ok(parts[2].includes(line));

    const sms = renderMessage('sms', notification, { nowMs: NOW, siteUrl: 'https://akashsathi.example' }).text;
    assert.ok(sms.length <= (lang === 'bn' ? 200 : 320));
    assert.ok(sms.includes(`${line.replace(/[.।]$/, '')}. `), `${lang} SMS: ${sms}`);
    assert.equal(sms.includes('।.'), false, 'no doubled full stop');
  }
});
