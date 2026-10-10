import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { JobState } from '../src/models/JobState.js';
import { LightningCampaign } from '../src/models/LightningCampaign.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { runTick } from '../src/services/alerts/engine.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { loadForecastInputs, loadMarineInput } from '../src/services/alerts/snapshots.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { BURST, CLASSES, createXweatherBudget, daysUntil, nextReset } from '../src/services/xweatherBudget.js';
import { normalizeForecast, refreshForecasts, thunderInForecast } from '../src/services/xweatherForecast.js';
import { normalizeMaritime, refreshMaritime } from '../src/services/xweatherMaritime.js';
import {
  BADDA, HOUR, NOW, SAVAR,
} from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([JobState, WeatherSnapshot, HazardEvent, Subscriber, LightningCampaign].map((model) => model.init()));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([JobState, WeatherSnapshot, HazardEvent, Subscriber, LightningCampaign].map((model) => model.deleteMany({})));
  resetSettingsCache();
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- shapes taken from a live Xweather response (2026-10-10, Dhaka and the North Bay) ----------
const hourlyJson = (count = 24, { wbgt = true, rain = {}, thunderAt = -1 } = {}) => ({
  success: true,
  error: null,
  response: [{
    loc: { long: 90.413, lat: 23.81 },
    periods: Array.from({ length: count }, (_, i) => ({
      dateTimeISO: new Date(NOW + i * HOUR).toISOString().replace('.000Z', '+00:00'),
      tempC: 28 + (i % 3),
      feelslikeC: 30,
      ...(wbgt ? { wetBulbGlobeTempC: 24 + (i % 8) } : {}),
      pop: rain[i] ? 90 : 5,
      precipMM: rain[i] ?? 0,
      windSpeedKPH: 9,
      windGustKPH: 14 + i,
      humidity: 80,
      weatherPrimaryCoded: i === thunderAt ? 'SC:L:T' : '::CL',
    })),
  }],
});

const maritimeJson = (count = 24, wave = 2.3) => ({
  success: true,
  response: [{ periods: Array.from({ length: count }, (_, i) => ({ dateTimeISO: new Date(NOW + i * HOUR).toISOString(), significantWaveHeightM: wave + i * 0.01, tidesM: 1 })) }],
});

const headers = (cost = 1, remainingPeriod = 14000) => ({ cost, remainingPeriod, remainingMinute: 98, limitMinute: 100, limitPeriod: 15000, retryAfterSeconds: null });

