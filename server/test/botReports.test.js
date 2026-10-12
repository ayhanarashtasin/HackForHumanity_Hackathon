import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { env } from '../src/config/env.js';
import { lintText } from '../src/services/alerts/messages.js';
import { createTelegramChannel } from '../src/services/delivery/channels/telegram.js';
import {
  ALL_COMMANDS, answerCommand, canonicalCommand, createRateLimiter, parseArgs, resolveLanguage,
} from '../src/services/delivery/botReports/commands.js';
import {
  findPlaces, placeById, placesForAreas, representativePcode,
} from '../src/services/delivery/botReports/places.js';
import {
  chooseLightning, dailySummaries, forecastFor, gustClass, heatCategory, loadForecast, peakOf, rainClass, sumOf,
} from '../src/services/delivery/botReports/readings.js';
import { COMMAND_NAMES, buttonsFor, commandMenu, renderAlerts, renderHelp, toPlain } from '../src/services/delivery/botReports/text.js';
import { ChannelError } from '../src/services/delivery/errors.js';
import { handleTelegramUpdate, resetBotForTests } from '../src/services/delivery/telegramBot.js';
import {
  AMTALI, BADDA, DHAKA, NOW, SAVAR, forecastInputs, sourceData,
} from './support/botFixtures.js';

// ---------- helpers ----------
const HOT = { all: { hi: { 3: 36.4, 4: 40.2, 5: 43.1 }, wg: { 5: 44, 6: 52 } } };
const STORMY = { all: { rf: { 4: 2.4, 5: 9.8, 6: 25.5 }, ts: { 5: 1, 6: 2, 7: 3 }, wmo: { 6: 95, 7: 96 }, pop: { 5: 60, 6: 85, 7: 70 } } };

function depsFor(options = {}, extra = {}) {
  const inputs = forecastInputs(options);
  return {
    loadForecast: ({ now }) => loadForecast({ ...inputs, now }),
    subscriberForChat: async () => null,
    lightningFor: async () => ({ pick: null, error: false }),
    alertsFor: async () => ({ items: [] }),
    engineStatus: async () => ({ enabled: true, lastCompletedMs: NOW - 60_000, lastStatus: 'ok' }),
    statuses: () => inputs.statuses,
    ...extra,
  };
}

const ask = (command, rest = [], options = {}, extra = {}) => answerCommand({
  command, rest, chatId: '1', nowMs: NOW, deps: depsFor(options, extra),
});
const textOf = (result) => result.messages.map((message) => message.text).join('\n');
const plain = (result) => toPlain(textOf(result));

function fakeChannels({ failHtml = false } = {}) {
  const sent = [];
  const answered = [];
  return {
    telegram: {
      name: 'telegram',
      available: true,
      sent,
      answered,
      async send(args) {
        sent.push(args);
        if (failHtml && args.content.parseMode) throw new ChannelError('permanent', 'cannot parse');
        return { providerMessageId: String(sent.length) };
      },
      async answerCallbackQuery(id) {
        answered.push(id);
      },
    },
  };
}

const message = (text, { chatId = 4242, updateId, language = undefined, type = 'private' } = {}) => ({
  update_id: updateId, message: { chat: { id: chatId, type }, text, from: { language_code: language } },
});
const press = (data, { chatId = 4242, updateId, type = 'private' } = {}) => ({
  update_id: updateId, callback_query: { id: `cb-${updateId}`, data, message: { chat: { id: chatId, type } }, from: {} },
});

let originalLimit;
let originalVerified;
beforeEach(() => {
  originalLimit = env.channels.telegram.commandLimit;
  originalVerified = env.alerts.bmdRainVerified;
  env.alerts.bmdRainVerified = false;
  resetBotForTests();
});
afterEach(() => {
  env.channels.telegram.commandLimit = originalLimit;
  env.alerts.bmdRainVerified = originalVerified;
});

// ---------- places ----------

test('places: a name is found in English and Bangla, with or without its kind word', () => {
  for (const query of ['Badda', 'badda', 'BADDA', 'Badda thana', 'বাড্ডা', 'Badda, Dhaka', 'badda,dhaka']) {
    const { matches } = findPlaces(query);
    assert.equal(matches.length, 1, query);
    assert.equal(matches[0].id, BADDA, query);
  }
  assert.equal(findPlaces('Dhaka').matches[0].id, DHAKA, 'a district');
  assert.equal(findPlaces('Dhaka district').matches[0].id, DHAKA);
  assert.equal(findPlaces('ঢাকা জেলা').matches[0].id, DHAKA);
  assert.equal(findPlaces('Savar, Dhaka').matches[0].id, SAVAR);
});

test('places: an ambiguous name lists its candidates (at most five) and a district narrows it', () => {
  const { matches, total } = findPlaces('Kotwali');
  assert.ok(total >= 3 && matches.length <= 5);
  assert.ok(matches.every((place) => place.name === 'Kotwali'));
  const narrowed = findPlaces('Kotwali, Dhaka');
  assert.equal(narrowed.matches.length, 1);
  assert.equal(narrowed.matches[0].districtCode, DHAKA);
  assert.ok(findPlaces('sadar').matches.length <= 5, 'a broad word never floods the reply');
});

test('places: nothing is made up for a name that does not exist or is too short', () => {
  for (const query of ['', ' ', 'a', 'zzzzzzzz', '???', 'Atlantis']) assert.deepEqual(findPlaces(query), { matches: [], total: 0 }, JSON.stringify(query));
});

test('places: city corporations and boundary areas without a BMD code are places too', () => {
  const north = findPlaces('Dhaka North City Corporation').matches[0];
  assert.equal(north.level, 'polygon');
  assert.equal(north.kind, 'city-corporation');
  assert.ok(north.members.includes(BADDA));
  assert.equal(findPlaces('Cumilla City Corporation').matches[0].approx, true);
  assert.equal(placeById(north.id), north);
  assert.equal(placeById('nope'), null);
  assert.equal(placeById(''), null);
});

