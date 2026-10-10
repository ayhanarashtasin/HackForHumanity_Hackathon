import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { runTick } from '../src/services/alerts/engine.js';
import { decideProbe, refreshLightning } from '../src/services/alerts/lightningGate.js';
import { episodeState, lightningStage } from '../src/services/alerts/lightningEpisodes.js';
import { markRead } from '../src/services/alerts/inbox.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { saveSnapshot } from '../src/services/alerts/snapshots.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { locationByPcode } from '../src/services/geo.js';
import { containsPoint } from '../src/services/geoPoint.js';
import { loadGeoData } from '../src/services/lightningCampaign.js';
import { haversineKm } from '../src/services/time.js';
import { parseStrikes, parseThreats, threatAt } from '../src/services/xweatherLightning.js';
import { BADDA, HOUR, NOW } from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MIN = 60_000;
const badda = locationByPcode.get(BADDA);
const geo = loadGeoData();
const circle = geo.circles.filter((c) => haversineKm(badda.lat, badda.lon, c.lat, c.lon) <= geo.apiRadiusKm)[0];

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all([HazardEvent, Notification, Subscriber, WeatherSnapshot].map((model) => model.init()));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all([HazardEvent, Notification, Subscriber, WeatherSnapshot].map((model) => model.deleteMany({})));
  resetSettingsCache();
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- SYNTHETIC fixtures: built from the provider's documentation, never from a live response (none has been seen yet) ----------
const strike = (id, atMs, lat, lon, type = 'cg') => ({
  id, loc: { lat, long: lon }, ob: { timestamp: Math.floor(atMs / 1000), dateTimeISO: new Date(atMs).toISOString(), pulse: { type, peakamp: -12000 } },
});
// Roughly dKm kilometres north of Badda.
const north = (dKm) => ({ lat: badda.lat + dKm / 111.2, lon: badda.lon });
const ring = (lat, lon, d = 0.08) => [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
const threatJson = (startMs, { lat = badda.lat, lon = badda.lon, periods = 3 } = {}) => ({
  success: true,
  response: [{
    id: 'threat-1',
    periods: Array.from({ length: periods }, (_, i) => ({
      dateTimeISO: new Date(startMs + i * 10 * MIN).toISOString(),
      validTime: new Date(startMs + i * 10 * MIN).toISOString(),
      geoJSON: { type: 'Polygon', coordinates: [ring(lat, lon)] },
    })),
  }],
});

// ---------- parsers and geometry ----------
test('strikes are parsed from the documented fields, with unusable rows dropped and unknown pulse types kept as unknown', () => {
  const at = NOW - MIN;
  const { strikes, recognised } = parseStrikes({
    success: true,
    response: [strike('a', at, 23.8, 90.4, 'cg'), strike('b', at, 23.9, 90.5, 'IC'), strike('c', at, 23.9, 90.5, 'zz'), { id: 'bad', loc: {} }, { id: 'no-time', loc: { lat: 1, long: 2 } }],
  });
  assert.deepEqual(strikes.map((s) => [s.id, s.type]), [['a', 'cg'], ['b', 'ic'], ['c', 'unknown']]);
  assert.equal(strikes[0].at, Math.floor(at / 1000) * 1000);
  assert.equal(recognised, true);
  assert.deepEqual(parseStrikes({ response: [] }), { strikes: [], recognised: true });
  assert.deepEqual(parseStrikes(null), { strikes: [], recognised: true });
  assert.equal(parseStrikes({ response: [{ nothing: 'useful' }] }).recognised, false, 'a populated response nobody understands is reported, not invented');
});

test('threat periods are read with their polygons and times; an unrecognised shape yields nothing, never a made-up threat', () => {
  const { threats, recognised } = parseThreats(threatJson(NOW));
  assert.equal(recognised, true);
  assert.equal(threats[0].periods.length, 3);
  assert.equal(threats[0].periods[0].endMs - threats[0].periods[0].startMs, 10 * MIN, 'a period is ten minutes unless the provider says otherwise');

  const nested = parseThreats({ response: { id: 'x', threat: { periods: [{ validFromISO: new Date(NOW).toISOString(), validToISO: new Date(NOW + 5 * MIN).toISOString(), geometry: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(1, 1)] } } }] } } });
  assert.equal(nested.threats[0].periods[0].endMs - nested.threats[0].periods[0].startMs, 5 * MIN);

  const unknown = parseThreats({ response: [{ id: 't', periods: [{ foo: 'bar' }] }] });
  assert.deepEqual(unknown.threats, []);
  assert.equal(unknown.recognised, false);
  assert.deepEqual(parseThreats({ response: [] }), { threats: [], recognised: true });
});

