import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { errorHandler, notFound } from '../src/middleware/errorHandler.js';
import { LightningCampaign } from '../src/models/LightningCampaign.js';
import { LightningSample } from '../src/models/LightningSample.js';
import { lightningRoutes } from '../src/routes/lightningRoutes.js';
import {
  addDays,
  buildStatus,
  buildSummaries,
  buildUpazilaSummaries,
  chooseMode,
  createLightningService,
  dhakaIso,
  dhakaWallTime,
  haversineKm,
  loadGeoData,
  planSlots,
  plannedSlotCount,
  projectCost,
} from '../src/services/lightningCampaign.js';
import { createXweatherClient, parseSummary, redactSecrets } from '../src/services/xweather.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const SECRET_ID = 'test-client-id-123';
const SECRET_KEY = 'test-client-secret-456';
const geo = loadGeoData();

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, {
    dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    serverSelectionTimeoutMS: 5000,
  });
  await Promise.all([LightningCampaign.init(), LightningSample.init()]);
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([LightningCampaign.deleteMany({}), LightningSample.deleteMany({})]);
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- helpers ----------
function makeConfig({ remaining = 14817, days = 10, start = '', maxSlots = 30, grace = 60, perMinute = 60, cost = 1, reserve = 100 } = {}) {
  return {
    lightning: { enabled: true, campaignStart: start, campaignDays: days, maxSlots, graceMinutes: grace },
    xweather: {
      clientId: SECRET_ID,
      clientSecret: SECRET_KEY,
      baseUrl: 'https://xweather.test',
      budgetRemaining: remaining,
      budgetReserve: reserve,
      requestsPerMinute: perMinute,
      assumedCostPerRequest: cost,
    },
  };
}

function fakeClock(iso) {
  let time = Date.parse(iso);
  return { now: () => new Date(time), set: (value) => { time = Date.parse(value); } };
}

const silent = { log() {}, error() {} };

function recordingSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

const emptyHeaders = { cost: null, remainingPeriod: null, remainingMinute: null, limitMinute: null, limitPeriod: null, retryAfterSeconds: null };

const okResult = ({ count = 3, headers = {} } = {}) => ({
  class: 'ok',
  httpStatus: 200,
  code: null,
  message: null,
  headers: { ...emptyHeaders, ...headers },
  summary: { populated: true, count, cloudToGround: count, intracloud: 0, detail: null },
});
const failure = (cls, extra = {}) => ({
  class: cls, httpStatus: null, code: null, message: `${cls} failure`, headers: { ...emptyHeaders }, summary: null, ...extra,
});

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    hasCredentials: () => true,
    fetchSummary: async (args) => {
      calls.push(args);
      return handler(args, calls.length);
    },
  };
}

function makeService({ client, config = makeConfig(), clock, sleep = async () => {}, log = silent }) {
  return createLightningService({ client, config, now: clock.now, sleep, log });
}

const T0 = '2026-10-10T10:30:00Z'; // 16:30 Asia/Dhaka: not within the grace of 15:00, so the first slot is the initial refresh

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// ---------- pure: mode choice, projections, slots ----------
test('Mode A needs 14,850 accesses, which does not fit 14,717 available, so Mode B is chosen', () => {
  const slots = plannedSlotCount({ days: 10, maxSlots: 30 });
  assert.equal(slots, 30);
  const choice = chooseMode({ upazilaCount: 495, slots, costPerRequest: 1, remaining: 14817, reserve: 100 });
  assert.equal(choice.requiredA, 14850);
  assert.equal(choice.available, 14717);
  assert.equal(choice.mode, 'B');
  assert.match(choice.reason, /14,850/);
  assert.match(choice.reason, /14,717/);
});

test('Mode A is chosen when it fits: a 9-day campaign, or a larger allowance', () => {
  const nineDays = plannedSlotCount({ days: 9, maxSlots: 30 });
  assert.equal(nineDays, 28); // 27 wall-clock slots plus the initial refresh
  const short = chooseMode({ upazilaCount: 495, slots: nineDays, costPerRequest: 1, remaining: 14817, reserve: 100 });
  assert.equal(short.mode, 'A');
  assert.equal(short.requiredA, 13860);

  assert.equal(chooseMode({ upazilaCount: 495, slots: 30, costPerRequest: 1, remaining: 20000, reserve: 100 }).mode, 'A');
  // A higher observed cost per request pushes Mode A out of budget again, and the setup cost counts too.
  assert.equal(chooseMode({ upazilaCount: 495, slots: 28, costPerRequest: 10, remaining: 14817, reserve: 100 }).mode, 'B');
  assert.equal(chooseMode({ upazilaCount: 495, slots: 28, costPerRequest: 1, remaining: 14817, reserve: 100, setupCost: 1000 }).mode, 'B');
});

