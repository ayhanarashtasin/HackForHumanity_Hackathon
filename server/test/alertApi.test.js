import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { errorHandler, notFound } from '../src/middleware/errorHandler.js';
import { AdminAction } from '../src/models/AdminAction.js';
import { AdminSession } from '../src/models/AdminSession.js';
import { EngineSettings } from '../src/models/EngineSettings.js';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { JobState } from '../src/models/JobState.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { createAdminRoutes } from '../src/routes/adminRoutes.js';
import { createAlertRoutes } from '../src/routes/alertRoutes.js';
import { resetSendLimit } from '../src/services/alerts/admin.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { resetForTests, setSnapshot } from '../src/services/weatherStore.js';
import { BADDA, SAVAR } from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MODELS = [Subscriber, HazardEvent, Notification, WeatherSnapshot, EngineSettings, JobState, AdminSession, AdminAction];
const HOUR = 3_600_000;
const PASSCODE = 'test-passcode-1234';

let server;
let baseUrl;
let limitedServer;
let limitedUrl;

function listen(app) {
  const instance = app.listen(0, '127.0.0.1');
  return once(instance, 'listening').then(() => ({ instance, url: `http://127.0.0.1:${instance.address().port}` }));
}

let adminRouter;

function makeApp(alertOptions) {
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use('/api/alerts', createAlertRoutes(alertOptions));
  adminRouter = createAdminRoutes({ loginLimit: { windowMs: 60_000, max: 5 } });
  app.use('/api/admin', adminRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all(MODELS.map((model) => model.init()));
  ({ instance: limitedServer, url: limitedUrl } = await listen(makeApp({ subscribeLimit: { windowMs: 60_000, max: 2 } })));
  ({ instance: server, url: baseUrl } = await listen(makeApp({ subscribeLimit: { windowMs: 60_000, max: 1000 } })));
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all(MODELS.map((model) => model.deleteMany({})));
  resetSettingsCache();
  resetSendLimit();
  resetForTests();
  adminRouter.loginLimiter.clear();
  env.admin.passcode = PASSCODE;
  env.admin.authOff = false;
  env.nodeEnv = 'test';
});