test('a threat covers a point only while its period is current, inside the horizon and inside its polygon', () => {
  const { threats } = parseThreats(threatJson(NOW + 20 * MIN));
  assert.equal(threatAt(threats, badda.lon, badda.lat, NOW, 60 * MIN).startMs, NOW + 20 * MIN);
  assert.equal(threatAt(threats, badda.lon, badda.lat, NOW, 10 * MIN), null, 'beyond the horizon');
  assert.equal(threatAt(threats, badda.lon + 1, badda.lat, NOW, 60 * MIN), null, 'outside the polygon');
  assert.equal(threatAt(threats, badda.lon, badda.lat, NOW + 2 * HOUR, 60 * MIN), null, 'already over');
  const square = { type: 'Polygon', coordinates: [ring(10, 10, 1), ring(10, 10, 0.2).reverse()] };
  assert.equal(containsPoint(square, 10, 10), false, 'a hole is respected');
  assert.equal(containsPoint(square, 10.5, 10), true);
  assert.equal(containsPoint({ type: 'MultiPolygon', coordinates: [[ring(0, 0, 1)], [ring(5, 5, 1)]] }, 5, 5), true);
});

// ---------- the gate ----------
const decide = (overrides) => decideProbe({ nowMs: NOW, lastProbeAttemptMs: null, lastPositiveMs: null, forecastSignal: false, baselineEnabled: true, localHour: 15, ...overrides });

test('the gate opens for thunder potential or recent lightning, and probes every five minutes while open', () => {
  assert.deepEqual(decide({ forecastSignal: true }), { gate: 'open', due: true, reasons: ['thunder-potential'] });
  assert.equal(decide({ forecastSignal: true, lastProbeAttemptMs: NOW - 4 * MIN }).due, false);
  assert.equal(decide({ forecastSignal: true, lastProbeAttemptMs: NOW - 5 * MIN }).due, true);
  const recent = decide({ lastPositiveMs: NOW - 40 * MIN });
  assert.equal(recent.gate, 'open');
  assert.deepEqual(recent.reasons, ['recent-lightning']);
  assert.equal(decide({ lastPositiveMs: NOW - 61 * MIN, localHour: 3 }).gate, 'closed', 'recent lightning keeps the gate open for an hour only');
});

test('outside a gate, only a daytime baseline probe runs, hourly, and it can be switched off', () => {
  assert.deepEqual(decide({}), { gate: 'baseline', due: true, reasons: ['daytime-baseline'] });
  assert.equal(decide({ lastProbeAttemptMs: NOW - 30 * MIN }).due, false);
  assert.equal(decide({ lastProbeAttemptMs: NOW - 60 * MIN }).due, true);
  assert.equal(decide({ localHour: 9 }).gate, 'closed');
  assert.equal(decide({ localHour: 22 }).gate, 'closed');
  assert.equal(decide({ baselineEnabled: false }).gate, 'closed');
  assert.equal(decide({ baselineEnabled: false }).due, false);
});

// ---------- the episode (pure) ----------
const area = { pcode: BADDA, lat: badda.lat, lon: badda.lon };
const threatsFor = (startMs) => parseThreats(threatJson(startMs)).threats;
const strikeAt = (id, minutesAgo, dKm, at = NOW) => ({ id, at: at - minutesAgo * MIN, ...north(dKm), type: 'cg' });