test('places: a saved profile gives its areas once each, in order, at most two', () => {
  const areas = [
    { role: 'home', upazilaPcode: BADDA }, { role: 'work', upazilaPcode: BADDA }, { role: 'field', upazilaPcode: SAVAR }, { role: 'site', upazilaPcode: AMTALI },
  ];
  assert.deepEqual(placesForAreas(areas).map((place) => place.id), [BADDA, SAVAR]);
  assert.deepEqual(placesForAreas([{ upazilaPcode: '000000' }, { upazilaPcode: BADDA }]).map((place) => place.id), [BADDA]);
  assert.deepEqual(placesForAreas([]), []);
  assert.equal(representativePcode(placeById(BADDA)), BADDA);
  assert.equal(representativePcode(placeById(DHAKA)), null, 'a district has no single location');
});

// ---------- readings ----------

test('readings: the base source is BMD while it is current, then Open-Meteo, then whatever exists', () => {
  assert.equal(loadForecast(forecastInputs()).base, 'bmd');
  assert.equal(loadForecast(forecastInputs({ bmdStatus: 'stale' })).base, 'openMeteo');
  assert.equal(loadForecast(forecastInputs({ bmdStatus: 'stale', meteoStatus: 'stale' })).base, 'bmd');
  assert.equal(loadForecast(forecastInputs({ bmd: null })).base, 'openMeteo');
  assert.equal(loadForecast(forecastInputs({ bmd: null, openMeteo: null })).base, null);
});

test('readings: the current step is found, and a forecast that does not cover now says so', () => {
  const forecast = forecastFor(placeById(BADDA), loadForecast(forecastInputs()));
  assert.equal(forecast.available, true);
  assert.equal(forecast.nowIdx, 3, '10:00 is in the 09:00-12:00 step');
  const late = forecastFor(placeById(BADDA), loadForecast({ ...forecastInputs(), now: NOW + 10 * 24 * 3_600_000 }));
  assert.equal(late.nowIdx, -1);
  assert.equal(forecastFor(placeById(BADDA), loadForecast(forecastInputs({ bmd: null, openMeteo: null }))).available, false);
  assert.equal(forecastFor(placeById('100419'), loadForecast(forecastInputs())).available, false, 'a place with no stored series is unavailable, not zero');
});

test('readings: rain amounts come from Open-Meteo while it is current, from BMD (with a caveat) when it is not', () => {
  const overrides = { bmdOverrides: { all: { rf: { 4: 5 } } }, meteoOverrides: { all: { rf: { 4: 9 } } } };
  const fresh = forecastFor(placeById(BADDA), loadForecast(forecastInputs(overrides)));
  assert.equal(fresh.rain.source, 'open-meteo');
  assert.equal(fresh.rain.values[4], 9);
  assert.equal(fresh.rain.unverified, false);

  const stale = forecastFor(placeById(BADDA), loadForecast(forecastInputs({ ...overrides, meteoStatus: 'stale' })));
  assert.equal(stale.rain.source, 'bmd');
  assert.equal(stale.rain.values[4], 5);
  assert.equal(stale.rain.unverified, true);

  env.alerts.bmdRainVerified = true;
  assert.equal(forecastFor(placeById(BADDA), loadForecast(forecastInputs({ ...overrides, meteoStatus: 'stale' }))).rain.unverified, false);
});

test('readings: a gust is never shown lighter than the mean wind, and a missing gust stays missing', () => {
  const overrides = { all: { ws: { 3: 18, 4: 30, 5: 9 }, wg: { 3: 12, 4: 41, 5: null } } };
  const forecast = forecastFor(placeById(BADDA), loadForecast(forecastInputs({ bmdOverrides: overrides })));
  assert.equal(forecast.cols.wg[3], 18, 'BMD gust 12 below its own mean wind 18');
  assert.equal(forecast.cols.wg[4], 41, 'a gust above the mean is kept as published');
  assert.equal(forecast.cols.wg[5], null, 'no gust published, none shown');
  assert.equal(forecast.cols.ws[3], 18, 'the mean wind itself is untouched');
});

test('readings: a district shows the highest upazila for heat, rain and gusts and the average for temperature', () => {
  const forecast = forecastFor(
    placeById(DHAKA),
    loadForecast(forecastInputs({ bmdOverrides: { [BADDA]: { hi: { 4: 40 } }, [SAVAR]: { hi: { 4: 45 }, temp: { 4: 36 } } }, pcodes: [BADDA, SAVAR] })),
  );
  assert.equal(forecast.cols.hi[4], 45);
  const base = forecastFor(placeById(BADDA), loadForecast(forecastInputs({ pcodes: [BADDA, SAVAR] })));
  assert.equal(forecast.cols.temp[4], Math.round(((base.cols.temp[4] + 36) / 2) * 10) / 10);
});

test('readings: a city corporation without its own forecast is built from the members that have one', () => {
  const north = findPlaces('Dhaka North City Corporation').matches[0];
  const forecast = forecastFor(north, loadForecast(forecastInputs()));
  assert.equal(forecast.available, true);
  assert.deepEqual(forecast.cols.temp, forecastFor(placeById(BADDA), loadForecast(forecastInputs())).cols.temp);
});

