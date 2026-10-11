import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Delivery } from '../src/models/Delivery.js';
import { JobState } from '../src/models/JobState.js';
import { MorningDigest } from '../src/models/MorningDigest.js';
import { Subscriber } from '../src/models/Subscriber.js';
import { lintText } from '../src/services/alerts/messages.js';
import { createSubscriber } from '../src/services/alerts/subscribers.js';
import { loadForecast, forecastFor, dayParts, todayIdx } from '../src/services/delivery/botReports/readings.js';
import { placeById } from '../src/services/delivery/botReports/places.js';
import { renderMorning, toPlain } from '../src/services/delivery/botReports/text.js';
import { ChannelError } from '../src/services/delivery/errors.js';
import { digestWindow, runMorningDigest } from '../src/services/delivery/morningDigest.js';
import { startMorningDigestJob } from '../src/jobs/morningDigestJob.js';
import { dhakaParts, dhakaWallTime } from '../src/services/time.js';
import {
  AMTALI, BADDA, SAVAR, forecastInputs,
} from './support/botFixtures.js';

const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);
const MINUTE = 60_000;
const HOUR = 3_600_000;

// 2026-10-11 is a Sunday. 06:00 in Bangladesh is step 2 of the fixture forecast (steps start at 00:00 local time, every 3 hours).
const MORNING = Date.parse('2026-10-11T00:00:00Z');
const DAY = '2026-10-11';

// ---------- the text ----------
function morningFor(placeId, { options = {}, lang = 'en', nowMs = MORNING, lightning, alertCount = null } = {}) {
  const forecast = forecastFor(placeById(placeId), loadForecast({ ...forecastInputs(options), now: nowMs }));
  return renderMorning(forecast, {
    lang, nowMs, lightning, alertCount,
  });
}
const plain = (html) => toPlain(html);

const HOT = { all: { hi: { 3: 36.4, 4: 40.2, 5: 43.1 }, wg: { 5: 44, 6: 52 } } };
const STORMY = { all: { rf: { 4: 2.4, 5: 9.8, 6: 25.5 }, ts: { 5: 1, 6: 2, 7: 3 }, wmo: { 6: 95, 7: 96 }, pop: { 5: 60, 6: 85, 7: 70 } } };

test('the morning message gives the date, the day at a glance and every weather block', () => {
  const text = plain(morningFor(BADDA, { options: { bmdOverrides: HOT, meteoOverrides: STORMY } }));

  assert.match(text, /^🌅 Good morning · Today’s weather\nSunday, 11 Oct\nBadda · /);
  assert.match(text, /°C/);
  assert.match(text, /Heat\nPeak heat index 43 °C · Danger · 15:00–18:00/);
  assert.match(text, /Rain\nToday 37\.7 mm · chance up to 85%\nWettest 3 h 25\.5 mm · 18:00–21:00 \(heavy rain\)/);
  assert.match(text, /Wind\nPeak gust 52 km\/h · 18:00–21:00 · strong gusts\nSecure loose objects/);
  assert.match(text, /Thunderstorm\nPeak potential: High · 21:00–00:00\nThunderstorm forecast with hail\./);
  assert.match(text, /Through the day\n/);
  assert.match(text, /Morning · .*Afternoon · .*Evening · /s);
  assert.match(text, /Tomorrow · /);
  assert.match(text, /Model forecast, not a station reading/);
});

test('it carries the lightning check and the alert count only when they are known', () => {
  const without = plain(morningFor(BADDA));
  assert.doesNotMatch(without, /lightning check|⚡|🔔/i);

  const lightning = { pick: { kind: 'none', sampledMs: MORNING - 20 * MINUTE, radiusKm: 100 }, error: false };
  const quiet = plain(morningFor(BADDA, { lightning, alertCount: 0 }));
  assert.match(quiet, /⚡ Last lightning check: .* none recorded/);
  assert.match(quiet, /🔔 No active AkashSathi alert\./);

  assert.match(plain(morningFor(BADDA, { alertCount: 2 })), /🔔 2 active alerts · send \/alerts/);
  assert.match(plain(morningFor(BADDA, { lightning: { pick: null, error: true } })), /Lightning data could not be read right now\./);
});