after(async () => {
  for (const instance of [server, limitedServer]) {
    if (instance) await new Promise((resolve) => { instance.close(resolve); });
  }
  resetForTests();
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

// ---------- a tiny cookie-aware client ----------
class Client {
  constructor(url = baseUrl) {
    this.url = url;
    this.cookies = new Map();
  }

  async call(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${this.url}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, headers: response.headers, setCookie: response.headers.getSetCookie(), json: text ? JSON.parse(text) : null };
  }
}

const farmerForm = (overrides = {}) => ({
  occupation: 'farmer',
  language: 'en',
  homeAreaPcode: BADDA,
  occupationData: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
  consent: true,
  ...overrides,
});

const labourerForm = () => ({
  occupation: 'rickshaw_labourer',
  language: 'en',
  homeAreaPcode: BADDA,
  occupationData: { shiftStart: '00:00', shiftEnd: '23:59', workload: 'heavy', outdoorExposure: 'on_road' },
  consent: true,
});

// Cached forecast data as the engine reads it, relative to the real clock so the admin endpoints (which use it) see "now".
async function liveWeather({ rainMm = 0, pop = 80, pcode = BADDA } = {}) {
  const now = Date.now();
  const first = Math.floor((now - 3 * HOUR) / (3 * HOUR)) * 3 * HOUR;
  const steps = Array.from({ length: 16 }, (_, i) => new Date(first + i * 3 * HOUR).toISOString());
  const rainAt = steps.findIndex((step) => Date.parse(step) >= now + HOUR);
  const column = (value, at = -1, fill = 0) => steps.map((_, i) => (i === at ? value : fill));
  const checkedAt = new Date().toISOString();

  await setSnapshot('openMeteo', {
    steps,
    locations: { [pcode]: { rf: column(rainMm, rainAt), pop: column(pop, rainAt, 20), hi: steps.map(() => 20), temp: steps.map(() => 28), wg: steps.map(() => 10), ts: steps.map(() => 0) } },
    districts: {},
  }, { dataTime: checkedAt, persistToDb: false });
  await setSnapshot('bmd', {
    sourceUpdatedAt: checkedAt,
    steps,
    locations: { [pcode]: { temp: steps.map(() => 28), rh: steps.map(() => 70), hi: steps.map(() => 20), wg: steps.map(() => 10), rf: steps.map(() => 0), ws: steps.map(() => 8) } },
    districts: {},
    daily: { days: [], locations: {} },
  }, { dataTime: checkedAt, persistToDb: false });
}

async function adminSignIn() {
  const client = new Client();
  const response = await client.call('/admin/login', { method: 'POST', body: { passcode: PASSCODE } });
  assert.equal(response.status, 200);
  return client;
}

// ---------- subscribers ----------
dbTest('the form schema is public and lists all six occupations in both languages', async () => {
  const { status, json } = await new Client().call('/alerts/schema');
  assert.equal(status, 200);
  assert.equal(json.data.occupations.length, 6);
  assert.ok(json.data.consentText.bn);
});

dbTest('completing the form creates a subscriber with an HttpOnly device cookie, and nothing but its hash is stored', async () => {
  const client = new Client();
  const created = await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  assert.equal(created.status, 201);
  const cookie = created.setCookie.find((line) => line.startsWith('as_sub='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/);

  const { profile } = created.json.data;
  assert.equal(profile.occupation, 'farmer');
  assert.equal(profile.areas[0].name, 'Badda');
  assert.equal(profile.areas[0].districtName, 'Dhaka');
  assert.equal(JSON.stringify(created.json).includes('tokenHash'), false, 'the hash is never sent to the browser');
  assert.equal(JSON.stringify(created.json).includes(client.cookies.get('as_sub')), false, 'nor the token in the body');

  const stored = await Subscriber.findOne().lean();
  assert.notEqual(stored.tokenHash, client.cookies.get('as_sub'));

  const me = await client.call('/alerts/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.profile.occupation, 'farmer');
  assert.equal(me.json.data.unread, 0);

  const session = await client.call('/alerts/session');
  assert.equal(session.status, 200);
  assert.deepEqual(session.json.data, me.json.data, 'the session check returns the same profile as /me');
  assert.equal(session.headers.get('cache-control'), 'no-store');
});

dbTest('current area is opt-in, temporary, validated and leaves saved areas intact', async () => {
  const client = new Client();
  assert.equal((await client.call('/alerts/me/current-area', { method: 'PUT', body: { upazilaPcode: SAVAR } })).status, 401);
  assert.equal((await client.call('/alerts/subscribe', { method: 'POST', body: labourerForm() })).status, 201);
  for (const body of [{ upazilaPcode: '999999' }, { upazilaPcode: SAVAR, lat: 23.8 }, {}, { upazilaPcode: 123 }]) {
    assert.equal((await client.call('/alerts/me/current-area', { method: 'PUT', body })).status, 400);
  }
  const start = await client.call('/alerts/me/current-area', { method: 'PUT', body: { upazilaPcode: SAVAR } });
  assert.equal(start.status, 200);
  assert.equal(start.json.data.profile.currentArea.upazilaPcode, SAVAR);
  assert.equal(start.json.data.profile.areas[0].upazilaPcode, BADDA);
  const stored = await Subscriber.findOne().lean();
  assert.equal(stored.currentArea.districtPcode, '3026');
  assert.ok(stored.currentArea.expiresAt > new Date());
  assert.equal(JSON.stringify(stored).includes('latitude'), false);
  const stop = await client.call('/alerts/me/current-area', { method: 'PUT', body: { upazilaPcode: null } });
  assert.equal(stop.status, 200);
  assert.equal(stop.json.data.profile.currentArea, null);
});

dbTest('the "who am I?" check is never an error: no cookie or a dead cookie gives profile null (and clears the dead cookie)', async () => {
  const anonymous = new Client();
  const none = await anonymous.call('/alerts/session');
  assert.equal(none.status, 200);
  assert.deepEqual(none.json.data, { profile: null, unread: 0 });
  assert.equal(none.setCookie.length, 0, 'nothing to clear');

  const stale = new Client();
  stale.cookies.set('as_sub', 'a'.repeat(43));
  const dead = await stale.call('/alerts/session');
  assert.equal(dead.status, 200);
  assert.equal(dead.json.data.profile, null);
  assert.ok(dead.setCookie.some((line) => line.startsWith('as_sub=') && /Max-Age=0/i.test(line)), 'the dead cookie is cleared');

  // everything that needs a profile still refuses without one
  for (const path of ['/alerts/me', '/alerts/inbox', '/alerts/me/coverage', '/alerts/me/channels']) assert.equal((await anonymous.call(path)).status, 401, path);
});

dbTest('without the cookie there is no profile; a bad form is rejected with the fields to fix', async () => {
  const anonymous = new Client();
  for (const path of ['/alerts/me', '/alerts/inbox', '/alerts/me/coverage']) assert.equal((await anonymous.call(path)).status, 401, path);

  const bad = await anonymous.call('/alerts/subscribe', { method: 'POST', body: farmerForm({ occupationData: { cropType: 'rice_aman' } }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors['occupationData.cropStage'], 'required');
  assert.equal((await anonymous.call('/alerts/subscribe', { method: 'POST', body: farmerForm({ consent: false }) })).json.errors.consent, 'consent');
  assert.equal((await anonymous.call('/alerts/subscribe', { method: 'POST', body: farmerForm({ website: 'x' }) })).status, 400, 'the honeypot');
  assert.equal(await Subscriber.countDocuments(), 0);
});

dbTest('sign-ups are rate limited per address and cross-site or non-JSON writes are refused', async () => {
  const client = new Client(limitedUrl);
  assert.equal((await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() })).status, 201);
  assert.equal((await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() })).status, 201);
  const refused = await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);

  const fresh = new Client();
  const crossSite = await fresh.call('/alerts/subscribe', { method: 'POST', body: farmerForm(), headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const sameSite = await fresh.call('/alerts/subscribe', { method: 'POST', body: farmerForm(), headers: { Origin: baseUrl } });
  assert.equal(sameSite.status, 201, 'an Origin matching the host is allowed');
  const notJson = await new Client().call('/alerts/subscribe', { method: 'POST', raw: 'occupation=farmer', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
  assert.equal(await Subscriber.countDocuments(), 3);
});

dbTest('quick status, profile edits, pausing and deleting all work through the cookie', async () => {
  const client = new Client();
  await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });

  const road = await client.call('/alerts/me/activity', { method: 'PUT', body: { key: 'on_road', hours: 3 } });
  assert.equal(road.json.data.profile.activeActivity.key, 'on_road');
  assert.equal((await client.call('/alerts/me/activity', { method: 'PUT', body: { key: 'flying' } })).status, 400);
  assert.equal((await client.call('/alerts/me/activity', { method: 'PUT', body: { key: null } })).json.data.profile.activeActivity, null);

  const edited = await client.call('/alerts/me', { method: 'PUT', body: farmerForm({ homeAreaPcode: SAVAR, language: 'bn' }) });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.profile.areas[0].name, 'Savar');
  assert.equal(edited.json.data.profile.language, 'bn');
  assert.equal((await client.call('/alerts/me', { method: 'PUT', body: { occupation: 'farmer' } })).status, 400, 'an edit is validated like the form');

  assert.equal((await client.call('/alerts/me/status', { method: 'PUT', body: { status: 'paused' } })).json.data.profile.status, 'paused');
  assert.equal((await client.call('/alerts/me/status', { method: 'PUT', body: { status: 'sleeping' } })).status, 400);

  await Notification.create({
    subscriberId: (await Subscriber.findOne())._id, hazardEventId: new mongoose.Types.ObjectId(), scenarioId: 'FARM-01', ruleVersion: 'prototype-1', ruleStatus: 'prototype',
    severity: 'WARNING', title: 't', message: 'm', affectedArea: { scope: 'upazila', text: 'x' }, reasonForSelection: 'r', hazardType: 'HEAVY_RAIN', status: 'active',
    validFrom: new Date(Date.now() - HOUR), validUntil: new Date(Date.now() + HOUR), purgeAfter: new Date(Date.now() + 30 * 24 * HOUR),
  });
  const inbox = await client.call('/alerts/inbox');
  assert.equal(inbox.json.data.items.length, 1);
  assert.equal(inbox.json.data.unread, 1);
  assert.equal((await client.call(`/alerts/inbox/${inbox.json.data.items[0].id}/read`, { method: 'POST' })).json.data.unread, 0);
  assert.equal((await client.call('/alerts/inbox/zzz/read', { method: 'POST' })).status, 400);
  assert.equal((await client.call('/alerts/inbox/read-all', { method: 'POST' })).status, 200);

  const removed = await client.call('/alerts/me', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(await Subscriber.countDocuments(), 0);
  assert.equal(await Notification.countDocuments(), 0, 'delete removes everything stored for the person');
  assert.equal((await client.call('/alerts/me')).status, 401, 'and the cookie stops working');
});

dbTest('"what we checked" never shows an unknown source as fresh, and lightning is never presented as continuous monitoring', async () => {
  const client = new Client();
  await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });

  const empty = await client.call('/alerts/me/coverage');
  const rows = Object.fromEntries(empty.json.data.rows.map((row) => [row.hazard, row]));
  assert.equal(rows.HEAVY_RAIN.status, 'UNAVAILABLE', 'no data at all is unavailable, not calm');
  assert.equal(rows.LIGHTNING.status, 'UNAVAILABLE');
  assert.equal(rows.LIGHTNING.note, 'lightning-window');

  await liveWeather();
  const loaded = Object.fromEntries((await client.call('/alerts/me/coverage')).json.data.rows.map((row) => [row.hazard, row]));
  assert.equal(loaded.HEAVY_RAIN.status, 'FRESH');
  assert.equal(loaded.HEAT_STRESS.status, 'PARTIAL', 'a computed heat index is not the preferred WBGT');
  assert.equal(loaded.HEAT_STRESS.note, 'heat-index-fallback');
  assert.equal(loaded.LIGHTNING.status, 'UNAVAILABLE', 'no lightning check has been made');

  const status = await client.call('/alerts/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.data.monitoring.areas, 1);
  assert.match(status.json.data.monitoring.lightning, /not continuous monitoring/);
  assert.equal(status.json.data.rules.status, 'prototype');
  assert.deepEqual(status.json.data.hold, []);
  assert.equal(JSON.stringify(status.json).includes(env.xweather.clientSecret || 'no-secret-configured-xyz'), false);
});

// ---------- the admin ----------
dbTest('admin is disabled until a passcode is set, and its answers are never indexed or cached', async () => {
  env.admin.passcode = '';
  const client = new Client();
  assert.equal((await client.call('/admin/availability')).json.data.configured, false);
  const closed = await client.call('/admin/me');
  assert.equal(closed.status, 503);
  assert.match(closed.json.message, /ADMIN_PASSCODE/);
  assert.equal((await client.call('/admin/login', { method: 'POST', body: { passcode: 'anything' } })).status, 503);
  assert.match(closed.headers.get('x-robots-tag'), /noindex/);
  assert.equal(closed.headers.get('cache-control'), 'no-store');

  const state = await client.call('/admin/session');
  assert.equal(state.status, 200, 'the session check is never an error');
  assert.deepEqual(state.json.data, { state: 'closed', devBypass: false });
  assert.equal(state.headers.get('cache-control'), 'no-store');
});

dbTest('admin sign-in: wrong passcode, rate limit, session cookie, sign-out', async () => {
  const client = new Client();
  assert.equal((await client.call('/admin/me')).status, 401);
  assert.equal((await client.call('/admin/overview')).status, 401);
  assert.deepEqual((await client.call('/admin/session')).json.data, { state: 'signed-out', devBypass: false }, 'asking is not an error');

  for (let i = 0; i < 5; i += 1) assert.equal((await client.call('/admin/login', { method: 'POST', body: { passcode: `wrong-${i}` } })).status, 401);
  const blocked = await client.call('/admin/login', { method: 'POST', body: { passcode: PASSCODE } });
  assert.equal(blocked.status, 429, 'five failures block even the right passcode for a while');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(await AdminAction.countDocuments({ action: 'login', outcome: 'failed' }), 5, 'failed attempts are audited');
});

dbTest('a correct passcode opens a strict, HttpOnly, hashed session that can be ended', async () => {
  const client = new Client();
  const login = await client.call('/admin/login', { method: 'POST', body: { passcode: PASSCODE } });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.find((line) => line.startsWith('as_admin='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const stored = await AdminSession.findOne().lean();
  assert.notEqual(stored.tokenHash, client.cookies.get('as_admin'));
  assert.ok(+stored.expiresAt - +stored.createdAt <= env.admin.sessionHours * HOUR);

  assert.equal((await client.call('/admin/me')).json.data.authenticated, true);
  assert.equal((await client.call('/admin/overview')).status, 200);
  assert.equal((await client.call('/admin/session')).json.data.state, 'signed-in');

  await AdminSession.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await client.call('/admin/me')).status, 401, 'an expired session is refused even before the TTL job removes it');
  assert.equal((await client.call('/admin/session')).json.data.state, 'signed-out', 'and the session check agrees');

  const again = await adminSignIn();
  assert.equal((await again.call('/admin/logout', { method: 'POST' })).status, 204);
  assert.equal((await again.call('/admin/me')).status, 401);
  assert.equal((await again.call('/admin/session')).json.data.state, 'signed-out');
  assert.ok(await AdminAction.findOne({ action: 'login', outcome: 'ok' }), 'sign-ins are audited');
});

dbTest('ADMIN_AUTH=off skips the sign-in locally and is ignored in production', async () => {
  env.admin.passcode = '';
  env.admin.authOff = true;
  const open = await new Client().call('/admin/me');
  assert.equal(open.status, 200);
  assert.equal(open.json.data.devBypass, true);
  assert.deepEqual((await new Client().call('/admin/session')).json.data, { state: 'signed-in', devBypass: true });

  env.nodeEnv = 'production';
  assert.equal((await new Client().call('/admin/me')).status, 503, 'production with no passcode stays closed');
  assert.equal((await new Client().call('/admin/session')).json.data.state, 'closed');
  env.admin.passcode = PASSCODE;
  assert.equal((await new Client().call('/admin/me')).status, 401, 'and production with a passcode needs it');
  assert.equal((await new Client().call('/admin/session')).json.data.state, 'signed-out');
});

dbTest('send now from weather: preview first, then one send, never a duplicate, and the engine agrees', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const labourer = new Client();
  await labourer.call('/alerts/subscribe', { method: 'POST', body: labourerForm() });
  await liveWeather({ rainMm: 25 });
  const admin = await adminSignIn();

  const body = { mode: 'weather', roles: ['farmer'], audience: 'live' };
  const noPreview = await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'key-without-preview' } });
  assert.equal(noPreview.status, 409, 'the server, not the page, makes the preview mandatory');
  assert.match(noPreview.json.message, /Preview this send first/);

  const previewed = await admin.call('/admin/preview', { method: 'POST', body });
  assert.equal(previewed.status, 200);
  const { data } = previewed.json;
  assert.equal(data.totals.newRecipients, 1);
  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0].scenarioId, 'FARM-01');
  assert.equal(data.groups[0].severity, 'WARNING');
  assert.ok(data.groups[0].sample.en.message && data.groups[0].sample.bn.message);
  assert.equal(data.requires.critical, false);
  assert.equal(await Notification.countDocuments(), 0, 'a preview writes no notifications');

  const mismatch = await admin.call('/admin/send', { method: 'POST', body: { ...body, roles: ['farmer', 'rickshaw_labourer'], idempotencyKey: 'key-mismatch-01', previewToken: data.previewToken } });
  assert.equal(mismatch.status, 409, 'a different send than the one previewed');

  const sent = await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'key-weather-0001', previewToken: data.previewToken } });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.data.result.sent, 1);
  const notes = await Notification.find().lean();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].publishedBy, 'admin');
  assert.equal(notes[0].occupation, 'farmer');
  assert.equal(notes[0].batchId, sent.json.data.result.batchId);
  assert.equal(notes[0].origin, 'automatic', 'it is still the engine rule, sent now');
  assert.equal((await labourer.call('/alerts/inbox')).json.data.items.length, 0, 'other roles are untouched');
  assert.equal((await farmer.call('/alerts/inbox')).json.data.items.length, 1);

  const replay = await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'key-weather-0001', previewToken: data.previewToken } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.replayed, true);
  assert.equal(await Notification.countDocuments(), 1, 'a double click sends once');

  const again = await admin.call('/admin/preview', { method: 'POST', body });
  assert.equal(again.json.data.totals.newRecipients, 0);
  assert.equal(again.json.data.totals.alreadySent, 1, 'the preview says it was already sent');
  const reused = await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'key-weather-0002', previewToken: data.previewToken } });
  assert.equal(reused.status, 409, 'a preview can only be used once');

  const { runTick } = await import('../src/services/alerts/engine.js');
  await runTick({});
  assert.equal(await Notification.countDocuments({ occupation: 'farmer' }), 1, 'the next engine pass creates no duplicate');
});