test('projected campaign cost: 14 circles × 30 slots × 1 access = 420', () => {
  assert.equal(geo.circles.length, 14);
  assert.equal(projectCost({ locationCount: geo.circles.length, slots: 30, costPerRequest: 1 }), 420);
  assert.equal(projectCost({ locationCount: 14, slots: 30, costPerRequest: 10 }), 4200);
});

test('Asia/Dhaka helpers use a fixed +06:00 offset', () => {
  assert.equal(dhakaWallTime('2026-10-11', '07:00').toISOString(), '2026-10-11T01:00:00.000Z');
  assert.equal(dhakaWallTime('2026-10-10', '23:00').toISOString(), '2026-10-10T17:00:00.000Z');
  assert.equal(dhakaIso(new Date('2026-10-10T18:30:00Z')), '2026-10-11T00:30:00+06:00');
  assert.equal(addDays('2026-10-28', 5), '2026-11-02');
});

test('slot planning: initial refresh counts toward the 30-slot cap and follows 07:00/15:00/23:00', () => {
  const midnight = new Date('2026-10-09T18:00:00Z'); // 2026-10-10 00:00 Dhaka
  const full = planSlots({ now: midnight, startDate: '2026-10-10', days: 10, maxSlots: 30, graceMinutes: 60 });
  assert.equal(full.length, 30);
  assert.equal(full[0].kind, 'initial');
  assert.equal(full[1].slotId, '2026-10-10T07:00');
  assert.equal(full.at(-1).slotId, '2026-10-19T15:00'); // the 31st slot is dropped
  assert.equal(new Set(full.map((s) => s.slotId)).size, 30);
  assert.ok(full.every((s) => dhakaIso(s.scheduledAt).slice(0, 10) <= '2026-10-19'));
  assert.deepEqual([...new Set(full.slice(1).map((s) => dhakaIso(s.scheduledAt).slice(11, 16)))].sort(), ['07:00', '15:00', '23:00']);

  const midDay = planSlots({ now: new Date(T0), startDate: '2026-10-10', days: 10, maxSlots: 30, graceMinutes: 60 });
  assert.equal(midDay.length, 29); // earlier slots of day one are not planned
  assert.equal(midDay[0].kind, 'initial');
  assert.equal(midDay[1].slotId, '2026-10-10T23:00');
});

test('a due wall-clock slot is slot #1 instead of a synthetic initial refresh', () => {
  const slots = planSlots({ now: new Date('2026-10-10T09:20:00Z'), startDate: '2026-10-10', days: 10, maxSlots: 30, graceMinutes: 60 });
  assert.equal(slots[0].slotId, '2026-10-10T15:00');
  assert.equal(slots[0].kind, 'scheduled');
  assert.equal(slots.length, 29);
});

// ---------- pure: summary parsing ----------
test('parseSummary handles likely shapes and never invents numbers', () => {
  assert.deepEqual(parseSummary({ success: true, response: [{ summary: { total: 12, cg: 8, ic: 4 } }] }),
    { populated: true, count: 12, cloudToGround: 8, intracloud: 4, detail: null });
  assert.equal(parseSummary({ response: { summary: { count: 5, cloudToGround: 3, intraCloud: 2 } } }).count, 5);
  assert.equal(parseSummary({ response: { summary: { total: { count: 7 } } } }).count, 7);
  assert.equal(parseSummary({ response: { summary: { types: { cg: 3, ic: 4 } } } }).count, 7); // derived from both parts
  assert.equal(parseSummary({ response: { summary: { cg: 3 } } }).count, null);
  assert.equal(parseSummary({ response: [] }).populated, false);
  assert.equal(parseSummary({ response: {} }).populated, false);
  assert.equal(parseSummary({}).populated, false);

  const unknown = parseSummary({ success: true, response: { something: 'else' } });
  assert.equal(unknown.populated, true);
  assert.equal(unknown.count, null);
  assert.match(unknown.detail, /not recognised/);
});

test('redactSecrets removes credentials wherever they appear', () => {
  const config = makeConfig().xweather;
  const text = redactSecrets(`GET /x?client_id=${SECRET_ID}&client_secret=${SECRET_KEY} failed for ${SECRET_KEY}`, config);
  assert.ok(!text.includes(SECRET_ID));
  assert.ok(!text.includes(SECRET_KEY));
});

// ---------- Xweather client: the six response classes, with fetch mocked (no real network) ----------
function clientWith(responder) {
  const urls = [];
  const client = createXweatherClient({
    config: makeConfig().xweather,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return responder(String(url));
    },
  });
  return { client, urls };
}

const probe = { lat: 23.8103, lon: 90.4125, radiusKm: 100 };