test('readings: classes sit on the same lines as the map legend and the alert rules', () => {
  assert.deepEqual([26.9, 27, 31.9, 32, 38.9, 39, 50.9, 51].map(heatCategory), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.equal(heatCategory(null), null);
  assert.deepEqual([0, 0.05, 0.1, 7.4, 7.5, 22.9, 23, 49.9, 50].map(rainClass), ['none', 'none', 'light', 'light', 'moderate', 'moderate', 'heavy', 'heavy', 'very_heavy']);
  assert.equal(rainClass(undefined), null);
  assert.deepEqual([10, 29.9, 30, 39.9, 40, 59.9, 60, 79.9, 80].map(gustClass), ['light', 'light', 'brisk', 'brisk', 'strong', 'strong', 'very_strong', 'very_strong', 'severe']);
});

test('readings: peaks and totals skip a missing value and never treat it as zero', () => {
  assert.deepEqual(peakOf([1, null, 5, undefined, 3], [0, 1, 2, 3, 4]), { value: 5, index: 2 });
  assert.equal(peakOf([null, null], [0, 1]), null);
  assert.deepEqual(sumOf([1, null, 2], [0, 1, 2]), { total: 3, partial: true });
  assert.deepEqual(sumOf([1, 2], [0, 1]), { total: 3, partial: false });
  assert.deepEqual(sumOf([null, null], [0, 1]), { total: null, partial: true });
});

test('readings: days start today, need half a day of steps, and a gap in the rain data makes the total a lower bound', () => {
  const forecast = forecastFor(placeById(BADDA), loadForecast(forecastInputs({ meteoOverrides: { all: { rf: { 9: null, 10: 4 } } } })));
  const days = dailySummaries(forecast);
  assert.equal(days.length, 4);
  assert.equal(days[0].date, '2026-10-11');
  assert.equal(days[1].rain.partial, true);
  assert.equal(days[1].rain.total, 4);
  assert.equal(days[0].rain.partial, false);
  assert.ok(days[0].low < days[0].high);
});

test('readings: of several lightning checks the most recent is the one shown', () => {
  assert.equal(chooseLightning([]), null);
  assert.equal(chooseLightning([null]), null);
  const older = { kind: 'reported', sampledMs: 100, count: 3 };
  const newer = { kind: 'none', sampledMs: 200, count: 0 };
  assert.equal(chooseLightning([older, newer]), newer);
  assert.equal(chooseLightning([{ kind: 'not-checked', sampledMs: null }, older]), older);
  assert.equal(chooseLightning([{ kind: 'not-checked', sampledMs: null }]).kind, 'not-checked');
});

// ---------- command parsing ----------

test('commands: the word after the slash is folded to one command; anything else is not a weather command', () => {
  assert.equal(canonicalCommand('/heat'), 'heat');
  assert.equal(canonicalCommand('/HEAT@AkshSathiBot'), 'heat');
  assert.equal(canonicalCommand('/thunder'), 'thunderstorm');
  assert.equal(canonicalCommand('/storm'), 'thunderstorm');
  assert.equal(canonicalCommand('/weather'), 'update');
  assert.equal(canonicalCommand('/days'), 'forecast');
  for (const other of ['/start', '/stop', '/help', '/foo', 'update', '', undefined]) assert.equal(canonicalCommand(other) === null || other === 'update', true, String(other));
  assert.deepEqual([...ALL_COMMANDS].sort(), [...COMMAND_NAMES].sort());
});

test('commands: a trailing bn or en picks the language; the rest is the place', () => {
  assert.deepEqual(parseArgs(['Savar,', 'Dhaka', 'bn']), { query: 'Savar, Dhaka', override: 'bn' });
  assert.deepEqual(parseArgs(['BN']), { query: '', override: 'bn' });
  assert.deepEqual(parseArgs([]), { query: '', override: null });
  assert.deepEqual(parseArgs(['Badda']), { query: 'Badda', override: null });
  assert.equal(resolveLanguage({ override: 'en', subscriber: { language: 'bn' }, languageCode: 'bn' }), 'en');
  assert.equal(resolveLanguage({ subscriber: { language: 'bn' }, languageCode: 'en' }), 'bn');
  assert.equal(resolveLanguage({ languageCode: 'bn' }), 'bn');
  assert.equal(resolveLanguage({ languageCode: 'bn-BD' }), 'bn');
  assert.equal(resolveLanguage({ query: 'বাড্ডা' }), 'bn', 'a place typed in Bangla gets a Bangla reply');
  assert.equal(resolveLanguage({ query: 'বাড্ডা', languageCode: 'en' }), 'bn');
  assert.equal(resolveLanguage({ query: 'বাড্ডা', subscriber: { language: 'en' } }), 'en', 'but a saved preference still wins');
  assert.equal(resolveLanguage({ query: 'বাড্ডা', override: 'en' }), 'en');
  assert.equal(resolveLanguage({ query: 'Badda', languageCode: 'en' }), 'en');
  assert.equal(resolveLanguage({ languageCode: 'en-GB' }), 'en');
  assert.equal(resolveLanguage({}), 'en');
});

test('commands: the limiter allows its share, announces the refusal once, and starts over after the window', () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 1000 });
  assert.deepEqual([1, 2, 3].map(() => limiter.hit('a', 0).allowed), [true, true, true]);
  assert.deepEqual(limiter.hit('a', 10), { allowed: false, announce: true });
  assert.deepEqual(limiter.hit('a', 20), { allowed: false, announce: false });
  assert.equal(limiter.hit('b', 20).allowed, true, 'another chat is unaffected');
  assert.equal(limiter.hit('a', 1500).allowed, true, 'a new window');
});

// ---------- answers ----------

test('answers: with no place and no saved profile the bot asks which place', async () => {
  const result = await ask('update');
  assert.equal(result.action, 'ask-place');
  assert.match(textOf(result), /Which place\?/);
  assert.equal((await ask('heat', ['bn'])).messages[0].text.includes('কোন জায়গা'), true);
});