dbTest('a role with nothing to send says why, and never "all clear"', async () => {
  const client = new Client();
  await client.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  await liveWeather({ rainMm: 0 });
  const admin = await adminSignIn();
  const preview = await admin.call('/admin/preview', { method: 'POST', body: { mode: 'weather', roles: ['farmer', 'vendor'], audience: 'live' } });
  const byRole = Object.fromEntries(preview.json.data.nothing.map((row) => [row.role, row]));
  assert.equal(byRole.farmer.reason, 'no-hazard');
  assert.equal(byRole.vendor.reason, 'no-subscribers');
  assert.ok(byRole.farmer.sources.some((source) => source.key === 'bmd' && source.status === 'FRESH'));
  assert.doesNotMatch(JSON.stringify(preview.json), /all[- ]clear/i);
});

dbTest('declare a hazard: role-specific wording, a support check, typed and critical confirmations, and updates instead of duplicates', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const construction = new Client();
  await construction.call('/alerts/subscribe', { method: 'POST', body: { ...labourerForm(), occupation: 'construction', occupationData: { activityType: 'roof', workload: 'heavy', ppeHeatBurden: 'light', siteExposure: 'open', shiftStart: '00:00', shiftEnd: '23:59' } } });
  await liveWeather({ rainMm: 0 });
  const admin = await adminSignIn();
  const area = { upazilas: [BADDA] };

  // Rain that the data does not show needs a typed confirmation.
  const rain = { mode: 'declare', hazardType: 'HEAVY_RAIN', level: 2, hours: 4, roles: ['farmer'], areas: area };
  const rainPreview = (await admin.call('/admin/preview', { method: 'POST', body: rain })).json.data;
  assert.equal(rainPreview.support.supported, 'no');
  assert.equal(rainPreview.requires.typed, 'SEND');
  assert.ok(rainPreview.warnings[0].includes('does not show'));
  const blocked = await admin.call('/admin/send', { method: 'POST', body: { ...rain, idempotencyKey: 'declare-rain-0001', previewToken: rainPreview.previewToken } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, /Type SEND/);
  const rainSent = await admin.call('/admin/send', { method: 'POST', body: { ...rain, idempotencyKey: 'declare-rain-0002', previewToken: rainPreview.previewToken, confirm: { typed: 'SEND' } } });
  assert.equal(rainSent.status, 201);
  const declared = await HazardEvent.findOne({ origin: 'admin-declared' }).lean();
  assert.equal(declared.level, 2);
  assert.equal(declared.evidence.asserted.by, 'administrator');
  const farmerNote = await Notification.findOne({ occupation: 'farmer' }).lean();
  assert.equal(farmerNote.origin, 'admin-declared');
  assert.equal(farmerNote.ruleStatus, 'admin');
  assert.match(farmerNote.message, /An administrator has declared heavy rain/);
  assert.match(farmerNote.message, /not detected from weather data/);
  assert.equal(await Notification.countDocuments({ occupation: 'construction' }), 0, 'only the chosen role');

  // Lightning: CRITICAL, so it needs the second confirmation, and each role gets its own wording.
  const strike = { mode: 'declare', hazardType: 'OBSERVED_LIGHTNING', level: 2, hours: 1, roles: ['farmer', 'construction'], areas: area };
  const strikePreview = (await admin.call('/admin/preview', { method: 'POST', body: strike })).json.data;
  assert.equal(strikePreview.requires.critical, true);
  assert.deepEqual(strikePreview.groups.map((g) => g.scenarioId).sort(), ['CONS-01', 'FARM-04']);
  const noConfirm = await admin.call('/admin/send', { method: 'POST', body: { ...strike, idempotencyKey: 'declare-ltg-00001', previewToken: strikePreview.previewToken } });
  assert.equal(noConfirm.status, 409);
  assert.match(noConfirm.json.message, /CRITICAL alert to 2 people/);
  const strikeSent = await admin.call('/admin/send', { method: 'POST', body: { ...strike, idempotencyKey: 'declare-ltg-00002', previewToken: strikePreview.previewToken, confirm: { critical: true } } });
  assert.equal(strikeSent.status, 201);
  const criticals = await Notification.find({ severity: 'CRITICAL' }).sort({ occupation: 1 }).lean();
  assert.deepEqual(criticals.map((n) => [n.occupation, n.scenarioId]), [['construction', 'CONS-01'], ['farmer', 'FARM-04']]);
  assert.notEqual(criticals[0].message, criticals[1].message);

  // Declaring the same hazard for the same area updates the event instead of creating a second one.
  const raise = { ...strike, level: 3 };
  const raisePreview = (await admin.call('/admin/preview', { method: 'POST', body: raise })).json.data;
  assert.equal(raisePreview.updatesExisting, true);
  const raised = await admin.call('/admin/send', { method: 'POST', body: { ...raise, idempotencyKey: 'declare-ltg-00003', previewToken: raisePreview.previewToken, confirm: { critical: true } } });
  assert.equal(raised.json.data.result.updatesExisting, true);
  assert.equal(await HazardEvent.countDocuments({ hazardType: 'OBSERVED_LIGHTNING' }), 1);
  assert.equal(await Notification.countDocuments({ severity: 'CRITICAL' }), 2, 'one card each');

  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...strike, level: 1 } })).status, 400, 'lightning is declared at level 2 or 3');
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...strike, hours: 200 } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...strike, roles: [] } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...strike, roles: ['pirate'] } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...strike, areas: { districts: ['9999'] } } })).status, 400);
});