test('client: populated summary, request shape and header parsing', async () => {
  const { client, urls } = clientWith(() => jsonResponse(
    { success: true, error: null, response: [{ summary: { total: 12, cg: 8, ic: 4 } }] },
    { headers: { 'X-Cost-Tokens': '1', 'X-Ratelimit-Remaining-Period': '14816', 'X-RateLimit-Limit-Minute': '100', 'x-ratelimit-remaining-minute': '99' } },
  ));
  const result = await client.fetchSummary(probe);
  assert.equal(result.class, 'ok');
  assert.equal(result.summary.count, 12);
  assert.deepEqual(
    { cost: result.headers.cost, remainingPeriod: result.headers.remainingPeriod, limitMinute: result.headers.limitMinute, remainingMinute: result.headers.remainingMinute },
    { cost: 1, remainingPeriod: 14816, limitMinute: 100, remainingMinute: 99 },
  );

  const url = new URL(urls[0]);
  assert.equal(url.origin + url.pathname, 'https://xweather.test/lightning/summary/closest');
  assert.equal(url.searchParams.get('p'), '23.8103,90.4125'); // latitude first
  assert.equal(url.searchParams.get('radius'), '100km');
  assert.equal(url.searchParams.get('from'), '-5minutes');
  assert.equal(url.searchParams.get('to'), 'now');
  assert.equal(JSON.stringify(result).includes(SECRET_KEY), false);
});

test('client: warn_no_data is "no data", other warnings keep usable data or become unavailable', async () => {
  const noData = await clientWith(() => jsonResponse({
    success: true, error: { code: 'warn_no_data', description: 'Valid request. No results available based on your query parameters.' }, response: [],
  })).client.fetchSummary(probe);
  assert.equal(noData.class, 'no-data');
  assert.equal(noData.code, 'warn_no_data');

  const adjusted = await clientWith(() => jsonResponse({
    success: true, error: { code: 'warn_param_adjusted', description: 'Radius adjusted.' }, response: [],
  })).client.fetchSummary(probe);
  assert.equal(adjusted.class, 'warning');
  assert.equal(adjusted.code, 'warn_param_adjusted');

  const usable = await clientWith(() => jsonResponse({
    success: true, error: { code: 'warn_param_adjusted', description: 'Radius adjusted.' }, response: [{ summary: { total: 2 } }],
  })).client.fetchSummary(probe);
  assert.equal(usable.class, 'ok');
  assert.equal(usable.code, 'warn_param_adjusted');
  assert.equal(usable.summary.count, 2);

  const empty = await clientWith(() => jsonResponse({ success: true, error: null, response: [] })).client.fetchSummary(probe);
  assert.equal(empty.class, 'no-data');
});

test('client: auth, rate-limit, quota, server and network failures are classified separately', async () => {
  const classify = async (responder) => (await clientWith(responder).client.fetchSummary(probe));

  assert.equal((await classify(() => jsonResponse({}, { status: 401 }))).class, 'auth');
  assert.equal((await classify(() => jsonResponse({}, { status: 403 }))).class, 'auth');
  assert.equal((await classify(() => jsonResponse({ success: false, error: { code: 'invalid_client', description: 'bad' } }))).class, 'auth');

  assert.equal((await classify(() => jsonResponse({}, { status: 429 }))).class, 'rate-limit');
  assert.equal((await classify(() => jsonResponse({ success: false, error: { code: 'maxhits_minute', description: 'slow down' } }))).class, 'rate-limit');
  const retry = await classify(() => jsonResponse({}, { status: 429, headers: { 'Retry-After': '7.5' } }));
  assert.equal(retry.headers.retryAfterSeconds, 7.5);

  assert.equal((await classify(() => jsonResponse({ success: false, error: { code: 'maxhits_daily', description: 'used up' } }))).class, 'quota');

  assert.equal((await classify(() => jsonResponse({}, { status: 503 }))).class, 'server');
  assert.equal((await classify(() => new Response('<html>', { status: 200 }))).class, 'server');
  assert.equal((await classify(() => jsonResponse({ success: false, error: { code: 'invalid_location', description: 'nope' } }))).class, 'invalid');

  const network = await classify(() => { throw new TypeError('fetch failed'); });
  assert.equal(network.class, 'network');
  const timeout = await classify(() => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; });
  assert.equal(timeout.class, 'network');
  assert.match(timeout.message, /timed out/);
});

test('client: credentials never appear in results or error messages', async () => {
  const leakyUrl = `https://xweather.test/x?client_id=${SECRET_ID}&client_secret=${SECRET_KEY}`;
  const outcomes = [
    await clientWith(() => { throw new Error(`request to ${leakyUrl} failed`); }).client.fetchSummary(probe),
    await clientWith(() => jsonResponse({ success: false, error: { code: 'invalid_client', description: `bad ${SECRET_KEY} for ${SECRET_ID}` } })).client.fetchSummary(probe),
    await clientWith(() => jsonResponse({}, { status: 401 })).client.fetchSummary(probe),
  ];
  for (const outcome of outcomes) {
    const text = JSON.stringify(outcome);
    assert.ok(!text.includes(SECRET_ID), text);
    assert.ok(!text.includes(SECRET_KEY), text);
  }
});

