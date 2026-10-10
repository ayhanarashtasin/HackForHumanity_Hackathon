import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { EngineSettings } from '../src/models/EngineSettings.js';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { JobState } from '../src/models/JobState.js';
import { Notification } from '../src/models/Notification.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { PRODUCTS, bulletinMetadata, bulletinStatus, classifyBulletin, discoverLink, extractPdfText, isBmdHost, refreshProduct } from '../src/services/bmdBulletins.js';
import { runBulletins } from '../src/services/alerts/cycle.js';
import { newStats, runTick } from '../src/services/alerts/engine.js';
import { listInbox } from '../src/services/alerts/inbox.js';
import { officialStage } from '../src/services/alerts/officialNotices.js';
import { resetSettingsCache } from '../src/services/alerts/settings.js';
import { saveSnapshot } from '../src/services/alerts/snapshots.js';
import { bulletinList, coverageFor } from '../src/services/alerts/status.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { BADDA } from './support/alertFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MODELS = [EngineSettings, HazardEvent, JobState, Notification, Subscriber, WeatherSnapshot];
const HOUR = 3_600_000;
const product = PRODUCTS[0];
const TEXT = 'WEATHER FORECAST OVER NORTH BAY VALID FOR 24 HOURS COMMENCING 1200 HOURS BST OF 10.10.2026:\nPART ONE: LOCAL CAUTIONARY SIGNAL NO. 3';