dbTest('declare a hazard: everyone chosen in the area receives it, even an occupation with no catalogue scenario for this hazard', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() }); // matches FARM-01
  const fisherman = new Client();
  // HEAVY_RAIN has no fisherman scenario at all (fisherman.js only covers lightning and marine/wind hazards).
  await fisherman.call('/alerts/subscribe', { method: 'POST', body: { ...farmerForm(), occupation: 'fisherman', occupationData: { waterBody: 'river', status: 'ashore' } } });
  const admin = await adminSignIn();
  const rain = { mode: 'declare', hazardType: 'HEAVY_RAIN', level: 2, hours: 4, roles: ['farmer', 'fisherman'], areas: { upazilas: [BADDA] } };

  const preview = (await admin.call('/admin/preview', { method: 'POST', body: rain })).json.data;
  assert.equal(preview.totals.newRecipients, 2, 'both the matched farmer and the unmatched fisherman are counted');
  assert.deepEqual(preview.groups.map((g) => g.scenarioId).sort(), ['ADMIN-GENERAL', 'FARM-01']);
  const general = preview.groups.find((g) => g.scenarioId === 'ADMIN-GENERAL');
  assert.equal(general.occupation, 'fisherman');
  assert.equal(general.hazardType, 'HEAVY_RAIN');
  assert.equal(general.level, 2);

  assert.equal(preview.requires.typed, null, 'no cached weather data either way: the support check is unknown, not "no"');
  const sent = await admin.call('/admin/send', { method: 'POST', body: { ...rain, idempotencyKey: 'declare-general-0001', previewToken: preview.previewToken } });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.data.result.sent, 2);

  const farmerNote = await Notification.findOne({ occupation: 'farmer' }).lean();
  assert.equal(farmerNote.scenarioId, 'FARM-01');
  // Stored bilingually, so the inbox's language toggle can show this already-sent alert either way, not only new ones.
  assert.equal(farmerNote.lang, 'en');
  assert.equal(farmerNote.translations.en.title, farmerNote.title);
  assert.notEqual(farmerNote.translations.bn.title, farmerNote.title);
  assert.match(farmerNote.translations.bn.message, /[ঀ-৿]/u, 'the Bangla reading is actually in Bangla');
  assert.equal(farmerNote.translations.bn.affectedArea.upazilaPcode, farmerNote.affectedArea.upazilaPcode, 'the place itself does not change with language');

  const fishermanNote = await Notification.findOne({ occupation: 'fisherman' }).lean();
  assert.equal(fishermanNote.scenarioId, 'ADMIN-GENERAL');
  assert.equal(fishermanNote.origin, 'admin-declared');
  assert.equal(fishermanNote.ruleVersion, 'admin');
  assert.equal(fishermanNote.severity, 'WARNING', 'declared level 2, non-lightning: WARNING, never CRITICAL for a hazard the catalogue itself never sends as CRITICAL');
  assert.match(fishermanNote.message, /An administrator has declared heavy rain/);
  assert.match(fishermanNote.translations.bn.message, /ঘোষণা করেছেন/, 'the generic fallback is bilingual too');
  assert.match(fishermanNote.message, /not detected from weather data/);
  assert.equal((await fisherman.call('/alerts/inbox')).json.data.items[0].scenarioId, 'ADMIN-GENERAL');

  // Sending again for the same declaration does not duplicate either notification.
  const again = (await admin.call('/admin/preview', { method: 'POST', body: rain })).json.data;
  assert.equal(again.totals.newRecipients, 0);
  assert.equal(again.totals.alreadySent, 2);
});

