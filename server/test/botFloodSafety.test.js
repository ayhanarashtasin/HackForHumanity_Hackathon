import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { nearestSchoolShelters, normaliseShelters } from '../src/services/alerts/floodShelters.js';
import { answerCommand, canonicalCommand } from '../src/services/delivery/botReports/commands.js';
import { placeById } from '../src/services/delivery/botReports/places.js';
import { commandMenu, renderHelp, toPlain } from '../src/services/delivery/botReports/text.js';
import { handleTelegramUpdate, resetBotForTests } from '../src/services/delivery/telegramBot.js';
import { BADDA, NOW, SAVAR } from './support/botFixtures.js';

const point = placeById(BADDA);
const school = (id, name, offset) => ({ id, name, lat: point.lat + offset, lon: point.lon, capacity: 200, upazila: 'Badda', district: 'Dhaka', safeWater: true });
const shelters = [
  school('hall', 'Community Hall', 0),
  school('four', 'Fourth High School', .04),
  school('two', 'দ্বিতীয় প্রাথমিক বিদ্যালয়', .02),
  school('one', 'First Primary School <Annex> & Shelter', .01),
  school('three', 'তৃতীয় স্কুল', .03),
  school('college', 'মহাবিদ্যালয়', .001),
  school('far', 'Distant High School', 2),
];

const depsFor = (extra = {}) => ({
  subscriberForChat: async () => null,
  telegramLanguage: async () => null,
  loadForecast: () => assert.fail('school shelters must not depend on a weather forecast'),
  floodFor: async () => assert.fail('school shelters must not depend on FFWC river data'),
  schoolSheltersFor: async (place) => ({ status: 'FRESH', fetchedAt: new Date(NOW), shelters: nearestSchoolShelters(shelters, place.lat, place.lon) }),
  ...extra,
});
const ask = (rest = [], extra = {}) => answerCommand({ command: 'flood', rest: ['safety', ...rest], chatId: '1', nowMs: NOW, deps: depsFor(extra) });
const textOf = result => result.messages.map(item => item.text).join('\n');
const plain = result => toPlain(textOf(result));

beforeEach(resetBotForTests);

test('school shelters are filtered before taking the nearest three, in English and Bangla', () => {
  const result = nearestSchoolShelters(shelters, point.lat, point.lon);
  assert.deepEqual(result.map(item => item.id), ['one', 'two', 'three']);
  assert.ok(result.every((item, index) => !index || item.distanceKm >= result[index - 1].distanceKm));
  assert.ok(result.every(item => item.mapsUrl.startsWith('https://www.google.com/maps/dir/')));
  assert.equal(nearestSchoolShelters([shelters[2]], point.lat, point.lon).length, 1);
  assert.deepEqual(nearestSchoolShelters(shelters, null, null), []);
  assert.deepEqual(nearestSchoolShelters(shelters, 0, 0), []);

  const rows = ['Useable', 'Usable', 'Unusable', 'Non-useable', 'Damaged'].map((status, index) => ({
    id: index, name: 'Primary School', shelter_type_id: 'Flood', status, lat: point.lat, lon: point.lon,
  }));
  assert.deepEqual(normaliseShelters(rows).map(item => item.id), ['0', '1'], 'unusable schools must never be recommended');
});