test('answers: a name that matches nothing, or several places, is explained and nothing is guessed', async () => {
  const none = await ask('rain', ['Atlantis']);
  assert.equal(none.action, 'not-found');
  assert.match(textOf(none), /could not find a place called "Atlantis"/);

  const many = await ask('heat', ['Kotwali']);
  assert.equal(many.action, 'ambiguous');
  assert.match(textOf(many), /\/heat Kotwali, \w+/);
  assert.ok(many.messages[0].text.split('\n').filter((line) => line.startsWith('/heat')).length <= 5);

  const odd = await ask('update', ['<b>x</b>&']);
  assert.equal(odd.action, 'not-found');
  assert.ok(!textOf(odd).includes('<b>x</b>'), 'what the person typed is escaped before it is echoed');
});

test('answers: a saved profile gives its area (two at most) and the reply never carries the profile\'s answers', async () => {
  const subscriber = {
    _id: 'sub1', language: 'en', occupation: 'farmer', occupationData: { cropStage: 'harvesting', workload: 'heavy' },
    areas: [{ role: 'field', upazilaPcode: BADDA }, { role: 'home', upazilaPcode: SAVAR }, { role: 'work', upazilaPcode: AMTALI }],
  };
  const result = await ask('update', [], { bmdOverrides: HOT, meteoOverrides: STORMY }, { subscriberForChat: async () => subscriber, alertsFor: async () => ({ items: [] }) });
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].text, /Badda/);
  assert.match(result.messages[1].text, /Savar/);
  assert.ok(!/Amtali/.test(textOf(result)), 'a third area is not shown');
  for (const word of ['farmer', 'harvest', 'crop', 'workload', 'field', 'home', 'shift', 'occupation']) assert.ok(!new RegExp(word, 'i').test(plain(result)), `no "${word}"`);
  assert.ok(result.messages[0].buttons?.length, 'buttons under the first report');
  assert.equal(result.messages[1].buttons, undefined);
  assert.match(textOf(result), /No active AkashSathi alert/);
});

test('answers: the saved profile\'s language wins; a typed bn/en wins over it; Telegram\'s language is the last resort', async () => {
  const subscriber = { _id: 's', language: 'bn', areas: [{ upazilaPcode: BADDA }] };
  const linked = (await ask('heat', [], {}, { subscriberForChat: async () => subscriber })).messages[0].text;
  assert.match(linked, /বাড্ডা/);
  const overridden = (await ask('heat', ['en'], {}, { subscriberForChat: async () => subscriber })).messages[0].text;
  assert.match(overridden, /Badda/);
  const fromTelegram = await answerCommand({ command: 'heat', rest: ['Badda'], chatId: '1', languageCode: 'bn', nowMs: NOW, deps: depsFor() });
  assert.match(fromTelegram.messages[0].text, /বাড্ডা/);
  const typedInBangla = await ask('heat', ['বাড্ডা']);
  assert.match(typedInBangla.messages[0].text, /গরম|হিট ইনডেক্স/);
  assert.equal(typedInBangla.lang, 'bn');
});

test('answers: route gives the automatic route weather summary for both separators and asks for both places', async () => {
  const routeResult = {
    start: { name: 'Savar' }, end: { name: 'Dhaka' }, distanceKm: 31.2, durationMinutes: 60,
    summary: {
      maxHeatIndexC: 36, maxRainMm: 8, maxRainChancePct: 75, maxWindKph: 22, maxThunderPotential: 2,
      coveredCount: 4, sampleCount: 4, forecastStatus: 'ok', rainUnitUnverified: false,
    },
  };
  const routeWeather = async ({ start, end }) => {
    assert.equal(start.name, 'Savar');
    assert.equal(end.name, 'Dhaka');
    return routeResult;
  };
  const english = await ask('route', ['Savar', 'to', 'Dhaka'], {}, { routeWeather });
  assert.equal(english.action, 'route');
  assert.match(plain(english), /Savar → Dhaka/);
  assert.match(plain(english), /Heat index/);

  const bangla = await ask('route', ['Savar', 'থেকে', 'Dhaka', 'bn'], {}, { routeWeather });
  assert.equal(bangla.lang, 'bn');
  assert.match(plain(bangla), /হিট ইনডেক্স/);

  const missing = await ask('route', ['Savar']);
  assert.equal(missing.action, 'ask-route');
  assert.match(plain(missing), /\/route Savar to Chattogram/);
});