dbTest('a free message: validated, linted, labelled as the administrator and never as BMD', async () => {
  const vendor = new Client();
  await vendor.call('/alerts/subscribe', { method: 'POST', body: { ...farmerForm(), occupation: 'vendor', occupationData: { outdoorStall: true, shelterAccess: 'partial', hoursOutdoor: '4to8' } } });
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const admin = await adminSignIn();
  const message = {
    mode: 'message', severity: 'ADVISORY', roles: ['vendor'], areas: { districts: ['3026'] }, hours: 6,
    title: { en: 'Market closed' }, text: { en: 'The Friday market is closed. Everything is all clear for the weekend.' }, actions: ['check_forecast'], referenceUrl: 'https://example.org/notice',
  };

  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, referenceUrl: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, referenceUrl: 'ftp://example.org' } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, text: { en: '' } } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, text: { en: 'x'.repeat(601) } } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, severity: 'PANIC' } })).status, 400);
  assert.equal((await admin.call('/admin/preview', { method: 'POST', body: { ...message, actions: ['launch_missiles'] } })).status, 400);

  const preview = (await admin.call('/admin/preview', { method: 'POST', body: message })).json.data;
  assert.ok(preview.warnings.some((warning) => /all clear/.test(warning)), 'the soft lint warns but does not block');
  assert.equal(preview.totals.newRecipients, 1);

  const sent = await admin.call('/admin/send', { method: 'POST', body: { ...message, idempotencyKey: 'message-send-0001', previewToken: preview.previewToken } });
  assert.equal(sent.status, 201);
  const note = await Notification.findOne().lean();
  assert.equal(note.scenarioId, 'ADMIN-MSG');
  assert.equal(note.occupation, 'vendor');
  assert.equal(note.origin, 'admin-message');
  assert.equal(note.sourceReferences[0].provider, 'admin');
  assert.equal(note.sourceReferences[0].url, 'https://example.org/notice');
  assert.equal(await Notification.countDocuments({ occupation: 'farmer' }), 0);

  const inbox = (await vendor.call('/alerts/inbox')).json.data.items[0];
  assert.equal(inbox.sender, 'administrator');
  assert.equal(inbox.origin, 'admin-message');
});