// ---------- campaign collection (MongoDB) ----------
dbTest('the first run creates a locked Mode B campaign and spends the initial slot', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult({ count: 2 }));
  const service = makeService({ client, clock });

  const { waitMs } = await service.tick();
  assert.equal(waitMs, 15 * 60_000); // next slot (23:00) is hours away; the job re-checks at most every 15 minutes

  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(campaign.mode, 'B');
  assert.match(campaign.modeReason, /Mode B/);
  assert.equal(campaign.locations.length, 14);
  assert.ok(campaign.locations.every((l) => l.kind === 'circle' && l.radiusKm === 100));
  assert.equal(campaign.slots.length, 29);
  assert.equal(campaign.slots[0].status, 'completed');
  assert.equal(campaign.slots[0].done, 14);
  assert.equal(campaign.budget.usedByCampaign, 14);
  assert.equal(campaign.budget.remaining, 14817 - 14);
  assert.equal(client.calls.length, 14);
  assert.equal(await LightningSample.countDocuments({ status: 'done' }), 14);
  assert.deepEqual(new Set(client.calls.map((c) => `${c.lat},${c.lon}`)), new Set(geo.circles.map((c) => `${c.lat},${c.lon}`)));
});

dbTest('the mode is locked at creation and never switches', async () => {
  const clock = fakeClock(T0);
  const first = makeService({ client: fakeClient(() => okResult()), clock });
  await first.ensureCampaign();

  // Even with a huge allowance (where Mode A would now fit) the existing campaign keeps Mode B.
  const second = makeService({ client: fakeClient(() => okResult()), clock, config: makeConfig({ remaining: 10_000_000 }) });
  const { campaign } = await second.ensureCampaign();
  assert.equal(campaign.mode, 'B');
  assert.equal(await LightningCampaign.countDocuments(), 1);

  // A fresh campaign with the 9-day numbers picks Mode A, with all 495 upazila locations.
  await LightningCampaign.deleteMany({});
  const nine = makeService({ client: fakeClient(() => okResult()), clock, config: makeConfig({ days: 9 }) });
  const { campaign: modeA } = await nine.ensureCampaign();
  assert.equal(modeA.mode, 'A');
  assert.equal(modeA.locations.length, 495);
  assert.ok(modeA.locations.every((l) => l.kind === 'upazila' && l.radiusKm === 20));
});

dbTest('the observed X-Cost-Tokens updates the cost per request and the projections', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult({ headers: { cost: 2, remainingPeriod: 14789, limitMinute: 100, remainingMinute: 90 } }));
  const service = makeService({ client, clock });
  await service.tick();

  const status = await buildStatus({ config: makeConfig(), now: clock.now });
  assert.equal(status.budget.costPerRequest, 2);
  assert.equal(status.budget.source, 'headers');
  assert.equal(status.budget.remaining, 14789); // authoritative value from the response headers
  assert.equal(status.budget.usedByCampaign, 28); // 14 requests reserved at 1, settled at 2
  assert.equal(status.budget.projectedCampaignCost, 28 + 28 * 14 * 2);
  assert.equal(status.rateLimit.perMinute, 60); // min(configured 60, 80% of the reported 100)
  assert.equal(status.rateLimit.remainingMinute, 90);
  assert.equal(status.state, 'active');
  assert.equal(status.campaign.slotsCompleted, 1);
  assert.equal(status.campaign.slotsRemaining, 28);
});

dbTest('concurrent claims produce exactly one winner per (campaign, slot, location)', async () => {
  const service = makeService({ client: fakeClient(() => okResult()), clock: fakeClock(T0) });
  const campaignId = new mongoose.Types.ObjectId();
  const claims = await Promise.all(Array.from({ length: 12 }, () => service.claimSample({ campaignId, slotId: 's1', locationId: 'BD-C01' })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await LightningSample.countDocuments({ campaignId, slotId: 's1', locationId: 'BD-C01' }), 1);

  // A different slot is a different key.
  assert.ok(await service.claimSample({ campaignId, slotId: 's2', locationId: 'BD-C01' }));
});

dbTest('two workers ticking at once make exactly one request per location', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult());
  const a = makeService({ client, clock });
  const b = makeService({ client, clock });
  await Promise.all([a.tick(), b.tick()]);

  assert.equal(client.calls.length, 14);
  assert.equal(new Set(client.calls.map((c) => `${c.lat},${c.lon}`)).size, 14);
  assert.equal(await LightningCampaign.countDocuments(), 1);
  assert.equal((await LightningCampaign.findOne().lean()).budget.usedByCampaign, 14);
});