test('answers: every weather command works for every kind of place in both languages, with no hole in the text', async () => {
  const places = ['Badda', 'Dhaka', 'Dhaka North City Corporation', 'Savar, Dhaka'];
  for (const command of ['update', 'heat', 'rain', 'wind', 'thunderstorm', 'lightning', 'forecast']) {
    for (const lang of ['en', 'bn']) {
      for (const place of places) {
        const result = await ask(command, [...place.split(' '), lang], { bmdOverrides: HOT, meteoOverrides: STORMY }, {
          lightningFor: async () => ({ pick: { kind: 'reported', sampledMs: NOW - 600_000, count: 4, radiusKm: 100 }, error: false }),
        });
        const text = plain(result);
        const label = `/${command} ${place} ${lang}`;
        assert.ok(result.messages.every((item) => item.text.length <= 1800), `${label}: compact reply`);
        assert.match(result.messages[0].text.split('\n')[0], /<b>.+<\/b>/, `${label}: clear heading`);
        assert.doesNotMatch(text, /NaN|undefined|null|\[object/, label);
        assert.deepEqual(lintText(text), [], `${label}: banned phrasing`);
        if (lang === 'bn') assert.doesNotMatch(text, /[0-9]/, `${label}: Bangla digits`);
        assert.doesNotMatch(text, /Prototype information|not an official warning service|Source:|not a station reading|bmd\.gov\.bd|পরীক্ষামূলক তথ্য|সূত্র:|কোনো কেন্দ্রের পরিমাপ নয়|বজ্রপাত শনাক্তকরণ নয়/, `${label}: no boilerplate footer`);
      }
    }
  }
});

test('answers: forecast headings identify forecasts without repeating explanatory footers', async () => {
  for (const command of ['update', 'heat', 'rain', 'wind', 'thunderstorm', 'forecast']) {
    const text = plain(await ask(command, ['Badda'], { bmdOverrides: HOT, meteoOverrides: STORMY }));
    assert.match(text.split('\n')[0], /forecast|days ahead/i, command);
    assert.doesNotMatch(text, /station reading|lightning detection|measured value|WBGT/i, command);
  }
});

test('answers: stale data is shown with its age and a warning, never as current', async () => {
  // BMD stale while Open-Meteo is current: the reply uses the current source without a stale note.
  const fallback = plain(await ask('update', ['Badda'], { bmdStatus: 'stale' }));
  assert.doesNotMatch(fallback, /Stale data/);

  const bothStale = plain(await ask('update', ['Badda'], { bmdStatus: 'stale', meteoStatus: 'stale' }));
  assert.match(bothStale, /⚠ Stale data · updated today 08:00/);
  const meteoStale = plain(await ask('thunderstorm', ['Badda'], { meteoStatus: 'stale', meteoOverrides: STORMY }));
  assert.match(meteoStale, /Stale data/);
  const rainStale = plain(await ask('rain', ['Badda'], { meteoStatus: 'stale' }));
  assert.match(rainStale, /⚠ Rain unit unverified\./);
  const fine = plain(await ask('update', ['Badda']));
  assert.doesNotMatch(fine, /Stale data/);
});

test('answers: missing data says so, and never reads as calm weather or as zero', async () => {
  const none = await ask('update', ['Badda'], { bmd: null, openMeteo: null });
  assert.match(textOf(none), /is not available for this place right now\./);
  assert.doesNotMatch(textOf(none), /0\.0|°C/);

  const noThunder = plain(await ask('thunderstorm', ['Badda'], { openMeteo: null }));
  assert.match(noThunder, /thunderstorm outlook is not available/i);
  assert.doesNotMatch(noThunder, /no thunderstorm/i);

  const noRain = plain(await ask('rain', ['Badda'], { bmd: sourceData([BADDA]), openMeteo: null, pcodes: [BADDA] }));
  assert.match(noRain, /⚠ Rain unit unverified\./);

  const missingStep = plain(await ask('thunderstorm', ['Badda'], { meteoOverrides: { all: { ts: { 4: null, 5: 2 } } } }));
  assert.match(missingStep, /today 12:00–15:00 · –/);
  assert.doesNotMatch(missingStep, /today 12:00–15:00 · None/);
});

test('answers: heat gives the current index, peak category, time and short advice', async () => {
  const text = plain(await ask('heat', ['Badda'], { bmdOverrides: HOT }));
  assert.match(text, /Peak heat index \(24 h\): 43 °C · Danger/);
  assert.match(text, /Time: today 15:00–18:00/);
  assert.match(text, /Limit outdoor work, drink water often and rest in the shade/);
  assert.match(text, /Now: 28\.0 °C · heat index 36 °C \(Extreme caution\)/);

  const mild = plain(await ask('heat', ['Badda'], { bmdOverrides: { all: { hi: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i, 20])) } } }));
  assert.match(mild, /stays below the caution level \(27 °C\)/);
  assert.doesNotMatch(mild, /safe/i);
});

test('answers: rain lists the steps, the total and the wettest step, and a gap makes the total a lower bound', async () => {
  const text = plain(await ask('rain', ['Badda'], { meteoOverrides: STORMY }));
  assert.match(text, /today 18:00–21:00 · 25\.5 mm \(heavy rain\) · chance 85%/);
  assert.match(text, /Total \(24 h\): 37\.7 mm/);
  assert.match(text, /Wettest 3 h: 25\.5 mm · heavy rain\nTime: today 18:00–21:00/);
  const gap = plain(await ask('rain', ['Badda'], { meteoOverrides: { all: { rf: { 5: null, 6: 3 } } } }));
  assert.match(gap, /Total \(24 h\): at least 3\.0 mm/);
  const dry = plain(await ask('rain', ['Badda']));
  assert.match(dry, /Almost no rain/);
});

test('answers: wind gives the strongest gust of the next day with its class', async () => {
  const text = plain(await ask('wind', ['Badda'], { bmdOverrides: HOT }));
  assert.match(text, /Peak gust \(24 h\): 52 km\/h · strong gusts\nTime: today 18:00–21:00/);
  assert.match(text, /from NW/);
  assert.match(text, /Secure loose objects/);
  assert.doesNotMatch(plain(await ask('wind', ['Badda'])), /Secure loose objects/, 'only when the gust is strong');

  const overnight = plain(await ask('wind', ['Badda'], { bmdOverrides: { all: { wg: { 9: 80 } } } }));
  assert.match(overnight, /Peak gust \(24 h\): 80 km\/h · severe gusts\nTime: tomorrow 03:00–06:00/, 'the short timeline does not hide the overnight peak');
});

test('answers: the thunderstorm outlook gives the peak, flags a modelled thunderstorm and hail, and keeps the advice free of "safe"', async () => {
  const text = plain(await ask('thunderstorm', ['Badda'], { meteoOverrides: STORMY }));
  assert.match(text, /today 15:00–18:00 · Low · rain 60%/);
  assert.match(text, /today 21:00–00:00 · High/);
  assert.match(text, /Peak potential \(24 h\): High\nTime: today 21:00–00:00/);
  assert.match(text, /Thunderstorm forecast with hail\./);
  assert.match(text, /go indoors; avoid isolated trees and open water/);
  assert.doesNotMatch(text, /not a lightning detection|Send \/lightning/);
  assert.deepEqual(lintText(text), []);

  const calm = plain(await ask('thunderstorm', ['Badda']));
  assert.match(calm, /Peak potential \(24 h\): None/);
  assert.doesNotMatch(calm, /Thunderstorm forecast with hail/);

  const bn = plain(await ask('thunderstorm', ['Badda', 'bn'], { meteoOverrides: STORMY }));
  assert.match(bn, /শিলাবৃষ্টিসহ।/, 'a Bangla full stop');
});