dbTest('withdrawing a send marks it withdrawn, never an all-clear, and a second withdrawal finds nothing', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  await liveWeather({ rainMm: 25 });
  const admin = await adminSignIn();
  const body = { mode: 'weather', roles: ['farmer'], audience: 'live' };
  const preview = (await admin.call('/admin/preview', { method: 'POST', body })).json.data;
  const sent = (await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'withdraw-flow-001', previewToken: preview.previewToken } })).json.data.result;

  const withdrawn = await admin.call(`/admin/alerts/${sent.batchId}/withdraw`, { method: 'POST', body: { reason: 'Sent too early' } });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.json.data.notifications, 1);
  const note = await Notification.findOne().lean();
  assert.equal(note.status, 'withdrawn');
  assert.match(note.lifecycle.at(-1).note, /withdrew this alert\. This is not an all-clear\. Reason: Sent too early/);
  const earlier = (await farmer.call('/alerts/inbox?view=earlier')).json.data.items[0];
  assert.equal(earlier.status, 'withdrawn');
  assert.equal((await admin.call(`/admin/alerts/${sent.batchId}/withdraw`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await admin.call('/admin/alerts/not-an-id/withdraw', { method: 'POST', body: {} })).status, 400);

  const history = (await admin.call('/admin/history')).json.data;
  assert.equal(history.sends.find((entry) => entry.action === 'send-weather').delivery.total, 1);
  assert.ok(history.sends.some((entry) => entry.action === 'withdraw'));
  assert.ok(history.automatic.length >= 1);
});