test('a threat alone opens a threat episode: level 3 within 30 minutes, level 2 up to an hour, nothing beyond', () => {
  const soon = episodeState({ area, strikes: [], threats: threatsFor(NOW + 20 * MIN), nowMs: NOW });
  assert.equal(soon.hazardType, 'LIGHTNING_THREAT');
  assert.equal(soon.level, 3);
  assert.equal(soon.evidence.threat.minutesAhead, 20);
  assert.equal(soon.evidence.began, 'threat');
  assert.equal(soon.evidence.renotifyStage, 0);
  assert.equal(soon.evidence.rule.key, 'LIGHTNING_THREAT.L3');
  assert.equal(episodeState({ area, strikes: [], threats: threatsFor(NOW + 45 * MIN), nowMs: NOW }).level, 2);
  assert.equal(episodeState({ area, strikes: [], threats: threatsFor(NOW + 90 * MIN), nowMs: NOW }), null);
  assert.equal(episodeState({ area, strikes: [], threats: [], nowMs: NOW }), null, 'no match is nothing, not a state');
});

test('strikes within 16 km open an observed episode: level 2, level 3 within 10 km or with five or more strikes', () => {
  const far = episodeState({ area, strikes: [strikeAt('a', 2, 14)], threats: [], nowMs: NOW });
  assert.equal(far.hazardType, 'OBSERVED_LIGHTNING');
  assert.equal(far.level, 2);
  assert.equal(far.evidence.metrics.nearestKm, 14);
  assert.equal(episodeState({ area, strikes: [strikeAt('a', 2, 17)], threats: [], nowMs: NOW }), null, 'beyond 16 km is not this area');
  assert.equal(episodeState({ area, strikes: [strikeAt('a', 2, 9)], threats: [], nowMs: NOW }).level, 3);
  const many = [1, 2, 3, 4, 5].map((n) => strikeAt(`s${n}`, n, 15));
  assert.equal(episodeState({ area, strikes: many, threats: [], nowMs: NOW }).level, 3);
  assert.equal(episodeState({ area, strikes: many.slice(0, 4), threats: [], nowMs: NOW }).level, 2);
  assert.equal(episodeState({ area, strikes: [strikeAt('old', 31, 5)], threats: [], nowMs: NOW }), null, 'a strike older than the 30 minute window belongs to a finished episode');
});

test('the episode lasts until 30 minutes after the last strike, and a threat ahead keeps it open longer', () => {
  const state = episodeState({ area, strikes: [strikeAt('a', 10, 12)], threats: [], nowMs: NOW });
  assert.equal(state.untilMs, NOW - 10 * MIN + 30 * MIN);
  const withThreat = episodeState({ area, strikes: [strikeAt('a', 10, 12)], threats: threatsFor(NOW + 25 * MIN), nowMs: NOW });
  assert.ok(withThreat.untilMs > state.untilMs, 'the threat period extends it');
  assert.equal(withThreat.hazardType, 'OBSERVED_LIGHTNING', 'observed wins over a threat');
});

