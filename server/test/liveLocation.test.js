import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateSubscriber } from '../src/services/alerts/scenarios/index.js';
import { matchAreas } from '../src/services/alerts/scenarios/helpers.js';
import { BADDA, NOW, SAVAR, lightningEvent, makeSubscriber, rainEvent } from './support/alertFixtures.js';

test('a travelling road worker matches lightning in the current area without changing saved places', () => {
  const worker = makeSubscriber('rickshaw_labourer', {}, { extra: { currentArea: {
    upazilaPcode: SAVAR, districtPcode: '3026', expiresAt: new Date(NOW + 15 * 60_000),
  } } });
  const event = lightningEvent('OBSERVED_LIGHTNING', 2, { upazilas: [SAVAR] });
  const matches = evaluateSubscriber({ subscriber: worker, event, nowMs: NOW });
  assert.equal(matches.find((item) => item.scenario.id === 'WORK-03')?.area.role, 'current');
  assert.equal(worker.areas[0].upazilaPcode, BADDA);
  assert.equal(evaluateSubscriber({ subscriber: worker, event, nowMs: NOW + 16 * 60_000 }).length, 0);
});

test('field-specific advice never follows a travelling farmer, while saved field advice still works', () => {
  const farmer = makeSubscriber('farmer', {}, { extra: { currentArea: {
    upazilaPcode: SAVAR, districtPcode: '3026', expiresAt: new Date(NOW + 15 * 60_000),
  } } });
  assert.equal(evaluateSubscriber({ subscriber: farmer, event: rainEvent(1, { upazilas: [SAVAR] }), nowMs: NOW }).length, 0);
  assert.ok(evaluateSubscriber({ subscriber: farmer, event: rainEvent(1, { upazilas: [BADDA] }), nowMs: NOW }).length);
  assert.equal(matchAreas(farmer, lightningEvent('OBSERVED_LIGHTNING', 2, { upazilas: [SAVAR] }), ['field'], NOW).length, 0);
});