dbTest('a restart resumes an interrupted slot without repeating finished locations', async () => {
  const clock = fakeClock(T0);
  const controller = new AbortController();
  const client = fakeClient((_, n) => { if (n === 5) controller.abort(); return okResult(); });
  const first = makeService({ client, clock });
  const { waitMs } = await first.tick({ signal: controller.signal });
  assert.equal(waitMs, null);

  const interrupted = await LightningCampaign.findOne().lean();
  assert.equal(interrupted.slots[0].status, 'running');
  const doneBefore = await LightningSample.countDocuments({ status: 'done' });
  assert.ok(doneBefore >= 5 && doneBefore < 14, `done before restart: ${doneBefore}`);

  // Simulate a crash too: a claim whose lease has expired is picked up again; a finished one never is.
  const stuck = geo.circles.find((c) => !client.calls.some((call) => call.lat === c.lat && call.lon === c.lon));
  await LightningSample.updateOne({ slotId: interrupted.slots[0].slotId, locationId: stuck.id }, { $set: { status: 'claimed', leaseUntil: new Date(Date.parse(T0) - 1000), attempts: 1 } }, { upsert: true });

  clock.set('2026-10-10T10:31:00Z');
  const second = makeService({ client, clock });
  await second.tick();

  const finished = await LightningCampaign.findOne().lean();
  assert.equal(finished.slots[0].status, 'completed');
  assert.equal(await LightningSample.countDocuments({ status: 'done' }), 14);
  const perLocation = new Map();
  for (const call of client.calls) perLocation.set(`${call.lat},${call.lon}`, (perLocation.get(`${call.lat},${call.lon}`) ?? 0) + 1);
  assert.equal(perLocation.size, 14);
  assert.ok([...perLocation.values()].every((n) => n === 1), 'no location was requested twice');
});

dbTest('slots outside the grace period are marked missed and make no requests', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult());
  const service = makeService({ client, clock });
  await service.tick();
  assert.equal(client.calls.length, 14);

  clock.set('2026-10-10T19:00:00Z'); // 01:00 on the 11th: the 23:00 slot is two hours late
  const { waitMs } = await service.tick();
  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(campaign.slots[1].slotId, '2026-10-10T23:00');
  assert.equal(campaign.slots[1].status, 'missed');
  assert.equal(client.calls.length, 14);
  assert.equal(waitMs, 15 * 60_000);

  const status = await buildStatus({ config: makeConfig(), now: clock.now });
  assert.equal(status.campaign.slotsMissed, 1);
});

dbTest('a slot inside the grace period still runs', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult());
  const service = makeService({ client, clock });
  await service.tick();

  clock.set('2026-10-10T17:30:00Z'); // 23:30 Dhaka, 30 minutes after the 23:00 slot
  await service.tick();
  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(campaign.slots[1].status, 'completed');
  assert.equal(client.calls.length, 28);
});

dbTest('a one-day campaign runs its four slots, then stops scheduling and reports ended', async () => {
  const clock = fakeClock('2026-10-09T18:00:00Z'); // 00:00 on the 10th, Dhaka
  const client = fakeClient(() => okResult());
  // A small allowance keeps this on Mode B (Mode A would need 495 × 4 = 1,980 accesses).
  const config = makeConfig({ days: 1, remaining: 1000 });
  const service = makeService({ client, clock, config });
  const waits = [];
  for (const at of ['2026-10-09T18:00:00Z', '2026-10-10T01:00:00Z', '2026-10-10T09:00:00Z', '2026-10-10T17:00:00Z']) {
    clock.set(at);
    waits.push((await service.tick()).waitMs);
  }

  const campaign = await LightningCampaign.findOne().lean();
  assert.deepEqual(campaign.slots.map((s) => s.slotId.replace(/^initial-.*/, 'initial')), ['initial', '2026-10-10T07:00', '2026-10-10T15:00', '2026-10-10T23:00']);
  assert.ok(campaign.slots.every((s) => s.status === 'completed'));
  assert.equal(client.calls.length, 4 * 14);
  assert.equal(waits.at(-1), null); // nothing left to schedule once the campaign is over
  assert.equal((await service.tick()).waitMs, null);

  assert.equal(campaign.mode, 'B');
  const status = await buildStatus({ config, now: clock.now });
  assert.equal(status.state, 'ended');
  assert.equal(status.campaign.nextSlotAt, null);
  assert.equal(client.calls.length, 4 * 14);
});

dbTest('budget gate: a slot that cannot be afforded is skipped without spending anything', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => okResult());
  const service = makeService({ client, clock, config: makeConfig({ remaining: 105 }) });
  await service.tick();

  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(campaign.slots[0].status, 'skipped_budget');
  assert.match(campaign.slots[0].reason, /reserve/);
  assert.equal(client.calls.length, 0);
  assert.equal(campaign.budget.remaining, 105);
  assert.equal(campaign.budget.usedByCampaign, 0);
  assert.equal(campaign.haltedReason, null);
  assert.equal(campaign.mode, 'B'); // never switches to another mode

  const status = await buildStatus({ config: makeConfig({ remaining: 105 }), now: clock.now });
  assert.equal(status.campaign.slotsSkipped, 1);
});