test('answers: lightning reports the recorded count, check time and search window', async () => {
  const lightning = (pick, error = false) => ({ lightningFor: async () => ({ pick, error }) });
  const reported = plain(await ask('lightning', ['Badda'], {}, lightning({ kind: 'reported', sampledMs: NOW - 600_000, count: 4, radiusKm: 100 })));
  assert.match(reported, /Lightning was recorded\./);
  assert.match(reported, /Last check: today 09:50\nStrikes \(previous 5 min\): 4\nSearch radius: 100 km/);
  const none = plain(await ask('lightning', ['Badda'], {}, lightning({ kind: 'none', sampledMs: NOW - 3_600_000, count: 0, radiusKm: 100 })));
  assert.match(none, /No lightning was recorded/);
  assert.match(none, /Last check: today 09:00\nWindow: previous 5 min · radius 100 km/);
  assert.match(plain(await ask('lightning', ['Badda'], {}, lightning({ kind: 'stale', sampledMs: NOW - 9e6, radiusKm: 100 }))), /out of date/);
  assert.match(plain(await ask('lightning', ['Badda'], {}, lightning({ kind: 'unavailable', sampledMs: NOW, radiusKm: 100 }))), /not available right now/);
  assert.match(plain(await ask('lightning', ['Badda'], {}, lightning({ kind: 'not-checked', sampledMs: null, radiusKm: 100 }))), /has not been checked yet/);
  assert.match(plain(await ask('lightning', ['Badda'], {}, lightning(null))), /No lightning check for this place yet/);
  assert.match(plain(await ask('lightning', ['Badda'], {}, lightning(null, true))), /could not be read right now/);
  const forecastMissing = await ask('lightning', ['Badda'], { bmd: null, openMeteo: null }, lightning({ kind: 'none', sampledMs: NOW, radiusKm: 100 }));
  assert.match(textOf(forecastMissing), /No lightning was recorded/, 'the lightning answer does not need the forecast');
});

test('answers: the forecast lists the days ahead with rain, gusts and the thunder peak', async () => {
  const text = plain(await ask('forecast', ['Badda'], { meteoOverrides: STORMY }));
  assert.match(text, /Today · \d+–\d+ °C\nrain 37\.7 mm · chance 85%\ngust 25 km\/h · thunder: High/);
  assert.match(text, /Tomorrow ·/);
  assert.match(text, /13 Oct ·/);
});

test('answers: alerts shows the titles and times, escapes them, and is not an all-clear when there are none', async () => {
  const subscriber = { _id: 's', language: 'en', areas: [{ upazilaPcode: BADDA }] };
  const none = plain(await ask('alerts', [], {}, { subscriberForChat: async () => subscriber }));
  assert.match(none, /no active AkashSathi alert/);
  assert.match(none, /Weather forecast: \/update/);
  assert.deepEqual(lintText(none), []);

  const items = [
    { severity: 'WARNING', title: 'Heavy rain <near> Badda & Dhaka', validUntil: new Date(NOW + 5 * 3_600_000) },
    ...Array.from({ length: 6 }, (_, i) => ({ severity: 'ADVISORY', title: `Heat ${i}`, validUntil: new Date(NOW + 3_600_000) })),
  ];
  const result = await ask('alerts', [], {}, { subscriberForChat: async () => subscriber, alertsFor: async () => ({ items }) });
  const html = textOf(result);
  assert.match(html, /<b>Warning<\/b> · Heavy rain &lt;near&gt; Badda &amp; Dhaka\nUntil: today 15:00/);
  assert.match(html, /…and 2 more in the app\./);

  const unlinked = plain(await ask('alerts'));
  assert.match(unlinked, /not connected to an alert profile/);
});

test('answers: status shows the age of each source and the alert engine, and says STALE when a source is', async () => {
  const text = plain(await ask('status', [], { bmdStatus: 'stale' }));
  assert.match(text, /⚠ BMD forecast: STALE\nUpdated: today 08:00 · 2 h ago/);
  assert.match(text, /✅ Open-Meteo forecast: current/);
  assert.match(text, /Alert engine: last run 1 min ago/);
  assert.doesNotMatch(text, /station readings|not continuous monitoring|Prototype information/);
  const off = plain(await ask('status', [], {}, { engineStatus: async () => ({ enabled: false, lastCompletedMs: null }) }));
  assert.match(off, /Alert engine: switched off/);
  const never = plain(await ask('status', [], { bmd: null }, { engineStatus: async () => ({ enabled: true, lastCompletedMs: null }) }));
  assert.match(never, /has not run yet/);
});

// ---------- help, menu and buttons ----------

test('help: lists every command, in one language or both', () => {
  const both = renderHelp(null);
  const english = renderHelp('en');
  const bangla = renderHelp('bn');
  for (const name of COMMAND_NAMES) {
    assert.ok(english.includes(`/${name} `), `en /${name}`);
    assert.ok(bangla.includes(`/${name} `), `bn /${name}`);
  }
  assert.ok(both.includes(english) && both.includes(bangla));
  assert.match(english, /\/heat Badda/);
  assert.match(bangla, /বাড্ডা/);
  assert.match(english, /Connect Telegram/);
});