test('alarm fatigue: a threat then strikes is one episode with at most two re-notification stages, and pulses never add more', () => {
  const opened = episodeState({ area, strikes: [], threats: threatsFor(NOW + 20 * MIN), nowMs: NOW });
  const stored = { ...opened.evidence };

  // 1. the first strike (14 km: not close) after a threat -> stage 1
  const first = episodeState({ area, strikes: [strikeAt('s1', 1, 14, NOW + 25 * MIN)], threats: threatsFor(NOW + 20 * MIN), previous: stored, nowMs: NOW + 25 * MIN });
  assert.equal(first.evidence.renotifyStage, 1);
  assert.equal(first.evidence.notified.threatToStrike, true);
  assert.equal(first.evidence.startMs, stored.startMs, 'the same episode keeps its start');

  // 2. a pulse that is not new, and another far pulse -> still stage 1
  const pulses = episodeState({ area, strikes: [strikeAt('s1', 2, 14, NOW + 26 * MIN), strikeAt('s2', 0, 13, NOW + 26 * MIN)], threats: [], previous: first.evidence, nowMs: NOW + 26 * MIN });
  assert.equal(pulses.evidence.renotifyStage, 1);
  assert.equal(pulses.evidence.observed.count, 2);

  // 3. the first strike within 10 km -> stage 2
  const close = episodeState({ area, strikes: [strikeAt('s3', 0, 6, NOW + 28 * MIN)], threats: [], previous: pulses.evidence, nowMs: NOW + 28 * MIN });
  assert.equal(close.evidence.renotifyStage, 2);
  assert.equal(close.level, 3);

  // 4. many more close pulses -> never a third stage
  const storm = [1, 2, 3, 4, 5, 6].map((n) => strikeAt(`c${n}`, 0, 4, NOW + 30 * MIN));
  const later = episodeState({ area, strikes: storm, threats: [], previous: close.evidence, nowMs: NOW + 30 * MIN });
  assert.equal(later.evidence.renotifyStage, 2);
  assert.equal(later.evidence.observed.count, 1 + 1 + 1 + 6 - 0, 'the evidence keeps counting');
});

test('an episode that opens already close has no re-notification: the first notice already says so', () => {
  const opened = episodeState({ area, strikes: [strikeAt('a', 0, 5)], threats: [], nowMs: NOW });
  assert.equal(opened.level, 3);
  assert.equal(opened.evidence.renotifyStage, 0);
  const next = episodeState({ area, strikes: [strikeAt('a', 1, 5), strikeAt('b', 0, 4)], threats: [], previous: opened.evidence, nowMs: NOW + MIN });
  assert.equal(next.evidence.renotifyStage, 0, 'close strikes were already there at the start');
});

// ---------- refresh (mocked Xweather client and governor) ----------
const headers = { cost: 1, remainingPeriod: 14000, remainingMinute: 90, limitMinute: 100, limitPeriod: 15000, retryAfterSeconds: null };
function lightningClient({ summary = 'no-data', strikes = [], threat = null } = {}) {
  const calls = [];
  return {
    calls,
    hasCredentials: () => true,
    async fetchSummary(args) {
      calls.push(['summary', args]);
      return summary === 'ok'
        ? { class: 'ok', httpStatus: 200, headers, summary: { populated: true, count: strikes.length || 3, cloudToGround: 2, intracloud: 1, detail: null } }
        : { class: 'no-data', httpStatus: 200, headers, summary: null };
    },
    async fetchJson({ path, query }) {
      calls.push([path, query]);
      if (path === '/lightning/closest') return strikes.length ? { class: 'ok', httpStatus: 200, headers: { ...headers, cost: 10 }, json: { success: true, response: strikes } } : { class: 'no-data', httpStatus: 200, headers: { ...headers, cost: 10 } };
      return threat ? { class: 'ok', httpStatus: 200, headers: { ...headers, cost: 10 }, json: threat } : { class: 'no-data', httpStatus: 200, headers: { ...headers, cost: 10 } };
    },
  };
}
const budgetStub = (refuse = []) => ({
  reserved: [],
  async reserve(cls, cost) { this.reserved.push([cls, cost]); return refuse.includes(cls) ? { ok: false, reason: 'daily-limit' } : { ok: true }; },
  async settle() {},
  async markExhausted() {},
  async pace() {},
});

async function subscribeFarmer() {
  const { subscriber } = await createSubscriber({
    occupation: 'farmer', language: 'en', homeAreaPcode: BADDA, consent: true,
    occupationData: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
  }, { now: new Date(NOW) });
  return subscriber;
}

const DAYTIME = Date.parse('2026-10-11T05:00:00Z'); // 11:00 in Bangladesh