dbTest('budget gate: retries are counted and spending never dips into the reserve', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => failure('server', { httpStatus: 503 }));
  const service = makeService({ client, clock, config: makeConfig({ remaining: 120 }) });
  await service.tick();

  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(client.calls.length, 20); // 120 - 100 reserve = exactly 20 requests, retries included
  assert.equal(campaign.budget.remaining, 100);
  assert.equal(campaign.budget.usedByCampaign, 20);
  assert.equal(campaign.slots[0].status, 'skipped_budget');
  assert.ok(campaign.budget.remaining >= campaign.budget.reserve);
});

dbTest('response classes: no data, warnings, and retries with backoff are recorded per sample', async () => {
  const clock = fakeClock(T0);
  const target = geo.circles[0];
  const { sleeps, sleep } = recordingSleep();
  let rateLimited = false;
  const client = fakeClient(({ lat, lon }) => {
    if (lat === target.lat && lon === target.lon) {
      if (!rateLimited) { rateLimited = true; return failure('rate-limit', { httpStatus: 429, headers: { ...emptyHeaders, retryAfterSeconds: 7.5 } }); }
      return okResult({ count: 9 });
    }
    if (lat === geo.circles[1].lat && lon === geo.circles[1].lon) {
      return { class: 'no-data', httpStatus: 200, code: 'warn_no_data', message: null, headers: { ...emptyHeaders }, summary: null };
    }
    if (lat === geo.circles[2].lat && lon === geo.circles[2].lon) {
      return { class: 'warning', httpStatus: 200, code: 'warn_param_adjusted', message: 'Radius adjusted.', headers: { ...emptyHeaders }, summary: null };
    }
    return okResult({ count: 0 });
  });
  const service = makeService({ client, clock, sleep });
  await service.tick();

  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(client.calls.length, 15); // one retry
  assert.equal(campaign.budget.usedByCampaign, 15); // the retry was charged
  assert.ok(sleeps.includes(7500), `backoff honours Retry-After: ${sleeps}`);

  const sample = (id) => LightningSample.findOne({ campaignId: campaign._id, locationId: id }).lean();
  const retried = await sample(target.id);
  assert.equal(retried.attempts, 2);
  assert.equal(retried.state, 'reported');
  assert.equal(retried.count, 9);

  const none = await sample(geo.circles[1].id);
  assert.equal(none.state, 'none');
  assert.equal(none.count, 0);
  assert.equal(none.warningCode, 'warn_no_data');

  const warned = await sample(geo.circles[2].id);
  assert.equal(warned.status, 'done'); // a warning is not retried
  assert.equal(warned.state, 'unavailable');
  assert.equal(warned.warningCode, 'warn_param_adjusted');
  assert.equal(warned.attempts, 1);

  const zero = await sample(geo.circles[3].id);
  assert.equal(zero.state, 'none'); // a summary with a count of 0 means nothing was reported

  // The window sampled is exactly the five minutes before the request.
  assert.equal(retried.window.to.getTime() - retried.window.from.getTime(), 5 * 60_000);
});

dbTest('persistent server failures stop after bounded retries and leave the slot partial', async () => {
  const clock = fakeClock(T0);
  const bad = geo.circles[0];
  const client = fakeClient(({ lat, lon }) => (lat === bad.lat && lon === bad.lon ? failure('network') : okResult()));
  const service = makeService({ client, clock });
  await service.tick();

  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(client.calls.filter((c) => c.lat === bad.lat && c.lon === bad.lon).length, 3); // 1 try + 2 retries
  assert.equal(campaign.slots[0].status, 'partial');
  assert.equal(campaign.slots[0].done, 13);
  assert.equal(campaign.budget.usedByCampaign, 13 + 3);

  const summaries = await buildSummaries({ config: makeConfig(), now: clock.now });
  assert.equal(summaries.items.find((i) => i.id === bad.id).state, 'unavailable');
  assert.equal(summaries.items.filter((i) => i.state === 'reported').length, 13);
});

dbTest('an auth failure halts collection immediately and permanently', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => failure('auth', { httpStatus: 401 }));
  const service = makeService({ client, clock });
  const { waitMs } = await service.tick();
  assert.equal(waitMs, null);
  assert.ok(client.calls.length <= 2, `only requests already in flight: ${client.calls.length}`);

  const campaign = await LightningCampaign.findOne().lean();
  assert.match(campaign.haltedReason, /rejected the credentials/);
  assert.equal(campaign.slots[0].status, 'partial');

  const before = client.calls.length;
  clock.set('2026-10-10T17:00:00Z');
  assert.equal((await service.tick()).waitMs, null);
  assert.equal(client.calls.length, before);

  const status = await buildStatus({ config: makeConfig(), now: clock.now });
  assert.equal(status.state, 'disabled');
  assert.match(status.reason, /rejected the credentials/);
});