dbTest('withdrawing an automatic (engine-detected) event by its own id cannot be repeated either', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  await liveWeather({ rainMm: 25 });
  const admin = await adminSignIn();
  const { runTick } = await import('../src/services/alerts/engine.js');
  await runTick({});

  const before = (await admin.call('/admin/history')).json.data;
  const eventId = before.automatic.find((event) => event.lifecycle === 'active').id;

  const first = await admin.call(`/admin/alerts/${eventId}/withdraw`, { method: 'POST', body: { reason: 'False positive' } });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.events, 1);
  const event = await HazardEvent.findById(eventId).lean();
  assert.equal(event.lifecycle, 'withdrawn');
  assert.equal(event.withdrawal.reason, 'False positive');

  // Withdrawing the same event id again must not silently "succeed" a second time: nothing new is withdrawn, so it is 404, exactly
  // like a repeated withdrawal by batch id already is above. Overwriting who withdrew it, when and why is never acceptable either.
  const second = await admin.call(`/admin/alerts/${eventId}/withdraw`, { method: 'POST', body: { reason: 'Someone else, later, different reason' } });
  assert.equal(second.status, 404);
  const unchanged = await HazardEvent.findById(eventId).lean();
  assert.equal(unchanged.withdrawal.reason, 'False positive', 'the first withdrawal record is not overwritten by the repeat');
  assert.equal(unchanged.revision, event.revision, 'and nothing about it was touched again');

  const history = (await admin.call('/admin/history')).json.data;
  assert.equal(history.sends.filter((entry) => entry.action === 'withdraw').length, 1, 'only the one real withdrawal is in the audit trail');
});

dbTest('a send that fails is not replayed as "already sent": the same click retries for real', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const admin = await adminSignIn();
  const declare = {
    mode: 'declare', hazardType: 'HEAVY_RAIN', level: 1, hours: 4, roles: ['farmer'], areas: { upazilas: [BADDA] },
  };

  // Record a failed attempt under a known key, the same way send() itself would after an exception (e.g. the rate limit, or any
  // other failure between claiming the key and finishing).
  const key = 'retry-after-failure-0001';
  await AdminAction.create({
    at: new Date(), action: 'declare', idempotencyKey: key, outcome: 'failed', reason: 'At most 20 sends an hour.',
  });

  const preview = (await admin.call('/admin/preview', { method: 'POST', body: declare })).json.data;
  const retried = await admin.call('/admin/send', { method: 'POST', body: { ...declare, idempotencyKey: key, previewToken: preview.previewToken } });
  assert.equal(retried.status, 201, 'a real attempt, not a replay of the dead one');
  assert.equal(retried.json.data.replayed, false);
  assert.equal(retried.json.data.result.sent, 1, 'the alert actually went out this time, not "0 sent"');
  assert.equal(await Notification.countDocuments({ occupation: 'farmer' }), 1);
  const action = await AdminAction.findOne({ idempotencyKey: key }).lean();
  assert.equal(action.outcome, 'ok', 'the one row for this key now reflects the real send, not the dead attempt');

  // The key is now used up by a real send, exactly like any other: replaying it again sends nothing more.
  const replay = await admin.call('/admin/send', { method: 'POST', body: { ...declare, idempotencyKey: key, previewToken: preview.previewToken } });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.replayed, true);
  assert.equal(await Notification.countDocuments({ occupation: 'farmer' }), 1, 'still just the one notification');
});

dbTest('hold and kill switches are validated, audited and visible; a hold keeps alerts away from the inbox until they are released', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  await liveWeather({ rainMm: 25 });
  const admin = await adminSignIn();

  assert.equal((await admin.call('/admin/settings', { method: 'PUT', body: { hold: { LOUD: true } } })).status, 400);
  assert.equal((await admin.call('/admin/settings', { method: 'PUT', body: { hold: { WARNING: 'yes' } } })).status, 400);
  assert.equal((await admin.call('/admin/settings', { method: 'PUT', body: {} })).status, 400);
  const on = await admin.call('/admin/settings', { method: 'PUT', body: { hold: { WARNING: true } } });
  assert.equal(on.json.data.hold.WARNING, true);
  assert.equal(on.json.data.hold.CRITICAL, false, 'only what was asked for');
  assert.deepEqual((await farmer.call('/alerts/status')).json.data.hold, ['WARNING']);

  const { runTick } = await import('../src/services/alerts/engine.js');
  await runTick({});
  assert.equal((await farmer.call('/alerts/inbox')).json.data.items.length, 0, 'held: nothing reaches the subscriber');
  const overview = (await admin.call('/admin/overview')).json.data;
  assert.equal(overview.held.total, 1);
  assert.equal(overview.held.bySeverity.WARNING, 1);

  const body = { mode: 'weather', roles: ['farmer'], audience: 'live' };
  const preview = (await admin.call('/admin/preview', { method: 'POST', body })).json.data;
  assert.equal(preview.totals.released, 1, 'sending releases the held alert');
  await admin.call('/admin/send', { method: 'POST', body: { ...body, idempotencyKey: 'release-held-0001', previewToken: preview.previewToken } });
  assert.equal((await farmer.call('/alerts/inbox')).json.data.items.length, 1);

  assert.ok(await AdminAction.findOne({ action: 'settings' }), 'settings changes are audited');
  const discarded = await admin.call('/admin/held/discard', { method: 'POST', body: {} });
  assert.equal(discarded.json.data.discarded, 0);
});