dbTest('with no forecast signal only a daytime baseline probe runs, one token, and a quiet probe is NO_MATCH (not an all-clear)', async () => {
  await subscribeFarmer();
  const client = lightningClient();
  const budget = budgetStub();
  const summary = await refreshLightning({ client, budget, nowMs: DAYTIME, now: () => new Date(DAYTIME), log: { error() {} } });

  assert.ok(summary.circles >= 1);
  assert.equal(summary.probed, 1);
  assert.equal(summary.strikesFetched, 0);
  assert.equal(summary.threatsFetched, 0);
  assert.deepEqual(budget.reserved, [['lightning_probe', 1]]);
  assert.equal(client.calls[0][1].radiusKm, 100);
  const probe = await WeatherSnapshot.findOne({ product: 'lightning-summary' }).lean();
  assert.equal(probe.status, 'NO_MATCH');
  assert.equal(probe.scope.gate, 'baseline');
  assert.match(probe.message, /previous five minutes/);

  const again = await refreshLightning({ client, budget: budgetStub(), nowMs: DAYTIME + 10 * MIN, now: () => new Date(DAYTIME + 10 * MIN), log: { error() {} } });
  assert.equal(again.probed, 0, 'the baseline is hourly');
  const night = await refreshLightning({ client, budget: budgetStub(), nowMs: Date.parse('2026-10-11T20:00:00Z'), now: () => new Date(), log: { error() {} } });
  assert.equal(night.probed, 0, 'and daytime only (02:00 local)');
});

dbTest('a positive probe fetches strikes once for the circle; an open gate also fetches threats; costs are 1, 10 and 10', async () => {
  await subscribeFarmer();
  const strikes = [strike('x1', DAYTIME - MIN, north(8).lat, north(8).lon)];
  const client = lightningClient({ summary: 'ok', strikes, threat: threatJson(DAYTIME + 20 * MIN) });
  // Thunder potential (Open-Meteo `ts`) in the cached forecast opens the gate.
  const stepStart = new Date(DAYTIME - HOUR).toISOString();
  const budget = budgetStub();
  const { setSnapshot, resetForTests } = await import('../src/services/weatherStore.js');
  resetForTests();
  await setSnapshot('openMeteo', { steps: [stepStart], locations: { [BADDA]: { ts: [2] } }, districts: {} }, { dataTime: new Date(DAYTIME).toISOString(), persistToDb: false });
  const summary = await refreshLightning({ client, budget, nowMs: DAYTIME, now: () => new Date(DAYTIME), log: { error() {} } });
  resetForTests();

  assert.equal(summary.detail[0].gate, 'open');
  assert.deepEqual(summary.detail[0].reasons, ['thunder-potential']);
  assert.deepEqual(budget.reserved.map(([cls, cost]) => `${cls}:${cost}`).sort(), ['lightning_probe:1', 'lightning_strikes:10', 'lightning_threats:10']);
  assert.equal(summary.strikesFetched, 1);
  assert.equal(summary.threatsFetched, 1);
  const stored = await WeatherSnapshot.find({}).lean();
  assert.deepEqual(stored.map((row) => row.product).sort(), ['lightning-strikes', 'lightning-summary', 'lightning-threats']);
  assert.equal(stored.find((row) => row.product === 'lightning-strikes').data.strikes[0].id, 'x1');
  assert.ok(stored.find((row) => row.product === 'lightning-summary').scope.lastPositiveAt, 'a positive probe is remembered, so the gate stays open');
  assert.equal(JSON.stringify(stored).includes('client_secret'), false);
});

dbTest('a refused budget skips the request, and a rejected key stops the whole pass', async () => {
  await subscribeFarmer();
  const refused = await refreshLightning({ client: lightningClient(), budget: budgetStub(['lightning_probe']), nowMs: DAYTIME, now: () => new Date(DAYTIME), log: { error() {} } });
  assert.equal(refused.refused, 1);
  assert.equal(refused.probed, 0);
  assert.equal(await WeatherSnapshot.countDocuments(), 0, 'nothing was asked, so nothing is claimed');

  const client = lightningClient();
  client.fetchSummary = async () => ({ class: 'auth', httpStatus: 401, headers: { ...headers, cost: null }, message: 'rejected' });
  const stopped = await refreshLightning({ client, budget: budgetStub(), nowMs: DAYTIME, now: () => new Date(DAYTIME), log: { error() {} } });
  assert.equal(stopped.stoppedBy, 'auth');
  assert.equal((await WeatherSnapshot.findOne({ product: 'lightning-summary' }).lean()).status, 'UNAVAILABLE');
});