dbTest('an exhausted Xweather quota skips the slot and zeroes the remaining budget', async () => {
  const clock = fakeClock(T0);
  const client = fakeClient(() => failure('quota', { code: 'maxhits_daily' }));
  await makeService({ client, clock }).tick();
  const campaign = await LightningCampaign.findOne().lean();
  assert.equal(campaign.slots[0].status, 'skipped_budget');
  assert.equal(campaign.budget.remaining, 0);
  assert.ok(client.calls.length <= 2);
});

dbTest('the real client plugs into the service: URLs use lat,lon and nothing secret is stored', async () => {
  const clock = fakeClock(T0);
  const config = makeConfig();
  const urls = [];
  const client = createXweatherClient({
    config: config.xweather,
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (urls.length === 3) throw new Error(`socket hang up for ${url}`);
      return jsonResponse({ success: true, error: null, response: [{ summary: { total: 4, cg: 3, ic: 1 } }] },
        { headers: { 'X-Cost-Tokens': '1' } });
    },
  });
  const log = { lines: [], log(...a) { this.lines.push(a.join(' ')); }, error(...a) { this.lines.push(a.join(' ')); } };
  await makeService({ client, clock, log, config }).tick();

  const sent = new Set(urls.map((u) => new URL(u).searchParams.get('p')));
  for (const circle of geo.circles) assert.ok(sent.has(`${circle.lat},${circle.lon}`), circle.id);

  const stored = JSON.stringify([await LightningCampaign.find().lean(), await LightningSample.find().lean(), log.lines]);
  assert.ok(!stored.includes(SECRET_ID));
  assert.ok(!stored.includes(SECRET_KEY));
  assert.equal(await LightningSample.countDocuments({ status: 'done' }), 14);
  assert.equal((await LightningSample.find({ cloudToGround: 3, intracloud: 1, count: 4 }).lean()).length, 14);
});

dbTest('summaries report reported / none / stale / unavailable / not-checked states', async () => {
  const clock = fakeClock(T0);
  const [first, second, third] = geo.circles;
  const client = fakeClient(({ lat, lon }) => {
    if (lat === first.lat && lon === first.lon) return okResult({ count: 6 });
    if (lat === second.lat && lon === second.lon) return { class: 'no-data', httpStatus: 200, code: 'warn_no_data', message: null, headers: { ...emptyHeaders }, summary: null };
    if (lat === third.lat && lon === third.lon) return failure('network');
    return okResult({ count: 0 });
  });
  await makeService({ client, clock }).tick();

  const config = makeConfig();
  const fresh = await buildSummaries({ config, now: clock.now });
  const byId = Object.fromEntries(fresh.items.map((i) => [i.id, i]));
  assert.equal(fresh.mode, 'B');
  assert.equal(fresh.items.length, 14);
  assert.equal(byId[first.id].state, 'reported');
  assert.equal(byId[first.id].count, 6);
  assert.match(byId[first.id].window.from, /\+06:00$/);
  assert.match(byId[first.id].sampledAt, /\+06:00$/);
  assert.equal(byId[second.id].state, 'none');
  assert.equal(byId[third.id].state, 'unavailable');
  assert.equal(fresh.staleAfterMinutes, 8 * 60 + 60);
  assert.match(fresh.latestRefreshAt, /\+06:00$/);

  const later = await buildSummaries({ config, now: () => new Date(Date.parse(T0) + 10 * 3_600_000) });
  assert.equal(later.items.find((i) => i.id === first.id).state, 'stale');
  assert.equal(later.items.find((i) => i.id === third.id).state, 'unavailable');
});