function mockClient(handler) {
  const calls = [];
  return {
    calls,
    hasCredentials: () => true,
    async fetchJson(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

const fakeBudget = (overrides = {}) => ({
  reserved: [],
  settled: [],
  async reserve(cls, cost) { this.reserved.push([cls, cost]); return { ok: true }; },
  async settle(entry) { this.settled.push(entry); },
  async markExhausted() { this.exhausted = true; },
  async pace() {},
  ...overrides,
});

// ---------- normalisation (pure) ----------
test('an Xweather hourly forecast is normalised to aligned hourly periods with null for anything missing', () => {
  const periods = normalizeForecast(hourlyJson(3));
  assert.equal(periods.length, 3);
  assert.equal(periods[0].startMs, NOW);
  assert.equal(periods[0].endMs, NOW + HOUR);
  assert.equal(periods[0].wbgtC, 24);
  assert.equal(periods[0].precipMM, 0);
  assert.equal(periods[0].pop, 5);
  assert.equal(periods[0].windGustKph, 14);

  const without = normalizeForecast(hourlyJson(2, { wbgt: false }));
  assert.equal(without[0].wbgtC, null, 'not provided is null, never zero');
  assert.equal(normalizeForecast({ response: [] }), null);
  assert.equal(normalizeForecast({ response: [{ periods: [{ nonsense: true }] }] }), null);
  assert.equal(normalizeForecast(null), null);
});

test('thunder codes in a forecast are recognised for the lightning gate', () => {
  const periods = normalizeForecast(hourlyJson(6, { thunderAt: 2 }));
  assert.equal(thunderInForecast(periods, NOW, NOW + 6 * HOUR), true);
  assert.equal(thunderInForecast(periods, NOW, NOW + 2 * HOUR), false, 'the thunder hour is outside this window');
  assert.equal(thunderInForecast(normalizeForecast(hourlyJson(6)), NOW, NOW + 6 * HOUR), false);
});

test('maritime and forecast periods merge by hour; a missing half stays null', () => {
  const merged = normalizeMaritime(maritimeJson(3), hourlyJson(3));
  assert.equal(merged.length, 3);
  assert.equal(merged[0].waveM, 2.3);
  assert.equal(merged[0].gustKph, 14);
  const wavesOnly = normalizeMaritime(maritimeJson(2), null);
  assert.equal(wavesOnly[0].gustKph, null);
  assert.deepEqual(normalizeMaritime(null, null), []);
});

test('the allowance period rolls forward and the days left are counted', () => {
  const reset = Date.parse('2026-11-09T00:00:00Z');
  assert.equal(nextReset('2026-11-09T00:00:00Z', 30, Date.parse('2026-10-10T00:00:00Z')), reset);
  assert.equal(nextReset('2026-11-09T00:00:00Z', 30, Date.parse('2026-11-10T00:00:00Z')), reset + 30 * 24 * HOUR);
  assert.equal(daysUntil(reset, Date.parse('2026-10-10T00:00:00Z')), 30);
  assert.equal(daysUntil(reset, reset + 1), 1, 'never zero days');
});

// ---------- refreshing forecasts and maritime data (mocked client) ----------
dbTest('forecasts are fetched once per due upazila through the governor and stored as shared snapshots', async () => {
  const client = mockClient(() => ({ class: 'ok', httpStatus: 200, json: hourlyJson(24), headers: headers(1, 14700) }));
  const budget = fakeBudget();
  const summary = await refreshForecasts({ client, budget, pcodes: [BADDA, SAVAR], now: () => new Date(NOW), log: { error() {} } });

  assert.equal(summary.fetched, 2);
  assert.deepEqual(budget.reserved, [['forecast', 1], ['forecast', 1]]);
  assert.equal(budget.settled.length, 2);
  assert.match(client.calls[0].path, /^\/forecasts\/23\.\d+,90\.\d+$/);
  assert.deepEqual(client.calls[0].query, { filter: '1hr', limit: 24 });

  const inputs = await loadForecastInputs([BADDA, SAVAR], NOW + HOUR);
  assert.equal(inputs.get(BADDA).status, 'FRESH');
  assert.equal(inputs.get(BADDA).hourly.length, 24);
  const stored = await WeatherSnapshot.findOne({ queryKey: `u:${BADDA}` }).lean();
  assert.equal(stored.costTokens, 1);
  assert.equal(JSON.stringify(stored).includes('client_secret'), false);
  assert.equal(stored.data.periods[0].wbgtC, 24, 'only normalised data is stored');
  assert.equal(stored.data.response, undefined, 'never the raw provider response');
});

dbTest('a forecast without WBGT is partial; a forecast older than its window is stale', async () => {
  const client = mockClient(() => ({ class: 'ok', httpStatus: 200, json: hourlyJson(24, { wbgt: false }), headers: headers() }));
  await refreshForecasts({ client, budget: fakeBudget(), pcodes: [BADDA], now: () => new Date(NOW), log: { error() {} } });
  assert.equal((await loadForecastInputs([BADDA], NOW + HOUR)).get(BADDA).status, 'PARTIAL');
  assert.equal((await loadForecastInputs([BADDA], NOW + 10 * HOUR)).get(BADDA).status, 'STALE', 'the row exists, but it is older than nine hours');
  assert.equal((await loadForecastInputs([SAVAR], NOW)).has(SAVAR), false);
});

dbTest('a refused budget stops spending, and an exhausted allowance or a rejected key stops the refresh and is recorded', async () => {
  const client = mockClient(() => ({ class: 'ok', httpStatus: 200, json: hourlyJson(24), headers: headers() }));
  const refused = await refreshForecasts({ client, budget: fakeBudget({ reserve: async () => ({ ok: false, reason: 'daily-limit' }) }), pcodes: [BADDA, SAVAR], now: () => new Date(NOW), log: { error() {} } });
  assert.equal(client.calls.length, 0, 'no request when the governor says no');
  assert.equal(refused.stoppedBy, 'budget:daily-limit');

  const quota = mockClient(() => ({ class: 'quota', httpStatus: 200, headers: headers(), message: 'limit' }));
  const budget = fakeBudget();
  const summary = await refreshForecasts({ client: quota, budget, pcodes: [BADDA, SAVAR], now: () => new Date(NOW), log: { error() {} } });
  assert.equal(quota.calls.length, 1, 'the second upazila is not attempted');
  assert.equal(summary.stoppedBy, 'quota');
  assert.equal(budget.exhausted, true);
  const stored = await WeatherSnapshot.findOne({ queryKey: `u:${BADDA}` }).lean();
  assert.equal(stored.status, 'UNAVAILABLE');
  assert.equal(stored.errorClass, 'quota');

  const auth = mockClient(() => ({ class: 'auth', httpStatus: 401, headers: headers(null, null), message: 'rejected' }));
  assert.equal((await refreshForecasts({ client: auth, budget: fakeBudget(), pcodes: [BADDA, SAVAR], now: () => new Date(NOW), log: { error() {} } })).stoppedBy, 'auth');
});

dbTest('one failing area keeps its last good data (reported as unavailable) and does not stop the others', async () => {
  let n = 0;
  const client = mockClient(() => { n += 1; return n === 2 ? { class: 'server', httpStatus: 502, headers: headers(null, null), message: 'bad gateway' } : { class: 'ok', httpStatus: 200, json: hourlyJson(24), headers: headers() }; });
  await refreshForecasts({ client, budget: fakeBudget(), pcodes: [BADDA], now: () => new Date(NOW), log: { error() {} } });
  const second = await refreshForecasts({ client, budget: fakeBudget(), pcodes: [BADDA, SAVAR], now: () => new Date(NOW + HOUR), log: { error() {} } });
  assert.equal(second.failed, 1);
  assert.equal(second.fetched, 1);
  const kept = await WeatherSnapshot.findOne({ queryKey: `u:${BADDA}` }).lean();
  assert.equal(kept.status, 'UNAVAILABLE');
  assert.equal(kept.data.periods.length, 24, 'the last good data is kept');
  assert.equal((await loadForecastInputs([BADDA], NOW + HOUR)).get(BADDA).status, 'UNAVAILABLE', 'but it never looks fresh');
});

dbTest('marine data takes two requests per zone and is stored as a shared zone snapshot', async () => {
  const client = mockClient((request) => ({
    class: 'ok', httpStatus: 200, json: request.path.startsWith('/maritime') ? maritimeJson(24) : hourlyJson(24), headers: headers(1, 14500),
  }));
  const budget = fakeBudget();
  const summary = await refreshMaritime({ client, budget, now: () => new Date(NOW), log: { error() {} } });
  assert.equal(summary.fetched, 1);
  assert.deepEqual(client.calls.map((call) => call.path.split('/')[1]), ['maritime', 'forecasts']);
  assert.deepEqual(budget.reserved, [['maritime', 1], ['maritime', 1]]);
  const input = await loadMarineInput('north_bay', NOW + HOUR);
  assert.equal(input.status, 'FRESH');
  assert.equal(input.periods.length, 24);
  assert.equal(input.periods[0].waveM, 2.3);

  const partial = mockClient((request) => (request.path.startsWith('/maritime')
    ? { class: 'ok', httpStatus: 200, json: maritimeJson(24), headers: headers() }
    : { class: 'server', httpStatus: 500, headers: headers(null, null), message: 'x' }));
  await refreshMaritime({ client: partial, budget: fakeBudget(), now: () => new Date(NOW + 20 * 60_000), log: { error() {} } });
  assert.equal((await loadMarineInput('north_bay', NOW + HOUR)).status, 'PARTIAL', 'waves without gusts are partial');
});

dbTest('Xweather WBGT creates a heat event that the BMD heat index alone would not, and says which indicator it used', async () => {
  const { subscriber } = await createSubscriber({
    occupation: 'farmer', language: 'en', homeAreaPcode: BADDA, consent: true,
    occupationData: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
  }, { now: new Date(NOW) });
  assert.ok(subscriber);

  const client = mockClient(() => ({ class: 'ok', httpStatus: 200, json: { ...hourlyJson(24), response: [{ periods: hourlyJson(24).response[0].periods.map((period, i) => ({ ...period, wetBulbGlobeTempC: i >= 4 && i <= 8 ? 29.5 : 24 })) }] }, headers: headers() }));
  await refreshForecasts({ client, budget: fakeBudget(), pcodes: [BADDA], now: () => new Date(NOW), log: { error() {} } });

  const steps = Array.from({ length: 16 }, (_, i) => new Date(NOW - HOUR + i * 3 * HOUR).toISOString());
  const checkedAt = new Date(NOW - 60_000).toISOString();
  const common = { name: 'x', dataTime: checkedAt, checkedAt, message: null, status: 'FRESH' };
  const flat = (value) => steps.map(() => value);
  const sources = {
    bmd: { ...common, name: 'bmd', data: { steps, locations: { [BADDA]: { temp: flat(29), rh: flat(70), hi: flat(20), wg: flat(15), rf: flat(0), ws: flat(8) } }, daily: { days: [], locations: {} } } },
    openMeteo: { ...common, name: 'openMeteo', data: { steps, locations: { [BADDA]: { rf: flat(0), pop: flat(20), hi: flat(20), temp: flat(29), wg: flat(15), ts: flat(0) } } } },
  };
  await runTick({ nowMs: NOW + 60_000, sources });

  const heat = await HazardEvent.findOne({ hazardType: 'HEAT_STRESS' }).lean();
  assert.ok(heat, 'WBGT of 29.5 is level 2 although the heat index is 20');
  assert.equal(heat.level, 2);
  assert.equal(heat.evidence.metrics.indicator, 'wbgt');
  assert.equal(heat.source.provider, 'xweather');
  assert.equal(heat.dataStatus, 'FRESH', 'a provider WBGT is the preferred indicator');
  assert.equal(heat.evidence.rule.key, 'HEAT_STRESS.WBGT');
});

// ---------- the token governor ----------
const budgetConfig = (overrides = {}) => ({
  budgetRemaining: 14817, budgetReserve: 100, requestsPerMinute: 60, periodReset: '2026-11-09T00:00:00Z', periodDays: 30, ...overrides,
});
const at = (iso) => () => new Date(iso);
const TODAY = '2026-10-10T12:00:00Z';

dbTest('the governor works out the usable allowance, the daily average and where the money goes', async () => {
  const budget = createXweatherBudget({ config: budgetConfig(), now: at(TODAY), pacing: false });
  const before = await budget.summary();
  assert.equal(before.remaining, 14817);
  assert.equal(before.remainingSource, 'config');
  assert.equal(before.usable, 14717);
  assert.equal(before.daysLeft, 30);
  assert.ok(Math.abs(before.perDay - 14717 / 30) < 1e-9);

  assert.equal((await budget.reserve('forecast', 1)).ok, true);
  assert.equal((await budget.reserve('lightning_probe', 1)).ok, true);
  const after = await budget.summary();
  assert.equal(after.spentToday.forecast, 1);
  assert.equal(after.spentToday.lightning_probe, 1);
  assert.equal(after.spentToday.total, 2);
  assert.ok(Object.keys(CLASSES).length === 5);
});

dbTest('a request that would dip into the reserve is always refused', async () => {
  const budget = createXweatherBudget({ config: budgetConfig({ budgetRemaining: 105 }), now: at(TODAY), pacing: false });
  const decision = await budget.reserve('lightning_strikes', 10);
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'reserve');
  assert.equal((await budget.summary()).spentToday.total, 0, 'a refusal spends nothing');
  // Five usable tokens over thirty days is under one token a day, so even a one-token request is beyond a day's burst allowance.
  assert.equal((await budget.reserve('forecast', 1)).reason, 'daily-limit');

  const roomier = createXweatherBudget({ config: budgetConfig({ budgetRemaining: 400 }), now: at(TODAY), pacing: false });
  assert.equal((await roomier.reserve('forecast', 1)).ok, true, 'with some room a small request fits above the reserve');
});

dbTest('a day cannot spend more than 1.5 times the daily average, and no class can eat the day', async () => {
  // 1,000 usable over 30 days = about 33 a day, so at most about 50 today, and at most about 13 of it on strikes (20 % x 2).
  const budget = createXweatherBudget({ config: budgetConfig({ budgetRemaining: 1100 }), now: at(TODAY), pacing: false });
  assert.equal((await budget.reserve('lightning_strikes', 10)).ok, true);
  const second = await budget.reserve('lightning_strikes', 10);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'class-limit', 'strikes are capped at twice their share, so a second 10-token call is refused');

  // Keep spending across every class until the whole day is refused.
  const reasons = new Set();
  for (let round = 0; round < 40; round += 1) {
    for (const cls of ['lightning_probe', 'forecast', 'maritime', 'lightning_threats']) {
      const decision = await budget.reserve(cls, cls === 'lightning_threats' ? 10 : 1);
      if (!decision.ok) reasons.add(decision.reason);
    }
  }
  const summary = await budget.summary();
  assert.ok(summary.spentToday.total <= summary.perDay * BURST + 1e-9, `spent ${summary.spentToday.total} of at most ${summary.perDay * BURST}`);
  assert.ok(reasons.has('class-limit') || reasons.has('daily-limit') || reasons.has('priority'), 'something was refused');
});

dbTest('when the day is past its average only the top-priority classes may still spend', async () => {
  const budget = createXweatherBudget({ config: budgetConfig({ budgetRemaining: 1100 }), now: at(TODAY), pacing: false });
  const { perDay } = await budget.summary();
  // Spread across three classes (none near its own cap) until the day is past its average.
  for (let i = 0; i < Math.ceil(perDay) + 3; i += 1) await budget.reserve(['lightning_probe', 'forecast', 'lightning_threats'][i % 3], 1);
  assert.ok((await budget.summary()).spentToday.total > perDay);
  const maritime = await budget.check('maritime', 1);
  assert.equal(maritime.ok, false);
  assert.equal(maritime.reason, 'priority');
  assert.equal((await budget.check('forecast', 1)).ok, true, 'forecast is still served');
  assert.equal((await budget.check('lightning_probe', 1)).ok, true, 'and so are lightning probes');
});

dbTest('response headers correct the ledger and set the remaining allowance, and the lowest known value wins', async () => {
  const budget = createXweatherBudget({ config: budgetConfig(), now: at(TODAY), pacing: false });
  await budget.reserve('lightning_strikes', 10);
  await budget.settle({ cls: 'lightning_strikes', reserved: 10, headers: { cost: 12, remainingPeriod: 14000, remainingMinute: 95 } });
  const summary = await budget.summary();
  assert.equal(summary.remaining, 14000);
  assert.equal(summary.remainingSource, 'headers');
  assert.equal(summary.spentToday.lightning_strikes, 12, 'the real cost replaced the estimate');
  assert.ok(summary.lastKnownAt);

  await budget.markExhausted();
  const exhausted = await budget.summary();
  assert.equal(exhausted.remaining, 0);
  assert.equal(exhausted.usable, 0);
  assert.equal((await budget.reserve('forecast', 1)).ok, false, 'nothing is spent once the allowance is exhausted');
});

dbTest('what the lightning campaign still needs is held back from the alert engine', async () => {
  await LightningCampaign.create({
    key: 'lightning', startDate: '2026-10-10', endDate: '2026-10-19', maxSlots: 30, graceMinutes: 60, mode: 'B', modeReason: 'test',
    locations: Array.from({ length: 14 }, (_, i) => ({ id: `BD-C${i}`, kind: 'circle', lat: 23, lon: 90, radiusKm: 100 })),
    slots: [{ slotId: 's1', kind: 'scheduled', scheduledAt: new Date(NOW), status: 'pending' }, { slotId: 's2', kind: 'scheduled', scheduledAt: new Date(NOW), status: 'completed' }],
    budget: { remaining: 14000, reserve: 100, costPerRequest: 1, source: 'headers', updatedAt: new Date(NOW) },
  });
  const summary = await createXweatherBudget({ config: budgetConfig(), now: at(TODAY), pacing: false }).summary();
  assert.equal(summary.campaignOutstanding, 14, 'one pending slot x 14 circles x 1 token');
  assert.equal(summary.remaining, 14000, 'the campaign knows a lower, header-based figure');
  assert.equal(summary.usable, 14000 - 100 - 14);
});

dbTest('requests are spaced under the per-minute limit', async () => {
  const waits = [];
  const budget = createXweatherBudget({ config: budgetConfig({ requestsPerMinute: 60 }), now: at(TODAY) });
  const sleep = async (ms) => { waits.push(ms); };
  await budget.pace(sleep);
  await budget.pace(sleep);
  await budget.pace(sleep);
  assert.equal(waits.length >= 2, true, 'the second and third request wait');
  assert.ok(waits.every((ms) => ms > 0 && ms <= 2 * 60_000 / 48), 'about 1.25 seconds apart at 80 % of 60 a minute');
});