// ---------- the whole path: snapshots -> episode -> one card per subscriber ----------
async function putSnapshots({ nowMs, strikes = [], threat = null, gate = 'open', positive = true }) {
  const at = new Date(nowMs);
  const base = { provider: 'xweather', queryKey: `c:${circle.id}`, scope: { lat: circle.lat, lon: circle.lon, radiusKm: 100, gate, ...(positive ? { lastPositiveAt: at.toISOString() } : {}) }, now: at };
  await saveSnapshot({ ...base, product: 'lightning-summary', status: positive ? 'FRESH' : 'NO_MATCH', data: { count: strikes.length } });
  await saveSnapshot({ ...base, product: 'lightning-strikes', status: strikes.length ? 'FRESH' : 'NO_MATCH', data: { strikes: parseStrikes({ response: strikes }).strikes } });
  await saveSnapshot({ ...base, product: 'lightning-threats', status: threat ? 'FRESH' : 'NO_MATCH', data: { threats: threat ? parseThreats(threat).threats : [] } });
}

const flatSources = (nowMs) => {
  const empty = { name: 'x', status: 'FRESH', dataTime: new Date(nowMs).toISOString(), checkedAt: new Date(nowMs).toISOString(), message: null, data: null };
  return { bmd: { ...empty, name: 'bmd' }, openMeteo: { ...empty, name: 'openMeteo' } };
};
const tickAt = (nowMs) => runTick({ nowMs, sources: flatSources(nowMs), extraStages: [lightningStage] });