dbTest('demo subscribers can be created per role, viewed as the subscriber sees them, and removed', async () => {
  const admin = await adminSignIn();
  const created = await admin.call('/admin/demo/subscribers', { method: 'POST', body: { areaPcode: BADDA } });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.length, 6);
  assert.deepEqual(created.json.data.map((row) => row.occupation).sort(), ['construction', 'farmer', 'fisherman', 'rickshaw_labourer', 'student_public', 'vendor']);
  assert.equal((await admin.call('/admin/demo/subscribers', { method: 'POST', body: { areaPcode: BADDA } })).json.data.length, 6, 'creating twice does not duplicate');
  assert.equal((await admin.call('/admin/demo/subscribers', { method: 'POST', body: { areaPcode: 'nope' } })).status, 400);

  const live = new Client();
  await live.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const demoFarmer = created.json.data.find((row) => row.occupation === 'farmer');
  const view = await admin.call(`/admin/demo/subscribers/${demoFarmer.id}/inbox`);
  assert.equal(view.status, 200);
  assert.equal(view.json.data.occupation, 'farmer');
  const liveId = String((await Subscriber.findOne({ isDemo: false }))._id);
  assert.equal((await admin.call(`/admin/demo/subscribers/${liveId}/inbox`)).status, 404, 'a real subscriber can never be viewed through the admin');

  assert.equal((await admin.call('/admin/demo/subscribers', { method: 'DELETE' })).json.data.deleted, 6);
  assert.equal(await Subscriber.countDocuments({ isDemo: true }), 0);
  assert.equal(await Subscriber.countDocuments({ isDemo: false }), 1);
});

dbTest('the demo audience never reaches live subscribers, and live sends never reach demo subscribers', async () => {
  const live = new Client();
  await live.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const admin = await adminSignIn();
  await admin.call('/admin/demo/subscribers', { method: 'POST', body: { areaPcode: BADDA } });
  await liveWeather({ rainMm: 25 });

  const demo = { mode: 'weather', roles: ['farmer'], audience: 'demo' };
  const preview = (await admin.call('/admin/preview', { method: 'POST', body: demo })).json.data;
  await admin.call('/admin/send', { method: 'POST', body: { ...demo, idempotencyKey: 'demo-audience-001', previewToken: preview.previewToken } });
  assert.equal((await live.call('/alerts/inbox')).json.data.items.length, 0);
  assert.equal(await Notification.countDocuments({ isDemo: true, occupation: 'farmer' }), 1);
});

dbTest('declaration roles and demo/live audiences stay bounded on later engine ticks and subscription backfill', async () => {
  const live = new Client();
  await live.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  const labourer = new Client();
  await labourer.call('/alerts/subscribe', { method: 'POST', body: labourerForm() });
  const admin = await adminSignIn();
  await admin.call('/admin/demo/subscribers', { method: 'POST', body: { areaPcode: BADDA } });
  const { runTick } = await import('../src/services/alerts/engine.js');
  const declare = async (audience, key) => {
    const body = { mode: 'declare', hazardType: 'HEAVY_RAIN', level: 2, hours: 6, roles: ['farmer'], audience, areas: { upazilas: [BADDA] } };
    const preview = (await admin.call('/admin/preview', { method: 'POST', body })).json.data;
    const result = await admin.call('/admin/send', { method: 'POST', body: { ...body, previewToken: preview.previewToken, idempotencyKey: key, confirm: { typed: 'SEND' } } });
    assert.equal(result.status, 201);
  };
  await declare('demo', 'bounded-demo-001');
  await runTick();
  assert.equal((await live.call('/alerts/inbox')).json.data.items.length, 0);
  assert.equal((await labourer.call('/alerts/inbox')).json.data.items.length, 0);
  await new Client().call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  assert.equal(await Notification.countDocuments({ isDemo: false }), 0, 'backfill cannot leak the demo event');
  await declare('live', 'bounded-live-001');
  assert.equal(await HazardEvent.countDocuments({ origin: 'admin-declared' }), 2, 'live and demo declarations cannot update one another');
  await runTick();
  assert.equal((await labourer.call('/alerts/inbox')).json.data.items.length, 0, 'the farmer-only declaration stays farmer-only');
  assert.equal(await Notification.countDocuments({ isDemo: false, occupation: 'farmer' }), 2);
  assert.equal(await Notification.countDocuments({ isDemo: true, occupation: { $ne: 'farmer' } }), 0);
});

dbTest('the overview reports subscribers by role, sources, budget and engine health without leaking secrets', async () => {
  const farmer = new Client();
  await farmer.call('/alerts/subscribe', { method: 'POST', body: farmerForm() });
  await new Client().call('/alerts/subscribe', { method: 'POST', body: labourerForm() });
  await liveWeather();
  const admin = await adminSignIn();
  const { data } = (await admin.call('/admin/overview')).json;
  assert.equal(data.subscribers.byRole.farmer, 1);
  assert.equal(data.subscribers.byRole.rickshaw_labourer, 1);
  assert.equal(data.subscribers.byDivision.Dhaka, 2);
  assert.equal(data.monitoring.areas, 1);
  assert.ok(data.sources.some((source) => source.key === 'bmd' && source.status === 'FRESH'));
  assert.ok(data.sources.some((source) => source.key === 'xweather-forecast'));
  assert.equal(typeof data.budget.perDay, 'number');
  assert.equal(data.rules.status, 'prototype');
  assert.equal(JSON.stringify(data).includes(PASSCODE), false);

  const rules = (await admin.call('/admin/rules')).json.data;
  assert.equal(rules.version, 'prototype-1');
  assert.ok(rules.thresholds.every((row) => row.status === 'prototype'), 'nothing is validated until a reviewer says so');
  assert.ok(rules.thresholds.some((row) => row.id === 'HEAVY_RAIN.L2'));
});