test('a missing figure says so and is never shown as zero or as calm weather', () => {
  const text = plain(morningFor(BADDA, {
    options: { bmdOverrides: { all: { rf: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i, null])) } }, openMeteo: null, meteoStatus: 'unavailable' },
  }));
  assert.match(text, /Rain\nThe rain forecast is not available\./);
  assert.match(text, /Thunderstorm\nThe thunderstorm outlook is not available\./);
  assert.doesNotMatch(text, /Almost no rain/);
  assert.match(text, /Rain unit unverified/);
});

test('a quiet day says so plainly and does not use the words the alert rules forbid', () => {
  const text = plain(morningFor(BADDA));
  assert.match(text, /Almost no rain in the forecast\./);
  for (const lang of ['en', 'bn']) {
    for (const sample of [morningFor(BADDA, { lang, alertCount: 0 }), morningFor(BADDA, { lang, options: { bmdOverrides: HOT, meteoOverrides: STORMY } })]) {
      assert.deepEqual(lintText(plain(sample)), []);
      assert.ok(sample.length < 3800, 'fits one Telegram message');
    }
  }
});

test('the Bangla message is Bangla all through: words, digits, date and day parts', () => {
  const text = plain(morningFor(BADDA, { lang: 'bn', options: { bmdOverrides: HOT, meteoOverrides: STORMY }, alertCount: 1 }));
  assert.match(text, /^🌅 শুভ সকাল · আজকের আবহাওয়া\nরবিবার, ১১ অক্টোবর\n/);
  assert.match(text, /সকাল ·/);
  assert.match(text, /আগামীকাল/);
  assert.match(text, /১টি সক্রিয় সতর্কবার্তা/);
  assert.doesNotMatch(text, /[0-9]/, 'every digit is a Bangla digit');
});

test('only the rest of today is reported: a part of the day that has gone by is left out', () => {
  const at = (hh) => dhakaWallTime(DAY, `${hh}:00`).getTime();
  const forecast = (nowMs) => forecastFor(placeById(BADDA), loadForecast({ ...forecastInputs(), now: nowMs }));

  assert.deepEqual(dayParts(forecast(at('06'))).map((part) => part.key), ['morning', 'afternoon', 'evening']);
  assert.deepEqual(dayParts(forecast(at('13'))).map((part) => part.key), ['afternoon', 'evening']);
  assert.equal(todayIdx(forecast(at('06'))).length, 6, 'the 06:00 step onwards');
  assert.equal(todayIdx(forecast(at('06')), { whole: true }).length, 8, 'the whole day, for its own lowest and highest temperature');

  const late = plain(morningFor(BADDA, { nowMs: at('13') }));
  assert.doesNotMatch(late, /Morning ·/);
  assert.match(late, /Afternoon ·/);
});

test('a place the forecast does not cover gets the plain "not available" text, never an empty message', () => {
  const text = plain(morningFor('302604', { options: { pcodes: [SAVAR] } }));
  assert.match(text, /not available for this place right now/);
});

// ---------- the send window ----------
test('the window opens at the set time, stays open for the grace period and never runs past midnight', () => {
  const at = (hhmm) => dhakaWallTime(DAY, hhmm).getTime();
  const window = (hhmm, options) => digestWindow(at(hhmm), options);
  const base = { time: '06:00', graceHours: 4 };

  assert.equal(window('05:59', base).open, false);
  assert.equal(window('06:00', base).open, true);
  assert.equal(window('09:59', base).open, true);
  assert.equal(window('10:00', base).open, false);
  assert.equal(window('06:00', base).date, DAY);

  assert.equal(window('06:09', { time: '06:00', graceHours: 0 }).open, true, 'a zero grace still leaves ten minutes');
  assert.equal(window('06:10', { time: '06:00', graceHours: 0 }).open, false);

  const late = digestWindow(at('22:00'), { time: '22:00', graceHours: 12 });
  assert.equal(late.closesAt, dhakaWallTime('2026-10-12', '00:00').getTime());
});