test('menu: Telegram\'s command list is valid (names, lengths) and includes every command, thunderstorm too', () => {
  for (const lang of ['en', 'bn']) {
    const menu = commandMenu(lang);
    assert.ok(menu.length <= 100);
    for (const entry of menu) {
      assert.match(entry.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(entry.description.length >= 3 && entry.description.length <= 256, entry.command);
    }
    const names = menu.map((entry) => entry.command);
    for (const name of COMMAND_NAMES) assert.ok(names.includes(name), `${lang} ${name}`);
    assert.ok(names.includes('thunderstorm') && names.includes('help') && names.includes('stop'));
    assert.equal(new Set(names).size, names.length);
  }
});

test('buttons: each carries data Telegram accepts (64 bytes) and that the bot understands', () => {
  for (const place of [placeById(BADDA), placeById(DHAKA), findPlaces('Dhaka North City Corporation').matches[0]]) {
    const rows = buttonsFor(place, 'bn');
    const flat = rows.flat();
    assert.equal(flat.length, 6);
    for (const button of flat) {
      assert.ok(Buffer.byteLength(button.data) <= 64, button.data);
      assert.match(button.data, /^r:(heat|rain|wind|thunderstorm|lightning|forecast):[0-9A-Za-z]+:(bn|en)$/);
      assert.ok(button.text.length > 2 && button.text.length <= 40);
    }
  }
});

// ---------- the bot ----------

test('bot: a weather command is answered as formatted text and /update brings buttons that work when pressed', async () => {
  const channels = fakeChannels();
  const deps = depsFor({ bmdOverrides: HOT, meteoOverrides: STORMY });
  const now = new Date(NOW);

  const result = await handleTelegramUpdate(message('/update Badda', { updateId: 1 }), { channels, now, deps });
  assert.deepEqual(result, { handled: true, action: 'update' });
  const sent = channels.telegram.sent[0];
  assert.equal(sent.to, '4242');
  assert.equal(sent.content.parseMode, 'HTML');
  assert.match(sent.content.text, /<b>Badda<\/b>/);
  const flat = sent.content.buttons.flat();
  assert.equal(flat.length, 6);

  let updateId = 10;
  for (const button of flat) {
    updateId += 1;
    const before = channels.telegram.sent.length;
    const pressed = await handleTelegramUpdate(press(button.data, { updateId }), { channels, now, deps });
    assert.equal(pressed.handled, true, button.data);
    assert.equal(channels.telegram.sent.length, before + 1, `${button.data} answered`);
    assert.match(channels.telegram.sent.at(-1).content.text, /Badda/);
  }
  assert.equal(channels.telegram.answered.length, 6, 'every press stops the button\'s spinner');
});

test('bot: a button that does not parse, names an unknown place or comes from a group is ignored', async () => {
  const channels = fakeChannels();
  const deps = depsFor();
  const now = new Date(NOW);
  for (const data of ['', 'x', 'r:heat', 'r:alerts:302604:en', 'r:heat:NOPE:en', 'r:heat:302604:fr', `r:heat:302604:en${'a'.repeat(80)}`, 'r:drop table:1:en']) {
    const result = await handleTelegramUpdate(press(data, { updateId: Math.floor(Math.random() * 1e9) }), { channels, now, deps });
    assert.equal(result.action, 'ignored', data);
  }
  assert.equal(channels.telegram.sent.length, 0);
  assert.deepEqual(await handleTelegramUpdate(press('r:heat:302604:en', { updateId: 77, type: 'group' }), { channels, now, deps }), { handled: false });
  assert.deepEqual(await handleTelegramUpdate({ update_id: 78, callback_query: { id: 'x', data: 5, message: { chat: { id: 1, type: 'private' } } } }, { channels, now, deps }), { handled: false });
  assert.equal(channels.telegram.sent.length, 0);
});

test('bot: the same update delivered twice is answered once', async () => {
  const channels = fakeChannels();
  const deps = depsFor();
  const now = new Date(NOW);
  await handleTelegramUpdate(message('/heat Badda', { updateId: 5 }), { channels, now, deps });
  assert.equal((await handleTelegramUpdate(message('/heat Badda', { updateId: 5 }), { channels, now, deps })).duplicate, true);
  await handleTelegramUpdate(press('r:rain:302604:en', { updateId: 6 }), { channels, now, deps });
  assert.equal((await handleTelegramUpdate(press('r:rain:302604:en', { updateId: 6 }), { channels, now, deps })).duplicate, true);
  assert.equal(channels.telegram.sent.length, 2);
});

test('bot: command words are matched case-insensitively, with the bot name, and a group chat is ignored', async () => {
  const channels = fakeChannels();
  const deps = depsFor();
  const now = new Date(NOW);
  assert.equal((await handleTelegramUpdate(message('/HEAT@AkshSathiBot badda', { updateId: 1 }), { channels, now, deps })).action, 'heat');
  assert.equal((await handleTelegramUpdate(message('/thunder Badda', { updateId: 2 }), { channels, now, deps })).action, 'thunderstorm');
  assert.equal((await handleTelegramUpdate(message('/weather Badda bn', { updateId: 3 }), { channels, now, deps })).action, 'update');
  assert.match(channels.telegram.sent.at(-1).content.text, /বাড্ডা/);
  assert.deepEqual(await handleTelegramUpdate(message('/heat Badda', { updateId: 4, type: 'supergroup' }), { channels, now, deps }), { handled: false });
  assert.equal(channels.telegram.sent.length, 3);
});

test('bot: one chat can only ask so often; it is told once, other chats are unaffected, and /stop is never limited', async () => {
  env.channels.telegram.commandLimit = 2;
  resetBotForTests();
  const channels = fakeChannels();
  const deps = depsFor();
  const now = new Date(NOW);
  const send = (text, chatId, updateId) => handleTelegramUpdate(message(text, { chatId, updateId }), { channels, now, deps });

  assert.equal((await send('/heat Badda', 9, 1)).action, 'heat');
  assert.equal((await send('/rain Badda', 9, 2)).action, 'rain');
  const before = channels.telegram.sent.length;
  assert.equal((await send('/wind Badda', 9, 3)).action, 'rate-limited');
  assert.equal(channels.telegram.sent.length, before + 1);
  assert.match(channels.telegram.sent.at(-1).content.text, /very quickly/);
  assert.equal(channels.telegram.sent.at(-1).content.parseMode, undefined);
  assert.equal((await send('/wind Badda', 9, 4)).action, 'rate-limited');
  assert.equal(channels.telegram.sent.length, before + 1, 'the warning is not repeated');
  assert.equal((await send('/heat Badda', 10, 5)).action, 'heat');
  assert.equal((await handleTelegramUpdate(press('r:heat:302604:en', { chatId: 9, updateId: 6 }), { channels, now, deps })).action, 'rate-limited', 'buttons count too');
});

test('bot: if Telegram refuses the formatting the same words go out as plain text', async () => {
  const channels = fakeChannels({ failHtml: true });
  await handleTelegramUpdate(message('/heat Badda', { updateId: 1 }), { channels, now: new Date(NOW), deps: depsFor({ bmdOverrides: HOT }) });
  assert.equal(channels.telegram.sent.length, 2);
  const fallback = channels.telegram.sent[1].content;
  assert.equal(fallback.parseMode, undefined);
  assert.ok(!/<\/?[bi]>/.test(fallback.text), 'no tags left');
  assert.equal(fallback.text, toPlain(channels.telegram.sent[0].content.text));
  assert.match(fallback.text, /Heat index · next 12 hours/);
});

test('bot: an error while preparing a reply is answered with an apology, not silence, and leaks nothing', async () => {
  const channels = fakeChannels();
  const deps = depsFor({}, { loadForecast: () => { throw new Error('secret internal detail'); } });
  const log = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  let result;
  try {
    result = await handleTelegramUpdate(message('/heat Badda', { updateId: 1 }), { channels, now: new Date(NOW), deps });
  } finally {
    console.error = log;
  }
  assert.ok(!logged.join('').includes('secret internal detail'), 'the log names the kind of error, not its text');
  assert.equal(result.action, 'error');
  assert.match(channels.telegram.sent[0].content.text, /Something went wrong/);
  assert.ok(!JSON.stringify(channels.telegram.sent).includes('secret internal detail'));
});

// ---------- the Telegram adapter ----------

test('adapter: formatted messages carry parse mode and inline buttons; plain alerts carry neither', async () => {
  const calls = [];
  const channel = createTelegramChannel({
    config: { token: 'TOKEN', apiUrl: 'https://telegram.test' },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    },
  });

  await channel.send({ to: 5, content: { text: 'plain alert' } });
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['chat_id', 'disable_web_page_preview', 'text']);

  await channel.send({ to: 5, content: { text: '<b>x</b>', parseMode: 'HTML', buttons: [[{ text: 'Heat', data: 'r:heat:1:en' }, { text: 'Rain', data: 'r:rain:1:en' }]] } });
  assert.equal(calls[1].body.parse_mode, 'HTML');
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [[{ text: 'Heat', callback_data: 'r:heat:1:en' }, { text: 'Rain', callback_data: 'r:rain:1:en' }]] });

  await channel.send({ to: 5, content: { text: 'no buttons', parseMode: 'HTML', buttons: null } });
  assert.equal(calls[2].body.reply_markup, undefined);

  await channel.getUpdates(0, 1);
  assert.deepEqual(calls[3].body.allowed_updates, ['message', 'callback_query']);
  await channel.setWebhook('https://x.test/hook', 'a'.repeat(20));
  assert.deepEqual(calls[4].body.allowed_updates, ['message', 'callback_query']);

  await channel.answerCallbackQuery('cb1');
  assert.deepEqual(calls[5], { url: 'https://telegram.test/botTOKEN/answerCallbackQuery', body: { callback_query_id: 'cb1' } });

  await channel.setCommands([{ command: 'heat', description: 'Heat' }]);
  await channel.setCommands([{ command: 'heat', description: 'গরম' }], 'bn');
  assert.deepEqual(calls[6].body, { commands: [{ command: 'heat', description: 'Heat' }] });
  assert.equal(calls[7].body.language_code, 'bn');
  assert.ok(calls.every((call) => call.url.startsWith('https://telegram.test/botTOKEN/')));
});