dbTest('threat, then strikes, then close strikes: one CRITICAL card with at most two re-notifications, and a quiet ending', async () => {
  const farmer = await subscribeFarmer();
  const noteOf = () => Notification.findOne({ subscriberId: farmer._id }).lean();
  const t0 = NOW;

  // 1. a threat 20 minutes ahead
  await putSnapshots({ nowMs: t0, threat: threatJson(t0 + 20 * MIN), positive: false });
  await tickAt(t0);
  let event = await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean();
  assert.equal(event.hazardType, 'LIGHTNING_THREAT');
  assert.equal(event.level, 3);
  assert.equal(event.coverage.scope, 'upazila');
  let note = await noteOf();
  assert.equal(note.scenarioId, 'FARM-04');
  assert.equal(note.severity, 'CRITICAL', 'a threat is CRITICAL too (decision D10)');
  assert.match(note.message, /within about 30 minutes/);
  assert.doesNotMatch(note.message, /detected/);
  await markRead(farmer._id, note._id, new Date(t0));

  // 2. the same data again changes nothing
  await tickAt(t0 + 2 * MIN);
  assert.equal(await Notification.countDocuments(), 1);
  assert.ok((await noteOf()).readAt, 'still read');

  // 3. the first strike, 14 km away: the same episode, the card returns to unread once
  const t1 = t0 + 25 * MIN;
  await putSnapshots({ nowMs: t1, strikes: [strike('s1', t1 - MIN, north(14).lat, north(14).lon)], threat: threatJson(t0 + 20 * MIN) });
  await tickAt(t1);
  assert.equal(await HazardEvent.countDocuments({ eventKey: /^ltg:/ }), 1, 'a threat and the strikes that follow are one episode');
  event = await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean();
  assert.equal(event.hazardType, 'OBSERVED_LIGHTNING');
  assert.equal(event.source.referenceId, 's1', 'the provider id of the first strike is the stable reference');
  note = await noteOf();
  assert.equal(note.readAt, null, 'first confirmed strike after a threat');
  assert.equal(note.renotifications, 1);
  assert.match(note.message, /Lightning was detected 14 km from/);
  assert.equal(await Notification.countDocuments(), 1);
  await markRead(farmer._id, note._id, new Date(t1));

  // 4. more far pulses: silent
  const t2 = t1 + 3 * MIN;
  await putSnapshots({ nowMs: t2, strikes: [strike('s1', t1 - MIN, north(14).lat, north(14).lon), strike('s2', t2 - MIN, north(13).lat, north(13).lon)] });
  await tickAt(t2);
  note = await noteOf();
  assert.ok(note.readAt, 'a pulse does not re-notify');
  assert.equal(note.renotifications, 1);

  // 5. the first strike within 10 km: second and last re-notification
  const t3 = t2 + 3 * MIN;
  await putSnapshots({ nowMs: t3, strikes: [strike('s3', t3 - MIN, north(6).lat, north(6).lon)] });
  await tickAt(t3);
  note = await noteOf();
  assert.equal(note.readAt, null);
  assert.equal(note.renotifications, 2);
  assert.equal((await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean()).level, 3);
  await markRead(farmer._id, note._id, new Date(t3));

  // 6. a storm of close pulses: never a third re-notification
  const t4 = t3 + 3 * MIN;
  await putSnapshots({ nowMs: t4, strikes: [1, 2, 3, 4, 5, 6].map((n) => strike(`c${n}`, t4 - n * 1000, north(4).lat, north(4).lon)) });
  await tickAt(t4);
  note = await noteOf();
  assert.ok(note.readAt, 'no third re-notification');
  assert.equal(note.renotifications, 2);
  assert.equal(await Notification.countDocuments(), 1, 'one card for the whole episode');

  // 7. the episode ends 30 minutes after the last strike with the "not an all-clear" wording, and creates no new unread notification
  const t5 = t4 + 31 * MIN;
  await putSnapshots({ nowMs: t5, positive: false });
  await tickAt(t5);
  note = await noteOf();
  assert.equal(note.status, 'expired');
  assert.match(note.lifecycle.at(-1).note, /This alert period has ended\. This is not an all-clear/);
  assert.ok(note.readAt, 'the ending is quiet');
  assert.equal((await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean()).lifecycle, 'expired');

  // 8. lightning after a 30 minute quiet gap is a NEW episode with its own first notice
  const t6 = t5 + 5 * MIN;
  await putSnapshots({ nowMs: t6, strikes: [strike('n1', t6 - MIN, north(12).lat, north(12).lon)] });
  await tickAt(t6);
  assert.equal(await HazardEvent.countDocuments({ eventKey: /^ltg:/ }), 2);
  assert.equal(await Notification.countDocuments({ subscriberId: farmer._id }), 2);
  assert.equal((await Notification.find({ subscriberId: farmer._id, status: 'active' }).lean()).length, 1);
});

dbTest('stale lightning data never creates an episode, and an open episode says its data is stale instead of changing', async () => {
  const farmer = await subscribeFarmer();
  const t0 = NOW;
  await putSnapshots({ nowMs: t0 - 40 * MIN, strikes: [strike('old', t0 - 2 * MIN, north(10).lat, north(10).lon)] });
  await tickAt(t0);
  assert.equal(await HazardEvent.countDocuments({ eventKey: /^ltg:/ }), 0, 'the probe is 40 minutes old: stale, so nothing may be created from it');

  await putSnapshots({ nowMs: t0, strikes: [strike('s1', t0 - MIN, north(10).lat, north(10).lon)] });
  await tickAt(t0);
  assert.equal(await HazardEvent.countDocuments({ eventKey: /^ltg:/ }), 1);
  assert.equal((await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean()).dataStatus, 'FRESH');

  await tickAt(t0 + 20 * MIN);
  const event = await HazardEvent.findOne({ eventKey: /^ltg:/ }).lean();
  assert.equal(event.dataStatus, 'STALE', 'no fresh probe: the card must say the data is stale');
  assert.equal(event.lifecycle, 'active', 'but it is not withdrawn: stale is not an all-clear');
  assert.equal((await Notification.findOne({ subscriberId: farmer._id }).lean()).status, 'active');
});