test('/flood safety shows three DDM school shelters with directions, not a claim of verified safety', async () => {
  const result = await ask(['Badda', 'en']);
  assert.equal(result.action, 'flood_safety');
  const text = plain(result);
  assert.match(text, /Nearest school flood shelters/);
  assert.match(textOf(result), /First Primary School &lt;Annex&gt; &amp; Shelter/);
  assert.equal((textOf(result).match(/<a href="https:\/\/www\.google\.com\/maps\/dir\//g) ?? []).length, 3);
  assert.doesNotMatch(text, /Community Hall|Fourth High School|Distant High School|মহাবিদ্যালয়/);
  assert.match(text, /Listed capacity: 200/);
  assert.match(text, /not verified|not been verified/i);
  assert.match(text, /Do not cross floodwater/);
  assert.doesNotMatch(text, /\b(?:is|are|will be)\s+safe\b|\ball[- ]clear\b|\bguarantee/i);

  const bn = await ask(['বাড্ডা', 'bn']);
  assert.equal(bn.lang, 'bn');
  assert.match(plain(bn), /বিদ্যালয়|স্কুল/);
  assert.match(plain(bn), /২০০/);
  assert.doesNotMatch(plain(bn), /নিশ্চিত নিরাপদ|কোনো ঝুঁকি নেই/);
});

test('school shelter results distinguish old data, no nearby schools, disabled search and an outage', async () => {
  const reply = value => ask(['Badda'], { schoolSheltersFor: async () => value });
  assert.match(plain(await reply({ status: 'STALE', shelters: nearestSchoolShelters(shelters, point.lat, point.lon) })), /out of date/i);
  const empty = plain(await reply({ status: 'FRESH', shelters: [] }));
  assert.match(empty, /No DDM-listed school flood shelter.*50 km/);
  assert.doesNotMatch(empty, /1\./);
  assert.match(plain(await reply({ status: 'UNAVAILABLE', shelters: [] })), /unavailable/i);
  assert.match(plain(await reply({ status: 'UNAVAILABLE', disabled: true, shelters: [] })), /switched off/i);
  const failed = plain(await ask(['Badda'], { schoolSheltersFor: async () => { throw new Error('private diagnostic'); } }));
  assert.match(failed, /unavailable/i);
  assert.doesNotMatch(failed, /private diagnostic/);
});

test('school shelters use the recent area, else one saved area; an explicit place wins', async () => {
  const seen = [];
  const subscriber = { areas: [{ upazilaPcode: BADDA }, { upazilaPcode: SAVAR }], currentArea: { upazilaPcode: SAVAR, expiresAt: new Date(NOW + 60_000) } };
  const extra = {
    subscriberForChat: async () => subscriber,
    schoolSheltersFor: async place => { seen.push(place.id); return { status: 'FRESH', shelters: [] }; },
  };
  assert.equal((await ask([], extra)).messages.length, 1);
  assert.deepEqual(seen, [SAVAR]);
  await ask(['Badda'], extra);
  assert.equal(seen.at(-1), BADDA);
  subscriber.currentArea.expiresAt = new Date(NOW);
  assert.equal((await ask([], extra)).messages.length, 1, 'at most three schools for one reference area');
  assert.equal(seen.at(-1), BADDA);
});

test('Telegram keeps the safety command through place questions, GPS sharing and ambiguous-place buttons', async () => {
  const sent = [];
  const seen = [];
  const channels = { telegram: { send: async args => { sent.push(args.content); }, answerCallbackQuery: async () => {} } };
  const deps = depsFor({ schoolSheltersFor: async place => { seen.push(place); return { status: 'FRESH', shelters: [] }; } });
  let id = 0;
  const send = text => handleTelegramUpdate({ update_id: ++id, message: { chat: { id: 7, type: 'private' }, text, from: {} } }, { channels, now: new Date(NOW), deps });
  assert.equal((await send('/flood safety')).action, 'ask-place');
  assert.equal(sent.at(-1).requestLocation, true);
  assert.equal((await send('Badda')).action, 'flood_safety');
  assert.equal(seen.at(-1).id, BADDA);

  assert.equal((await send('/flood_safety')).action, 'ask-place');
  const gps = { latitude: 23.85, longitude: 90.26 };
  const shared = await handleTelegramUpdate({ update_id: ++id, message: { chat: { id: 7, type: 'private' }, from: {}, date: NOW / 1000, message_id: 10, location: gps } }, { channels, now: new Date(NOW), deps });
  assert.equal(shared.action, 'flood_safety');
  assert.equal(seen.at(-1).lat, gps.latitude, 'distance uses the actual shared point, not the upazila centre');
  assert.equal(seen.at(-1).lon, gps.longitude);
  assert.equal(sent.at(-1).removeKeyboard, true);
  assert.match(sent.at(-2).text, /location you just shared/);
  assert.doesNotMatch(sent.at(-2).text, /Forecast/);

  assert.equal((await send('/flood safety Mohammadpur')).action, 'ambiguous');
  const button = sent.at(-1).buttons[0][0];
  assert.match(button.data, /^r:flood_safety:/);
  const pressed = await handleTelegramUpdate({ update_id: ++id, callback_query: { id: 'button', data: button.data, message: { chat: { id: 7, type: 'private' } } } }, { channels, now: new Date(NOW), deps });
  assert.equal(pressed.action, 'flood_safety');
  assert.equal(canonicalCommand('/FLOOD_SAFETY@ExampleBot'), 'flood_safety');
  assert.ok(commandMenu('en').some(item => item.command === 'flood_safety'));
  assert.match(renderHelp('en'), /\/flood safety/);
});

test('/flood still gives river readings and offers a clickable school-shelter command', async () => {
  const result = await answerCommand({
    command: 'flood', rest: ['Badda'], chatId: '1', nowMs: NOW,
    deps: depsFor({ loadForecast: () => ({ base: null, stepsMs: [] }), floodFor: async () => ({ status: 'UNAVAILABLE' }) }),
  });
  assert.equal(result.action, 'flood');
  assert.match(plain(result), /River water level report/);
  assert.equal(result.messages[0].buttons[0][0].data, `r:flood_safety:${BADDA}:en`);
});