test('adapter: the menu is registered once at start-up in both languages, and a failure there does not stop the bot', async () => {
  const { startTelegramBot } = await import('../src/services/delivery/telegramBot.js');
  const calls = [];
  const logs = [];
  const channels = {
    telegram: {
      available: true,
      getUsername: async () => 'Bot',
      setCommands: async (commands, lang) => { calls.push({ names: commands.map((entry) => entry.command), lang: lang ?? null }); if (lang === 'bn') throw new ChannelError('retry', 'down'); },
      deleteWebhook: async () => {},
      getUpdates: () => new Promise(() => {}),
    },
  };
  const bot = startTelegramBot({ channels, log: { log: (line) => logs.push(line), error: (line) => logs.push(line) } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  bot.stop();
  assert.deepEqual(calls.map((call) => call.lang), [null, 'bn']);
  assert.ok(calls[0].names.includes('thunderstorm'));
  assert.ok(logs.some((line) => /could not register the command menu/.test(line)));
  assert.ok(logs.some((line) => /polling for updates/.test(line)), 'it still polls');
});

test('alerts text: the web link keeps its digits in Bangla', () => {
  assert.match(renderAlerts({ lang: 'bn', nowMs: NOW, linked: false, webUrl: 'https://site.test:5173' }), /https:\/\/site\.test:5173\/alert/);
});