test('the job does not start when the morning message is off or Telegram is not set up', () => {
  const original = env.channels.morningDigest.enabled;
  const silent = { log() {}, error() {} };
  try {
    env.channels.morningDigest.enabled = true;
    assert.equal(startMorningDigestJob({ channels: { telegram: { available: false } }, log: silent }), null);
    env.channels.morningDigest.enabled = false;
    assert.equal(startMorningDigestJob({ channels: { telegram: { available: true } }, log: silent }), null);
  } finally {
    env.channels.morningDigest.enabled = original;
  }
});

// ---------- sending (needs a database) ----------
const MODELS = [Subscriber, MorningDigest, Delivery, JobState];
const original = {};

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await Promise.all(MODELS.map((model) => model.init()));
  Object.assign(original, structuredClone(env.channels.morningDigest), { maxAttempts: env.channels.maxAttempts });
});

beforeEach(async () => {
  if (!testUri) return;
  await Promise.all(MODELS.map((model) => model.deleteMany({})));
  Object.assign(env.channels.morningDigest, { enabled: true, time: '06:00', graceHours: 4 });
  env.channels.maxAttempts = original.maxAttempts;
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

const silent = { log() {}, error() {} };
const FARMER = { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' };

function fakeTelegram(behaviour = async () => ({ providerMessageId: '1' })) {
  const sent = [];
  return {
    name: 'telegram',
    available: true,
    sent,
    async send(args) {
      sent.push(args);
      return behaviour(args, sent.length);
    },
  };
}

function depsFor(options = {}, extra = {}) {
  const inputs = forecastInputs(options);
  return {
    loadForecast: ({ now }) => loadForecast({ ...inputs, now }),
    lightningFor: async () => ({ pick: null, error: false }),
    alertsFor: async () => ({ items: [] }),
    ...extra,
  };
}

async function person({
  telegram = true, language = 'en', status = 'active', isDemo = false, quiet = null, areas = undefined,
} = {}) {
  const { subscriber } = await createSubscriber({
    occupation: 'farmer', language, homeAreaPcode: BADDA, consent: true, occupationData: FARMER,
  }, { now: new Date(MORNING), isDemo });
  const set = { status };
  if (telegram) set['channels.telegram'] = { chatId: String(555000 + Math.floor(Math.random() * 99999)), linkedAt: new Date(MORNING) };
  if (quiet) set['preferences.quietHours'] = quiet;
  if (areas) set.areas = areas;
  await Subscriber.updateOne({ _id: subscriber._id }, { $set: set });
  return subscriber._id;
}

const run = (channel, nowMs = MORNING, extra = {}) => runMorningDigest({
  channels: { telegram: channel }, nowMs, deps: depsFor(), log: silent, ...extra,
});
const rowsOf = (filter = {}) => MorningDigest.find(filter).lean();

dbTest('the job waits when no forecast is stored, says so once, and always gives its lease back', async () => {
  // Whatever the real time is, one of [00:00, 12:00) and [12:00, 24:00) contains it, so the window is open now.
  Object.assign(env.channels.morningDigest, { time: dhakaParts(new Date()).hh < 12 ? '00:00' : '12:00', graceHours: 12 });
  await person();
  const telegram = fakeTelegram();
  const lines = [];
  const job = startMorningDigestJob({ channels: { telegram }, log: { log: (line) => lines.push(line), error: (line) => lines.push(line) } });
  try {
    await new Promise((resolve) => { setTimeout(resolve, 600); });
  } finally {
    job.stop();
  }

  assert.match(lines[0], /^\[morning-digest\] weather message to connected Telegram chats at \d\d:\d\d \(Asia\/Dhaka\)$/);
  assert.deepEqual(lines.slice(1), ['[morning-digest] waiting: no forecast is stored yet']);
  assert.equal(telegram.sent.length, 0);
  const lease = await JobState.findOne({ key: 'morning-digest' }).lean();
  assert.equal(lease.leaseUntil, null, 'the lease is released, so the next tick (or another server) can work');
});

dbTest('a connected chat gets the morning message once; later ticks and a second server add nothing', async () => {
  const id = await person();
  const telegram = fakeTelegram();

  const first = await run(telegram);
  assert.deepEqual([first.status, first.sent, first.failed, first.skipped], ['ok', 1, 0, 0]);
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0].content.text, /^<b>🌅 Good morning|^🌅 <b>Good morning/);
  assert.equal(telegram.sent[0].content.parseMode, 'HTML');
  assert.match(telegram.sent[0].content.buttons[0][0].data, /^r:heat:302604:en$/, 'the same buttons as /update');

  const again = await run(telegram, MORNING + MINUTE);
  assert.equal(again.sent, 0);
  // Two servers sharing the database, both ticking at the same moment.
  const second = fakeTelegram();
  const [a, b] = await Promise.all([run(second, MORNING + 2 * MINUTE), run(second, MORNING + 2 * MINUTE)]);
  assert.equal(a.sent + b.sent, 0);
  assert.equal(telegram.sent.length + second.sent.length, 1, 'exactly one message in all');

  const [row] = await rowsOf();
  assert.equal(String(row.subscriberId), String(id));
  assert.equal(row.date, DAY);
  assert.equal(row.status, 'sent');
  assert.equal(row.sentParts, 1);
  assert.ok(row.sentAt);
  // Only references and outcomes are stored: no text, no chat id.
  assert.equal(JSON.stringify(row).includes('Good morning'), false);
  assert.equal(JSON.stringify(row).includes('555'), false);
});

dbTest('two servers claiming the same person at the same moment send one message', async () => {
  await person();
  const a = fakeTelegram();
  const b = fakeTelegram();
  await Promise.all([run(a), run(b)]);
  assert.equal(a.sent.length + b.sent.length, 1);
  assert.equal((await rowsOf()).length, 1);
});

dbTest('it is sent the next day again, and a different day gets its own row', async () => {
  await person();
  const telegram = fakeTelegram();
  await run(telegram);
  await run(telegram, MORNING + 24 * HOUR);
  assert.equal(telegram.sent.length, 2);
  assert.deepEqual((await rowsOf()).map((row) => row.date).sort(), ['2026-10-11', '2026-10-12']);
});

dbTest('nothing goes out before the set time or after the window closes', async () => {
  await person();
  const telegram = fakeTelegram();
  assert.equal((await run(telegram, MORNING - MINUTE)).status, 'idle');
  assert.equal((await run(telegram, MORNING + 4 * HOUR)).status, 'idle');
  assert.equal(telegram.sent.length, 0);
  assert.equal((await rowsOf()).length, 0);

  // A server that was down at 06:00 and came back at 08:30 still sends it.
  assert.equal((await run(telegram, MORNING + 150 * MINUTE)).sent, 1);
});

dbTest('the set time is configurable', async () => {
  await person();
  env.channels.morningDigest.time = '07:30';
  const telegram = fakeTelegram();
  assert.equal((await run(telegram, MORNING + 89 * MINUTE)).status, 'idle');
  assert.equal((await run(telegram, MORNING + 90 * MINUTE)).sent, 1);
});

dbTest('only people who are connected, active and real are sent anything', async () => {
  await person({ telegram: false });
  await person({ status: 'paused' });
  await person({ isDemo: true });
  const expired = await person();
  await Subscriber.updateOne({ _id: expired }, { $set: { expiresAt: new Date(MORNING - HOUR) } });
  const telegram = fakeTelegram();

  const result = await run(telegram);
  assert.equal(result.recipients, 0);
  assert.equal(telegram.sent.length, 0);
});

dbTest('a profile without a saved area is skipped for the day, once', async () => {
  await person({ areas: [] });
  const telegram = fakeTelegram();
  assert.equal((await run(telegram)).skipped, 1);
  assert.equal((await run(telegram, MORNING + MINUTE)).skipped, 0);
  assert.equal(telegram.sent.length, 0);
  const [row] = await rowsOf();
  assert.deepEqual([row.status, row.skippedReason], ['skipped', 'no_area']);
});

dbTest('quiet hours are respected: the message waits for them to end, inside the window', async () => {
  await person({ quiet: { enabled: true, start: '22:00', end: '07:00' } });
  const telegram = fakeTelegram();

  const early = await run(telegram, MORNING);
  assert.equal(early.deferred, 1);
  assert.equal(telegram.sent.length, 0);
  assert.equal((await rowsOf()).length, 0, 'nothing is claimed while the person is resting');

  assert.equal((await run(telegram, MORNING + HOUR)).sent, 1);

  // Quiet hours that end after the window closes: no message that day.
  const other = fakeTelegram();
  await MorningDigest.deleteMany({});
  await Subscriber.updateMany({}, { $set: { 'preferences.quietHours': { enabled: true, start: '22:00', end: '11:00' } } });
  assert.equal((await run(other, MORNING + 3 * HOUR)).deferred, 1);
  assert.equal((await run(other, MORNING + 5 * HOUR)).status, 'idle');
  assert.equal(other.sent.length, 0);
});

dbTest('a forecast that is not current is never sent as today’s weather', async () => {
  await person();
  const telegram = fakeTelegram();
  const stale = await run(telegram, MORNING, { deps: depsFor({ bmdStatus: 'stale', meteoStatus: 'stale' }) });
  assert.equal(stale.status, 'stale-forecast');

  const none = await run(telegram, MORNING, { deps: depsFor({ bmd: null, openMeteo: null }) });
  assert.equal(none.status, 'no-forecast');
  assert.equal(telegram.sent.length, 0);
  assert.equal((await rowsOf()).length, 0, 'it keeps waiting; nothing is marked done');

  // The forecast catches up later in the window.
  assert.equal((await run(telegram, MORNING + 30 * MINUTE)).sent, 1);
});

dbTest('a place the stored forecast does not cover is skipped, not answered with "unavailable"', async () => {
  await person();
  const telegram = fakeTelegram();
  const result = await run(telegram, MORNING, { deps: depsFor({ pcodes: [AMTALI] }) });
  assert.equal(result.skipped, 1);
  assert.equal(telegram.sent.length, 0);
  assert.equal((await rowsOf())[0].skippedReason, 'no_forecast');
});

dbTest('the language follows the profile', async () => {
  await person({ language: 'bn' });
  const telegram = fakeTelegram();
  await run(telegram);
  assert.match(telegram.sent[0].content.text, /শুভ সকাল/);
});

dbTest('a person with two saved areas gets one message each; a retry does not repeat the first', async () => {
  await person({
    areas: [
      { role: 'home', upazilaPcode: BADDA, districtPcode: '3026', matchMethod: 'manual' },
      { role: 'work', upazilaPcode: SAVAR, districtPcode: '3026', matchMethod: 'manual' },
    ],
  });
  const telegram = fakeTelegram(async (args, n) => {
    if (n === 2) throw new ChannelError('retry', 'Telegram is unavailable (HTTP 502).');
    return { providerMessageId: String(n) };
  });

  const first = await run(telegram);
  assert.equal(first.retried, 1);
  assert.equal(telegram.sent.length, 2, 'the first area went out, the second failed');
  let [row] = await rowsOf();
  assert.deepEqual([row.status, row.sentParts, row.attempts], ['retry', 1, 1]);

  const second = await run(telegram, MORNING + MINUTE);
  assert.equal(second.sent, 1);
  assert.equal(telegram.sent.length, 3, 'only the second area was sent again');
  assert.match(telegram.sent[1].content.text, /Savar/);
  assert.match(telegram.sent[2].content.text, /Savar/);
  [row] = await rowsOf();
  assert.deepEqual([row.status, row.sentParts, row.attempts], ['sent', 2, 2]);
});

dbTest('a Telegram outage is retried with back-off until the window closes, then given up', async () => {
  await person();
  env.channels.maxAttempts = 10;
  const telegram = fakeTelegram(async () => { throw new ChannelError('retry', 'Telegram could not be reached.'); });

  assert.equal((await run(telegram, MORNING)).retried, 1);
  assert.equal((await run(telegram, MORNING + 30_000)).retried, 0, 'not due yet');
  assert.equal(telegram.sent.length, 1);
  assert.equal((await run(telegram, MORNING + MINUTE)).retried, 1);
  assert.equal(telegram.sent.length, 2);

  // Close to the end of the window there is no time left to wait: it fails instead of retrying past the window.
  const late = MORNING + 4 * HOUR - 30_000;
  await MorningDigest.updateMany({}, { $set: { nextAttemptAt: new Date(late - MINUTE) } });
  const result = await run(telegram, late);
  assert.equal(result.failed, 1);
  assert.equal((await rowsOf())[0].status, 'failed');
});

dbTest('a chat that blocked the bot is failed once and unlinked, like an alert would be', async () => {
  const id = await person();
  const telegram = fakeTelegram(async () => { throw new ChannelError('blocked', 'This chat cannot receive messages from the bot.'); });

  const result = await run(telegram);
  assert.equal(result.failed, 1);
  assert.equal((await rowsOf())[0].status, 'failed');
  const profile = await Subscriber.findById(id).lean();
  assert.equal(profile.channels?.telegram?.chatId, undefined);
  assert.equal((await run(telegram, MORNING + MINUTE)).recipients, 0);
});

dbTest('a rejected bot token stops the whole run and tries again later', async () => {
  await person();
  await person();
  const telegram = fakeTelegram(async () => { throw new ChannelError('auth', 'Telegram rejected the bot token.'); });
  const result = await run(telegram, MORNING, { concurrency: 1 });
  assert.equal(result.retried, 1);
  assert.equal(telegram.sent.length, 1, 'the second person was not even tried');
  const retrying = await rowsOf({ status: 'retry' });
  assert.equal(retrying.length, 1);
  assert.ok(+retrying[0].nextAttemptAt >= MORNING + 10 * MINUTE);
});

dbTest('if Telegram refuses the formatting, the same words are sent as plain text', async () => {
  await person();
  const telegram = fakeTelegram(async (args) => {
    if (args.content.parseMode) throw new ChannelError('permanent', 'cannot parse');
    return { providerMessageId: 'plain' };
  });
  const result = await run(telegram);
  assert.equal(result.sent, 1);
  assert.equal(telegram.sent.length, 2);
  assert.equal(telegram.sent[1].content.parseMode, undefined);
  assert.doesNotMatch(telegram.sent[1].content.text, /<b>/);
  assert.match(telegram.sent[1].content.text, /Good morning/);
});

dbTest('the message adds nothing to the alert queue and does not use up the daily alert cap', async () => {
  await person();
  await run(fakeTelegram());
  assert.equal(await Delivery.countDocuments(), 0);
});

dbTest('the message carries no profile answers: no occupation, crop or shift', async () => {
  await person();
  const telegram = fakeTelegram();
  await run(telegram);
  const text = plain(telegram.sent[0].content.text);
  for (const word of ['farmer', 'rice', 'aman', 'harvest', 'pump', 'irrigation']) assert.doesNotMatch(text, new RegExp(word, 'i'));
});

dbTest('the number of active alerts is the only thing taken from the alert inbox', async () => {
  await person();
  const telegram = fakeTelegram();
  await run(telegram, MORNING, { deps: depsFor({}, { alertsFor: async () => ({ items: [{ title: 'Heavy rain expected near Badda' }, { title: 'x' }] }) }) });
  const text = plain(telegram.sent[0].content.text);
  assert.match(text, /2 active alerts/);
  assert.doesNotMatch(text, /Heavy rain expected near Badda/);
});

dbTest('a failure while reading the inbox or the lightning check does not stop the message', async () => {
  await person();
  const telegram = fakeTelegram();
  const result = await run(telegram, MORNING, {
    deps: depsFor({}, { alertsFor: async () => { throw new Error('db'); }, lightningFor: async () => { throw new Error('xweather'); } }),
  });
  assert.equal(result.sent, 1);
  const text = plain(telegram.sent[0].content.text);
  assert.match(text, /Lightning data could not be read right now\./);
  assert.doesNotMatch(text, /🔔/, 'an unknown alert count is left out, never shown as none');
});