// ---------- HTTP endpoints (read the cache only) ----------
async function withApi(run) {
  const app = express();
  app.use('/api/lightning', lightningRoutes);
  app.use(notFound);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/lightning`;
  const originalFetch = globalThis.fetch;
  const external = [];
  globalThis.fetch = (url, init) => {
    if (!String(url).startsWith('http://127.0.0.1')) external.push(String(url));
    return originalFetch(url, init);
  };
  try {
    await run(base);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  assert.deepEqual(external, [], 'HTTP handlers must never call an external API');
}

test('GET /status reports the plan when no campaign exists and never leaks credentials', async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/status`);
    assert.equal(response.status, 200);
    const { data } = await response.json();

    const expected = chooseMode({
      upazilaCount: 495, slots: 30, costPerRequest: env.xweather.assumedCostPerRequest,
      remaining: env.xweather.budgetRemaining, reserve: env.xweather.budgetReserve,
    });
    assert.equal(data.mode, expected.mode);
    assert.equal(data.campaign, null);
    assert.equal(data.budget.source, 'config');
    assert.equal(data.budget.locationCount, expected.mode === 'B' ? 14 : 495);
    assert.equal(data.budget.projectedCampaignCost, data.budget.locationCount * 30 * env.xweather.assumedCostPerRequest);
    if (!env.xweather.clientId) {
      assert.equal(data.state, 'disabled');
      assert.equal(data.reason, 'Xweather credentials are not configured.');
    }
    if (env.xweather.budgetRemaining === 14817 && env.xweather.assumedCostPerRequest === 1) {
      assert.equal(data.mode, 'B');
      assert.equal(data.modeLabel, 'Regional-circle summaries');
      assert.equal(data.budget.projectedCampaignCost, 420);
    }
    const text = data.limitations.join(' ');
    assert.match(text, /Three daily 5-minute snapshots/);
    assert.match(text, /not continuous lightning monitoring/);
    assert.match(text, /not an administrative boundary/);
    assert.match(text, /never be summed/);
    assert.ok(data.slotTimes === undefined);
    for (const secret of [env.xweather.clientId, env.xweather.clientSecret].filter(Boolean)) {
      assert.ok(!JSON.stringify(data).includes(secret));
    }
  });
});

test('GET /summaries lists every planned item as not-checked before the first refresh', async () => {
  await withApi(async (base) => {
    const { data } = await (await fetch(`${base}/summaries`)).json();
    assert.equal(data.items.length, data.mode === 'B' ? 14 : 495);
    assert.ok(data.items.every((i) => i.state === 'not-checked' && i.count === null && i.window === null));
    assert.equal(data.staleAfterMinutes, 8 * 60 + env.lightning.graceMinutes);
    assert.equal(data.latestRefreshAt, null);
    if (data.mode === 'B') assert.ok(data.items.every((i) => i.kind === 'circle' && i.radiusKm === 100));
  });
});

test('GET /upazila/:pcode returns the circle(s) within range, labelled as circle-wide totals', async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/upazila/302604`); // Badda, Dhaka
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.pcode, '302604');
    assert.equal(data.name, 'Badda');
    if (data.mode === 'B') {
      const badda = geo.locationsByPcode.get('302604');
      assert.ok(data.items.length >= 1);
      for (const item of data.items) assert.ok(haversineKm(badda.lat, badda.lon, item.lat, item.lon) <= 100);
      assert.match(data.note, /circle-wide totals, not counts inside Badda/);
      assert.match(data.note, /must not be summed/);
    }

    const direct = await (await fetch(`${base}/upazila/100409`)).json(); // Amtali
    assert.equal(direct.data.name, 'Amtali');

    const invalid = await fetch(`${base}/upazila/not-a-code`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).message, 'Invalid location code.');
    assert.equal((await fetch(`${base}/upazila/99999`)).status, 400);
    assert.equal((await fetch(`${base}/upazila/999999`)).status, 404);
  });
});

test('Mode B lookup finds every Bangladesh location within some 100 km circle', async () => {
  for (const location of geo.locationsByPcode.values()) {
    const near = geo.circles.filter((c) => haversineKm(location.lat, location.lon, c.lat, c.lon) <= 100);
    assert.ok(near.length >= 1, `${location.name} is not covered by any circle`);
  }
});

dbTest('endpoints serve the cached campaign data and the upazila lookup reads the same cache', async () => {
  const clock = { now: () => new Date() }; // real time, so the cached samples are fresh for the HTTP handlers
  const client = fakeClient((_, n) => okResult({ count: n % 2 }));
  await createLightningService({ client, config: makeConfig(), now: clock.now, sleep: async () => {}, log: silent }).tick();
  assert.equal(client.calls.length, 14);

  await withApi(async (base) => {
    const status = (await (await fetch(`${base}/status`)).json()).data;
    assert.equal(status.campaign.slotsCompleted, 1);
    assert.equal(status.campaign.slotsRemaining >= 1, true);
    assert.equal(status.budget.usedByCampaign, 14);
    assert.equal(status.budget.source, 'config');

    const summaries = (await (await fetch(`${base}/summaries`)).json()).data;
    assert.equal(summaries.items.length, 14);
    assert.ok(summaries.items.every((i) => ['reported', 'none'].includes(i.state)));
    assert.ok(summaries.items.some((i) => i.state === 'reported'));
    assert.ok(summaries.items.some((i) => i.state === 'none'));
    assert.ok(summaries.items.every((i) => i.slotId && i.sampledAt && i.window));

    const forUpazila = (await (await fetch(`${base}/upazila/302604`)).json()).data;
    assert.ok(forUpazila.items.length >= 1);
    assert.ok(forUpazila.items.every((i) => ['reported', 'none'].includes(i.state)));
  });

  const direct = await buildUpazilaSummaries('302604', { config: makeConfig() });
  assert.equal(direct.mode, 'B');
});