// Synthetic Type0 PDF using the same ToUnicode/text operators as the inspected BMD files. Never calls a provider.
function pdf(text) {
  const hex = [...text].map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Font << /F1 2 0 R >> >> endobj\n2 0 obj << /ToUnicode 3 0 R >> endobj\n3 0 obj << >> stream\n1 beginbfrange\n<0020> <007e> <0020>\nendbfrange\nendstream endobj\n4 0 obj << >> stream\nBT /F1 12 Tf 1 0 0 1 20 20 Tm <${hex}> Tj ET\nendstream endobj`);
}

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all(MODELS.map((model) => model.init()));
});
beforeEach(async () => {
  if (!testUri) return;
  await Promise.all(MODELS.map((model) => model.deleteMany({})));
  resetSettingsCache();
});
after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

test('only dated HTTPS documents on BMD hosts are discovered', () => {
  assert.equal(isBmdHost('https://live8.bmd.gov.bd/file.pdf'), true);
  for (const url of ['http://bmd.gov.bd/file.pdf', 'https://fakebmd.gov.bd/file.pdf', 'https://bmd.gov.bd.evil.test/file.pdf']) assert.equal(isBmdHost(url), false);
  assert.equal(discoverLink('<a href="https://fakebmd.gov.bd/file/2026/10/10/pdf/123.pdf">'), null);
  assert.equal(discoverLink('https://bmd.gov.bd/file/2026/02/31/pdf/123.pdf'), null);
  assert.equal(discoverLink('https://live8.bmd.gov.bd/file/2026/10/10/pdf/123.pdf').fileId, '123');
});

test('the best-effort extractor reads mapped text and leaves unreadable/scanned PDFs unknown', () => {
  assert.equal(extractPdfText(pdf('PART ONE: NO STORM WARNING.')), 'PART ONE: NO STORM WARNING.');
  assert.equal(extractPdfText(Buffer.from('%PDF-1.4 scanned image only')), null);
});

test('letterheads and no-warning statements are not warnings, and contradictory text is unknown', () => {
  assert.equal(classifyBulletin('Storm Warning Center\nPART ONE: NO STORM WARNING.').statement, 'no-warning');
  assert.equal(classifyBulletin('There is no inland river-port warning. NO SIGNAL.').statement, 'no-warning');
  assert.equal(classifyBulletin('LOCAL CAUTIONARY SIGNAL NO. 3').statement, 'warning');
  assert.equal(classifyBulletin('GREAT DANGER SIGNAL NUMBER 10').greatDanger, true);
  assert.equal(classifyBulletin('NO STORM WARNING. LOCAL WARNING SIGNAL NO. 4').statement, 'unknown');
  assert.equal(classifyBulletin('RAIN/THUNDER OVER NORTH BAY').statement, 'unknown');
});

test('bulletin validity honours BST, UTC and future starts, and C-90 is never assigned to North Bay', () => {
  const fishing = bulletinMetadata(TEXT, product);
  assert.equal(fishing.validFrom, '2026-10-10T06:00:00.000Z');
  assert.equal(fishing.validUntil, '2026-10-11T06:00:00.000Z');
  assert.equal(fishing.validityAssumed, false);
  assert.equal(fishing.marineZone, 'north_bay');
  const fleet = bulletinMetadata('FLEET FORECAST FOR AREA C-90 VALID FOR 12 HOURS COMMENCING 1000 UTC OF 10.10.2026: MONSOON IS WEAK OVER NORTH BAY.', PRODUCTS[1]);
  assert.equal(fleet.validFrom, '2026-10-10T10:00:00.000Z');
  assert.equal(fleet.validUntil, '2026-10-10T22:00:00.000Z');
  assert.equal(fleet.marineZone, null);
  const sea = bulletinMetadata('BANGLADESH AT 10.10.2026, 0300 UTC: WEATHER OVER NORTH BAY', PRODUCTS[2]);
  assert.equal(sea.issuedAt, '2026-10-10T03:00:00.000Z');
  assert.equal(sea.validityAssumed, true);
  assert.equal(bulletinMetadata(TEXT.replace('1200', '2500'), product).validFrom, null);
  assert.equal(bulletinMetadata(TEXT.replace('10.10.2026', '31.02.2026'), product).validFrom, null);
});

test('an unreadable document is partial, a dated expired document is stale even after a fresh page check', () => {
  const now = Date.now();
  const row = { status: 'FRESH', fetchedAt: new Date(now), data: { parserStatus: 'parsed', validUntil: new Date(now - 1).toISOString() } };
  assert.equal(bulletinStatus(row, now), 'STALE');
  row.data.validUntil = new Date(now + HOUR).toISOString();
  assert.equal(bulletinStatus(row, now), 'FRESH');
  row.data.parserStatus = 'link-only';
  assert.equal(bulletinStatus(row, now), 'PARTIAL');
});

const subscriber = (waterBody = 'coastal') => createSubscriber({
  occupation: 'fisherman', language: 'en', homeAreaPcode: BADDA, consent: true, occupationData: { waterBody, status: 'ashore' },
});
async function snapshot(nowMs, overrides = {}) {
  const data = {
    fileId: '123', issuedDate: new Date(nowMs).toISOString().slice(0, 10), issuedAt: new Date(nowMs - HOUR).toISOString(),
    validFrom: new Date(nowMs - HOUR).toISOString(), validUntil: new Date(nowMs + 6 * HOUR).toISOString(),
    documentUrl: 'https://www.bmd.gov.bd/file/2026/10/11/pdf/123.pdf', documentFound: true,
    parserStatus: 'parsed', statement: 'warning', signals: [{ text: 'LOCAL CAUTIONARY SIGNAL NO. 3', number: 3 }],
    signalText: 'LOCAL CAUTIONARY SIGNAL NO. 3', marineZone: 'north_bay', validityAssumed: false, ...overrides,
  };
  return saveSnapshot({ provider: 'bmd', product: 'bulletin', queryKey: product.key, status: 'FRESH', now: new Date(nowMs), data });
}
const tick = (nowMs) => runTick({ nowMs, extraStages: [officialStage] });

dbTest('official warnings reach eligible water-area subscribers once, remain quoted, and polling never extends validity', async () => {
  const now = Date.now();
  const { subscriber: coastal } = await subscriber();
  await subscriber('river');
  await snapshot(now);
  await tick(now);
  const event = await HazardEvent.findOne({ hazardType: 'OFFICIAL_NOTICE' }).lean();
  assert.equal(await Notification.countDocuments(), 1);
  const first = (await listInbox(coastal._id, { now: new Date(now) })).items[0];
  assert.equal(first.sender, 'official');
  assert.equal(first.evidence.official.signalText, 'LOCAL CAUTIONARY SIGNAL NO. 3');
  const officialCoverage = (await coverageFor(coastal, now)).find((row) => row.hazard === 'OFFICIAL_NOTICE');
  assert.equal(officialCoverage.status, 'FRESH');
  await Notification.updateOne({ _id: first.id }, { $set: { readAt: new Date(now) } });
  await tick(now + 2 * 60_000);
  assert.equal(await Notification.countDocuments(), 1);
  assert.equal(+(await HazardEvent.findById(event._id)).validUntil, +event.validUntil);
  assert.ok((await Notification.findById(first.id)).readAt, 'same evidence never re-notifies');
  await tick(+event.validUntil + 1);
  assert.equal((await HazardEvent.findById(event._id)).lifecycle, 'expired');
});

dbTest('unknown, missing, stale and unverified-area bulletins never create alerts; failed refresh annotates existing cards', async () => {
  const now = Date.now();
  const { subscriber: coastal } = await subscriber();
  for (const data of [{ parserStatus: 'link-only' }, { documentFound: false }, { statement: 'unknown' }, { marineZone: null }, { validUntil: new Date(now - 1).toISOString() }]) {
    await snapshot(now, data);
    await tick(now);
    assert.equal(await Notification.countDocuments(), 0);
  }
  await snapshot(now);
  await tick(now);
  await saveSnapshot({ provider: 'bmd', product: 'bulletin', queryKey: product.key, status: 'UNAVAILABLE', now: new Date(now + 60_000) });
  await tick(now + 60_000);
  assert.equal((await HazardEvent.findOne({ hazardType: 'OFFICIAL_NOTICE' })).dataStatus, 'UNAVAILABLE');
  assert.equal((await listInbox(coastal._id, { now: new Date(now + 60_000) })).items[0].dataStatus, 'UNAVAILABLE');
  await subscriber();
  await tick(now + 60_000);
  assert.equal(await Notification.countDocuments(), 1, 'a stale event cannot send a first notice to a new subscriber');
});

dbTest('only a newer, effective dated no-warning withdraws; the transition is separate and older warnings cannot return', async () => {
  const now = Date.now();
  await subscriber();
  await snapshot(now);
  await tick(now);
  const warning = await HazardEvent.findOne({ hazardType: 'OFFICIAL_NOTICE' });
  for (const issuedAt of [new Date(now - 2 * HOUR), new Date(now - HOUR)]) {
    await snapshot(now, { fileId: '124', statement: 'no-warning', issuedAt: issuedAt.toISOString() });
    await tick(now);
    assert.equal((await HazardEvent.findById(warning._id)).lifecycle, 'active');
  }
  await snapshot(now, { fileId: '124', statement: 'no-warning', issuedAt: new Date(now).toISOString(), validFrom: new Date(now + HOUR).toISOString() });
  await tick(now);
  assert.equal((await HazardEvent.findById(warning._id)).lifecycle, 'active', 'future validity is not effective yet');
  await snapshot(now, { fileId: '124', statement: 'no-warning', issuedAt: new Date(now).toISOString() });
  await tick(now);
  const withdrawn = await HazardEvent.findById(warning._id);
  assert.equal(withdrawn.lifecycle, 'withdrawn');
  assert.equal(withdrawn.withdrawal.source, 'official');
  assert.equal(await Notification.countDocuments({ scenarioId: 'FISH-03', status: 'active' }), 1);
  assert.equal(await Notification.countDocuments({ scenarioId: 'FISH-01', status: 'withdrawn' }), 1);
  await snapshot(now, { fileId: '123', issuedAt: new Date(now - HOUR).toISOString() });
  await tick(now);
  assert.equal(await HazardEvent.countDocuments(), 2, 'the older warning is never resurrected');
});

dbTest('PDF failures retain dated links as partial and retry on the next page check; blank pages are never withdrawals', async () => {
  const link = 'https://live8.bmd.gov.bd/file/2026/10/10/pdf/123.pdf';
  const page = () => new Response(`<a href="${link}">Bulletin</a>`);
  const failing = async (url) => { if (url.includes('/pdf/')) throw new Error('offline'); return page(); };
  await refreshProduct(product, { fetchImpl: failing });
  let row = await WeatherSnapshot.findOne({ queryKey: product.key }).lean();
  assert.equal(row.status, 'PARTIAL');
  assert.equal(row.data.parserStatus, 'link-only');
  assert.equal((await bulletinList())[0].documentUrl, link);
  let downloads = 0;
  await refreshProduct(product, { previous: row, fetchImpl: async (url) => { if (!url.includes('/pdf/')) return page(); downloads += 1; return new Response(pdf(TEXT.replace(/\n/g, ' '))); } });
  assert.equal(downloads, 1, 'the unchanged failed PDF is retried');
  row = await WeatherSnapshot.findOne({ queryKey: product.key }).lean();
  assert.equal(row.data.parserStatus, 'parsed');
  const validUntil = +row.validTo;
  await refreshProduct(product, { previous: row, fetchImpl: async () => page() });
  assert.equal(+(await WeatherSnapshot.findOne({ queryKey: product.key })).validTo, validUntil);
  await refreshProduct(product, { previous: row, fetchImpl: async () => new Response('blank page') });
  assert.equal((await bulletinList())[0].documentUrl, null);
  assert.equal((await WeatherSnapshot.findOne({ queryKey: product.key })).data.documentFound, false);
});

dbTest('redirects cannot leave BMD hosts, and bulletin refreshes are cached for thirty minutes', async () => {
  const calls = [];
  await refreshProduct(product, { fetchImpl: async (url) => { calls.push(url); return new Response(null, { status: 302, headers: { location: 'https://example.org/private' } }); } });
  assert.equal(calls.length, 1);
  assert.equal((await WeatherSnapshot.findOne({ queryKey: product.key })).status, 'UNAVAILABLE');
  const now = Date.now();
  let checks = 0;
  const fetchImpl = async () => { checks += 1; return new Response('No current PDF'); };
  await runBulletins({ nowMs: now, fetchImpl });
  assert.equal(checks, PRODUCTS.length);
  assert.equal(await runBulletins({ nowMs: now + 60_000, fetchImpl }), null);
  assert.equal(checks, PRODUCTS.length);
  const stats = newStats(now);
  await officialStage({ nowMs: now, settings: { hazardEnabled: { OFFICIAL_NOTICE: false } }, stats });
  assert.equal(stats.eventsCreated, 0);
});
