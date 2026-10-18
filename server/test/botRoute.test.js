import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { NEIGHBOURHOODS as CLIENT_NEIGHBOURHOODS } from '../../client/src/lib/neighbourhoods.js';
import { env } from '../src/config/env.js';
import { postRouteWeather } from '../src/controllers/routeWeatherController.js';
import { lintText } from '../src/services/alerts/messages.js';
import { answerCommand } from '../src/services/delivery/botReports/commands.js';
import { loadForecast } from '../src/services/delivery/botReports/readings.js';
import { departureTime, parseRouteText, splitWords } from '../src/services/delivery/botReports/routeCommand.js';
import {
  districtTown, findRoutePlaces, pointEntry, routePlaceById, routePlaceInternals,
} from '../src/services/delivery/botReports/routePlaces.js';
import { toPlain } from '../src/services/delivery/botReports/text.js';
import { createTelegramChannel } from '../src/services/delivery/channels/telegram.js';
import { handleTelegramUpdate, resetBotForTests } from '../src/services/delivery/telegramBot.js';
import { districts, locations } from '../src/services/geo.js';
import { geocodePlace, resetGeocoderForTests } from '../src/services/geocode.js';
import { NEIGHBOURHOODS } from '../src/services/neighbourhoods.js';
import { buildRouteWeather } from '../src/services/routeWeather.js';
import { NOW, forecastInputs } from './support/botFixtures.js';

// ---------- helpers ----------
// 10:00 in Bangladesh. Step 4 (12:00-15:00) is hot, step 6 (18:00-21:00) stormy, everywhere: a 9-hour trip meets both.
const HOT = { all: { hi: { 3: 36.4, 4: 41.2 }, wg: { 6: 52 } } };
const STORMY = { all: { rf: { 5: 3.1, 6: 26.5 }, ts: { 5: 1, 6: 3 }, wmo: { 5: 80, 6: 95 }, pop: { 5: 60, 6: 85 } } };
const EVERYWHERE = forecastInputs({ pcodes: locations.map((location) => location.pcode), bmdOverrides: HOT, meteoOverrides: STORMY });
const HOUR = 3_600_000;
const MOTIJHEEL = '90.4231,23.7358';
const BANDARBAN_SADAR = '92.1894,22.1483';
const BUTTON = /^t:[0-9A-Za-z]{1,24}:[0-9A-Za-z]{1,24}:(0|3|m):(bn|en)$/;

// A stand-in for OSRM: one straight road between the two points; side-point (via) searches find nothing.
function fakeOsrm({ durationS = 9 * 3600, distanceM = 326_000, endSnapM = 40, fail = null } = {}) {
  const calls = [];
  async function fetchImpl(url) {
    calls.push(url);
    if (fail === 'network') throw new TypeError('fetch failed');
    const points = url.split('/driving/')[1].split('?')[0].split(';').map((pair) => pair.split(',').map(Number));
    if (fail === 'no-road' || points.length === 3) return { ok: false, status: 400, json: async () => ({ code: 'NoRoute', message: 'Impossible route' }) };
    const [a, b] = points;
    const coordinates = Array.from({ length: 7 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / 6, a[1] + ((b[1] - a[1]) * i) / 6]);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 'Ok', routes: [{ distance: distanceM, duration: durationS, geometry: { coordinates } }], waypoints: [{ distance: 30 }, { distance: endSnapM }],
      }),
    };
  }
  return { fetchImpl, calls };
}

function routeDeps({ osrm = fakeOsrm(), forecast = EVERYWHERE, ...extra } = {}) {
  return {
    loadForecast: ({ now }) => loadForecast({ ...forecast, now }),
    routeWeather: (args) => buildRouteWeather({ ...args, fetchImpl: osrm.fetchImpl }),
    subscriberForChat: async () => null,
    telegramLanguage: async () => null,
    lightningFor: async () => ({ pick: { kind: 'none', sampledMs: NOW - 30 * 60_000, count: 0, radiusKm: 100 }, error: false }),
    stormSnapshot: async () => null,
    routeHazards: async () => [],
    geocode: async () => [],
    ...extra,
  };
}

const route = (text, deps = routeDeps(), more = {}) => answerCommand({
  command: 'route', rest: text ? text.split(' ') : [], chatId: '7', nowMs: NOW, deps, ...more,
});
const textOf = (result) => result.messages.map((message) => message.text).join('\n');
const plain = (result) => toPlain(textOf(result));

function fakeChannels() {
  const sent = [];
  const actions = [];
  return {
    telegram: {
      name: 'telegram',
      available: true,
      sent,
      actions,
      async send(args) {
        sent.push(args);
        return { providerMessageId: String(sent.length) };
      },
      async answerCallbackQuery() {},
      async sendChatAction(chatId) {
        actions.push(chatId);
      },
    },
  };
}

let updateId = 1000;
const message = (text) => ({ update_id: (updateId += 1), message: { chat: { id: 4242, type: 'private' }, text, from: {} } });
const press = (data) => ({ update_id: (updateId += 1), callback_query: { id: `cb-${updateId}`, data, message: { chat: { id: 4242, type: 'private' } }, from: {} } });
const location = (latitude, longitude) => ({
  update_id: (updateId += 1), message: { chat: { id: 4242, type: 'private' }, location: { latitude, longitude }, date: Math.floor(NOW / 1000), from: {} },
});

let originalLimit;
beforeEach(() => {
  originalLimit = env.channels.telegram.commandLimit;
  resetBotForTests();
  resetGeocoderForTests();
});
afterEach(() => {
  env.channels.telegram.commandLimit = originalLimit;
});

// ---------- places ----------
test('route places: every district has a town, and Dhaka, Rajshahi and the "Kotwali" towns are the right ones', () => {
  for (const district of districts) assert.ok(districtTown(district.pcode), district.name);
  assert.equal(districtTown('3026').name, 'Motijheel');
  assert.equal(districtTown('5081').name, 'Boalia');
  assert.equal(districtTown('2015').name, 'Kotwali');
  assert.equal(districtTown('2019').name, 'Comilla Adarsha Sadar', 'the town, not "Sadar Dakshin"');
  assert.equal(districtTown('2003').name, 'Bandarban Sadar');
  const bandarban = routePlaceById('2003');
  assert.equal(bandarban.pointName, 'Bandarban Sadar');
  assert.ok(Math.abs(bandarban.lat - 22.15) < 0.05, 'the road goes to the town, not the middle of the district');
});

test('route places: every place has a short, unique, button-safe id and a point in Bangladesh', () => {
  const entries = routePlaceInternals.entries();
  const ids = new Set();
  for (const item of entries) {
    assert.match(item.id, /^[0-9A-Za-z]{1,24}$/, item.name);
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    assert.ok(item.lat >= 20.3 && item.lat <= 26.9 && item.lon >= 87.5 && item.lon <= 93.2, item.name);
    assert.equal(routePlaceById(item.id), item);
  }
  const count = (level) => entries.filter((item) => item.level === level).length;
  assert.equal(count('division'), 8);
  assert.equal(count('district'), 64);
  assert.ok(count('location') > 500);
  assert.ok(count('area') > 5000, 'unions, paurashavas and wards');
  assert.ok(count('neighbourhood') > 60);
});

test('route places: old spellings, divisions, unions, neighbourhoods, landmarks and Bangla names are found', () => {
  const cases = [
    ['Chittagong', 'Chattogram', 'district'], ['Comilla', 'Cumilla', 'district'], ['Jessore', 'Jashore', 'district'], ['Bogra', 'Bogura', 'district'],
    ['Barisal', 'Barishal', 'district'], ['Dhaka city', 'Dhaka', 'district'], ['Faridpur', 'Faridpur', 'district'], ['Mymensing', 'Mymensingh', 'district'],
    ['Rangpur division', 'Rangpur', 'division'], ['Banasree', 'Banasree', 'neighbourhood'], ['Sajek', 'Sajek', 'area'],
    ['Saint Martin', 'St.Martin Dwip', 'area'], ["St. Martin's Island", 'St.Martin Dwip', 'area'], ['Kuakata', 'Kuakata', 'landmark'],
    ['Kalapara Paurashava', 'Kalapara Paurashava', 'area'], ['বান্দরবান', 'Bandarban', 'district'], ['Savar Dhaka', 'Savar', 'location'],
  ];
  for (const [query, name, level] of cases) {
    const { matches } = findRoutePlaces(query);
    assert.equal(matches.length, 1, query);
    assert.equal(matches[0].name, name, query);
    assert.equal(matches[0].level, level, query);
  }
});

test('route places: a shared name asks, bigger places first, and counts the smaller ones it hides', () => {
  assert.deepEqual(findRoutePlaces('Mirpur').matches.map((item) => item.kind), ['thana', 'upazila']);
  const durgapur = findRoutePlaces('Durgapur');
  assert.equal(durgapur.matches.length, 2);
  assert.ok(durgapur.matches.every((item) => item.kind === 'upazila'));
  assert.ok(durgapur.hidden >= 10, 'unions of the same name');
  const unions = findRoutePlaces('Durgapur union');
  assert.ok(unions.total >= 10 && unions.matches.every((item) => item.kind === 'union'));
  assert.deepEqual(findRoutePlaces('Durgapur, Rajshahi').matches.map((item) => item.id), ['508131']);
});

test('route places: a misspelt name is only a suggestion, and a map point keeps its position in its id', () => {
  assert.equal(findRoutePlaces('Bandarbn').matches.length, 0);
  const near = findRoutePlaces('Bandarbn', { near: true });
  assert.equal(near.tier, 4);
  assert.equal(near.matches[0].name, 'Bandarban');

  const park = pointEntry({ name: 'Jamuna Future Park', lat: 23.8134982, lon: 90.4240893 });
  assert.equal(park.id, 'G23813509042409');
  assert.equal(routePlaceById(park.id).name, 'Jamuna Future Park');
  const unseen = routePlaceById('G22150009219000');
  assert.ok(unseen && unseen.name && unseen.weatherId, 'rebuilt from the id after a restart, named after its area');
  assert.equal(pointEntry({ name: 'New York', lat: 40.7, lon: -74 }), null);
});

test('neighbourhoods: the bot uses the same list as the route page', () => {
  assert.deepEqual(NEIGHBOURHOODS, CLIENT_NEIGHBOURHOODS);
});

// ---------- reading what was typed ----------
test('route text: "to" is optional, and a single place, "here" and a trailing "to" are understood', () => {
  const pair = (text) => {
    const parsed = parseRouteText(text);
    return parsed.kind === 'words' ? splitWords(parsed.words) : parsed;
  };
  assert.deepEqual(pair('Dhaka to Bandarban'), { kind: 'pair', from: 'Dhaka', to: 'Bandarban' });
  assert.deepEqual(pair('ঢাকা থেকে বান্দরবান'), { kind: 'pair', from: 'ঢাকা', to: 'বান্দরবান' });
  assert.deepEqual(pair('Dhaka - Bandarban'), { kind: 'pair', from: 'Dhaka', to: 'Bandarban' });
  assert.deepEqual(pair('from Savar to Badda'), { kind: 'pair', from: 'Savar', to: 'Badda' });
  assert.deepEqual(pair('Dhaka bandarban'), { kind: 'pair', from: 'Dhaka', to: 'bandarban' });
  assert.deepEqual(pair('ঢাকা বান্দরবান'), { kind: 'pair', from: 'ঢাকা', to: 'বান্দরবান' });
  assert.deepEqual(pair('Savar Dhaka Bandarban'), { kind: 'pair', from: 'Savar Dhaka', to: 'Bandarban' });
  assert.deepEqual(pair('Mirpur 10 Bandarban'), { kind: 'pair', from: 'Mirpur 10', to: 'Bandarban' });
  assert.deepEqual(pair("Cox's Bazar Dhaka"), { kind: 'pair', from: "Cox's Bazar", to: 'Dhaka' });
  assert.deepEqual(pair('Dhaka Jamuna Future Park'), { kind: 'pair', from: 'Dhaka', to: 'Jamuna Future Park' }, 'the unknown end goes to the map search');

  assert.deepEqual(pair("Cox's Bazar"), { kind: 'single', text: "Cox's Bazar" }, 'one place with a two-word name');
  assert.deepEqual(pair('Mirpur 10'), { kind: 'single', text: 'Mirpur 10' });
  assert.deepEqual(pair('to Sylhet'), { kind: 'single', text: 'Sylhet' });
  assert.deepEqual(pair('Dhaka to'), { kind: 'from-only', text: 'Dhaka' });
  assert.deepEqual(pair(''), { kind: 'empty' });
  assert.deepEqual(pair('here'), { kind: 'here' });
  for (const text of ['here Sylhet', 'my location to Sylhet', 'আমার অবস্থান থেকে Sylhet']) {
    const parsed = pair(text);
    assert.equal(typeof parsed.from, 'symbol', text);
    assert.equal(parsed.to, 'Sylhet', text);
  }
});

test('route departure: now, in three hours, or tomorrow at 07:00 Bangladesh time', () => {
  assert.equal(departureTime('0', NOW), NOW);
  assert.equal(departureTime('3', NOW), NOW + 3 * HOUR);
  assert.equal(departureTime('m', NOW), Date.parse('2026-10-12T07:00:00+06:00'));
});

// ---------- the reply ----------
test('route reply: /route Dhaka bandarban gives the trip, the worst weather and when, the stops, the destination and buttons', async () => {
  const osrm = fakeOsrm();
  const result = await route('Dhaka bandarban', routeDeps({ osrm }));
  assert.equal(result.action, 'route');
  assert.ok(osrm.calls[0].includes(`${MOTIJHEEL};${BANDARBAN_SADAR}`), 'district to district goes town to town');

  const text = plain(result);
  assert.match(text, /Dhaka → Bandarban/);
  assert.match(text, /326 km · 🕒 about 9 h · shortest road/);
  assert.match(text, /Leave now \(10:00\) → arrive about today 19:00/);
  assert.match(text, /Road from Motijheel to Bandarban Sadar\./);
  assert.match(text, /⛈ High thunderstorm potential near .+ · ~1[89]:\d\d/);
  assert.match(text, /🌧 Heavy rain near .+ · 26\.5 mm in 3 h/);
  assert.match(text, /🥵 Heat index 41 °C \(Danger\) near/);
  assert.match(text, /💨 Gusts up to 52 km\/h near/);
  assert.ok(text.indexOf('⛈ High') < text.indexOf('🥵 Heat'), 'the most severe first');
  assert.match(text, /🗺 Along the way/);
  assert.match(text, /🔴 \d\d:\d\d(–\d\d:\d\d)? /, 'a severe stop');
  assert.match(text, /\d\d:\d\d–\d\d:\d\d /, 'a stop the trip spends hours in shows when it enters and leaves');
  assert.match(text, /Bandarban after you arrive/);
  assert.match(text, /Forecast for Bandarban Sadar\./);
  assert.match(text, /© OpenStreetMap contributors/);
  assert.deepEqual(lintText(text), []);
  assert.ok(result.messages[0].text.length <= 3800);

  const { buttons } = result.messages[0];
  assert.deepEqual(buttons[0].map((button) => button.data), ['t:2003:3026:0:en'], 'way back');
  assert.deepEqual(buttons[1].map((button) => button.data), ['t:3026:2003:3:en', 't:3026:2003:m:en']);
  for (const button of buttons.flat()) {
    assert.match(button.data, BUTTON);
    assert.ok(Buffer.byteLength(button.data) <= 64);
  }

  const bangla = await route('Dhaka bandarban bn');
  assert.equal(bangla.lang, 'bn');
  assert.match(plain(bangla), /ঢাকা → বান্দরবান/);
  assert.match(plain(bangla), /৩২৬ কিমি/);
  assert.match(plain(bangla), /পৌঁছানোর পর বান্দরবান/);
});

test('route reply: a missing forecast is ⚪ and never calm', async () => {
  // The fixture has data for Savar, Badda and Amtali only: the places between have none.
  const partial = plain(await route('Savar Amtali', routeDeps({ forecast: forecastInputs() })));
  const lines = partial.split('\n');
  assert.ok(lines.some((line) => line.startsWith('⚪') && line.includes('no forecast for this time')));
  assert.ok(lines.filter((line) => line.includes('no forecast for this time')).every((line) => line.startsWith('⚪')));
  assert.match(partial, /Forecast for \d+ of \d+ points on the road\./);

  const none = plain(await route('Dhaka Bandarban', routeDeps({ forecast: forecastInputs({ bmd: null, openMeteo: null }) })));
  assert.match(none, /No forecast is available for this road at these times\./);
  assert.match(none, /No forecast for the destination at that time\./);
  assert.doesNotMatch(none, /No heavy rain/);
  assert.doesNotMatch(none, /🟢 \d/);
});

test('route reply: lightning, a storm cloud on the road and active alerts for a trip now; none of the live ones for tomorrow', async () => {
  const asked = { lightning: 0, storm: 0, hazards: [] };
  const deps = routeDeps({
    lightningFor: async () => {
      asked.lightning += 1;
      return { pick: { kind: asked.lightning === 2 ? 'reported' : 'none', sampledMs: NOW - 20 * 60_000, count: 3, radiusKm: 100 }, error: false };
    },
    // A strong cell that reaches every place 45 minutes from now: the trip passes its second road point at 11:00.
    stormSnapshot: async () => {
      asked.storm += 1;
      return {
        observedAtMs: NOW - 15 * 60_000,
        cells: [{ intensity: 6, trend: 'growing', motion: { towards: 'E', speedKmh: 30 }, reaches: locations.map((item) => ({ pcode: item.pcode, etaMin: 60 })) }],
      };
    },
    routeHazards: async (args) => {
      asked.hazards.push(args);
      return [{ hazardType: 'HEAVY_RAIN', coverage: { upazilaPcodes: [], districtPcodes: districts.map((item) => item.pcode) }, validUntil: new Date(NOW + 13 * HOUR) }];
    },
  });
  const now = plain(await route('Dhaka Bandarban', deps));
  assert.match(now, /⚡ Lightning recorded near .+ · last check today 09:40/);
  assert.match(now, /🛰 A storm cloud may reach .+ around 10:45; you pass about 11:00\./);
  assert.match(now, /🔔 Heavy rain · .+ · until today 23:00/);
  assert.equal(asked.hazards[0].fromMs, NOW);
  assert.equal(asked.hazards[0].untilMs, NOW + 9 * HOUR);
  assert.ok(asked.hazards[0].pcodes.length > 3 && asked.hazards[0].districtCodes.includes('3026'));

  const before = { lightning: asked.lightning, storm: asked.storm };
  const tomorrow = await answerCommand({
    command: 'route', routeIds: { from: '3026', to: '2003' }, departure: 'm', langOverride: 'en', chatId: '7', nowMs: NOW, deps,
  });
  const later = plain(tomorrow);
  assert.match(later, /Leave tomorrow 07:00 → arrive about tomorrow 16:00/);
  assert.doesNotMatch(later, /⚡|🛰/);
  assert.deepEqual({ lightning: asked.lightning, storm: asked.storm }, before, 'live observations are not read for a later trip');
  assert.deepEqual(tomorrow.messages[0].buttons[1].map((button) => button.data), ['t:3026:2003:0:en', 't:3026:2003:3:en']);
});

test('route reply: a name the lists do not know goes to the map search; a failed search says so', async () => {
  const geocode = async (query) => (query === 'Jamuna Future Park' ? [{ name: 'Jamuna Future Park', lat: 23.8135, lon: 90.4241 }] : []);
  const found = await route('Mirpur 10 Jamuna Future Park', routeDeps({ geocode }));
  assert.equal(found.action, 'route');
  assert.match(plain(found), /Mirpur 10 → Jamuna Future Park/);
  assert.match(plain(found), /use the forecast of the upazila or thana they lie in/);
  assert.match(found.messages[0].buttons[0][0].data, /^t:G\d{14}:Nmirpur10:0:en$/);

  const down = await route('Dhaka to Jamuna Future Park', routeDeps({ geocode: async () => { throw new Error('timeout'); } }));
  assert.equal(down.action, 'route-not-found');
  assert.match(plain(down), /The map place search is not responding right now\./);

  const abroad = await route('Dhaka to Times Square', routeDeps({ geocode: async () => [{ name: 'Times Square', lat: 40.758, lon: -73.985 }] }));
  assert.equal(abroad.action, 'route-not-found', 'a point outside Bangladesh is not used');
});

test('route reply: an ambiguous or misspelt end offers buttons that carry the other end; two unclear ends get an example', async () => {
  const mirpur = await route('Mirpur Bandarban');
  assert.equal(mirpur.action, 'route-ambiguous');
  assert.deepEqual(mirpur.messages[0].buttons.map((row) => row[0].data), ['t:302648:2003:0:en', 't:405094:2003:0:en']);
  assert.match(plain(mirpur), /Mirpur, Dhaka \(City thana\)/);

  const typo = await route('Bandarbn Dhaka');
  assert.equal(typo.action, 'route-not-found');
  assert.match(plain(typo), /Did you mean:\n• Bandarban \(District\)/);
  assert.deepEqual(typo.messages[0].buttons.map((row) => row[0].data), ['t:2003:3026:0:en']);

  const both = await route('Durgapur to Mirpur');
  assert.equal(both.messages[0].buttons, undefined);
  assert.match(plain(both), /\/route Durgapur, \S+ to Mirpur, Dhaka/);
});

test('route reply: no road still gives the destination weather; an outage and the same place twice are said plainly', async () => {
  const island = await route('Dhaka Bandarban', routeDeps({ osrm: fakeOsrm({ fail: 'no-road' }) }));
  assert.equal(island.action, 'route-no-road');
  assert.equal(island.messages.length, 2);
  assert.match(island.messages[0].text, /No road route was found between Dhaka and Bandarban/);
  assert.match(toPlain(island.messages[1].text), /Bandarban Sadar/);

  const outage = await route('Dhaka Bandarban', routeDeps({ osrm: fakeOsrm({ fail: 'network' }) }));
  assert.equal(outage.action, 'route-error');
  assert.match(plain(outage), /not responding right now/);

  const same = await route('Dhaka Dhaka');
  assert.equal(same.action, 'route-same');
});

test('route reply: the road ending far from a place is mentioned', async () => {
  const text = plain(await route('Dhaka Thanchi', routeDeps({ osrm: fakeOsrm({ endSnapM: 7100 }) })));
  assert.match(text, /⚠ The road ends about 7\.1 km from Thanchi\./);
});

// ---------- the conversation in Telegram ----------
test('route in Telegram: one place asks for the start, and a typed name or a shared location answers it', async () => {
  const deps = routeDeps();
  const channels = fakeChannels();
  const now = new Date(NOW);

  assert.equal((await handleTelegramUpdate(message('/Route Bandarban'), { channels, now, deps })).action, 'ask-route-start');
  assert.match(channels.telegram.sent.at(-1).content.text, /Going to <b>Bandarban<\/b>\. Where do you start\?/);
  assert.equal(channels.telegram.sent.at(-1).content.requestLocation, true);
  assert.equal((await handleTelegramUpdate(message('Dhaka'), { channels, now, deps })).action, 'route');
  assert.match(toPlain(channels.telegram.sent.at(-1).content.text), /Dhaka → Bandarban/);

  await handleTelegramUpdate(message('/route Bandarban'), { channels, now, deps });
  assert.equal((await handleTelegramUpdate(location(23.85, 90.26), { channels, now, deps })).action, 'route');
  const [report, note] = channels.telegram.sent.slice(-2).map((item) => item.content);
  assert.match(toPlain(report.text), /Your location \(near Savar\) → Bandarban/);
  assert.match(note.text, /was used only for this route and was not saved/);
  assert.equal(note.removeKeyboard, true);
  assert.match(report.buttons[0][0].data, /^t:2003:302672:0:en$/, 'the way back goes to the area, not to the coordinates');

  assert.equal((await handleTelegramUpdate(message('/route'), { channels, now, deps })).action, 'ask-route');
  assert.equal((await handleTelegramUpdate(message('Dhaka Bandarban'), { channels, now, deps })).action, 'route');
  assert.equal((await handleTelegramUpdate(message('/route here Sylhet'), { channels, now, deps })).action, 'ask-route-start');
  assert.equal(channels.telegram.sent.at(-1).content.requestLocation, true);
});

test('route in Telegram: buttons plan the way back and later trips; an unknown place expires and nonsense is ignored', async () => {
  const deps = routeDeps();
  const channels = fakeChannels();
  const now = new Date(NOW);
  assert.equal((await handleTelegramUpdate(press('t:2003:3026:m:en'), { channels, now, deps })).action, 'route');
  assert.match(toPlain(channels.telegram.sent.at(-1).content.text), /Bandarban → Dhaka[\s\S]*Leave tomorrow 07:00/);
  assert.equal((await handleTelegramUpdate(press('t:Nnowhere:3026:0:en'), { channels, now, deps })).action, 'route-expired');
  assert.match(channels.telegram.sent.at(-1).content.text, /This button has expired/);
  assert.equal((await handleTelegramUpdate(press('t:2003:3026:9:en'), { channels, now, deps })).action, 'ignored');
});

test('route in Telegram: a road search shows "typing" and counts three against the chat limit', async () => {
  env.channels.telegram.commandLimit = 6;
  const deps = routeDeps();
  const channels = fakeChannels();
  const now = new Date(NOW);
  assert.equal((await handleTelegramUpdate(message('/Route Dhaka bandarban'), { channels, now, deps })).action, 'route', 'the example as typed');
  assert.equal((await handleTelegramUpdate(message('/route Dhaka Sylhet'), { channels, now, deps })).action, 'route');
  assert.equal((await handleTelegramUpdate(message('/route Dhaka Khulna'), { channels, now, deps })).action, 'rate-limited');
  assert.deepEqual(channels.telegram.actions, ['4242', '4242']);
});

test('telegram channel: sendChatAction shows "typing" in the chat', async () => {
  const calls = [];
  const channel = createTelegramChannel({
    config: { token: 'test-token', apiUrl: 'https://telegram.example' },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    },
  });
  await channel.sendChatAction('42');
  assert.equal(calls[0].url, 'https://telegram.example/bottest-token/sendChatAction');
  assert.deepEqual(calls[0].body, { chat_id: '42', action: 'typing' });
});

// ---------- the road service and the place search ----------
test('route weather: error codes, how far the road ends from the point, the half-hour road cache and the weather code', async () => {
  const osrm = fakeOsrm({ endSnapM: 7100 });
  const args = {
    start: { name: 'A', lat: 23.7358, lon: 90.4231 }, end: { name: 'B', lat: 22.1483, lon: 92.1894 }, nowMs: NOW, fetchImpl: osrm.fetchImpl,
    forecast: loadForecast({ ...EVERYWHERE, now: NOW }),
  };
  const first = await buildRouteWeather(args);
  assert.deepEqual(first.snap, { startKm: 0, endKm: 7.1 });
  assert.ok(first.samples.some((sample) => sample.weatherCode === 95));
  const callsAfterFirst = osrm.calls.length;
  await buildRouteWeather({ ...args, nowMs: NOW + 3 * HOUR });
  assert.equal(osrm.calls.length, callsAfterFirst, 'the same road is not searched again within half an hour');

  await assert.rejects(buildRouteWeather({ ...args, fetchImpl: fakeOsrm({ fail: 'no-road' }).fetchImpl }), { code: 'ROUTE_NO_ROAD' });
  await assert.rejects(buildRouteWeather({ ...args, fetchImpl: fakeOsrm({ fail: 'network' }).fetchImpl }), { code: 'ROUTE_SERVICE' });
  await assert.rejects(buildRouteWeather({ ...args, fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) }), { code: 'ROUTE_SERVICE' });
  await assert.rejects(buildRouteWeather({ ...args, end: args.start }), { code: 'ROUTE_SAME' });

  const response = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() {} };
  await postRouteWeather({ body: { start: { lat: 40, lon: -73 }, end: args.end } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /Bangladesh/);
});

test('place search: Bangladesh only, identified, cached, switched off on request, and a failure is an error', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => [
        { name: 'Ratargul', lat: '25.0025', lon: '91.9243', display_name: 'Ratargul, Sylhet, Bangladesh' },
        { name: '', lat: '25.0121', lon: '91.9229', display_name: 'Ratargul Swamp Forest, Gowainghat' },
        { name: 'Far away', lat: '40.7', lon: '-74.0' },
      ],
    };
  };
  const config = { geocoder: 'osm', geocoderUrl: 'https://nominatim.example', geocoderEmail: '' };
  const results = await geocodePlace('Ratargul', { fetchImpl, config, nowMs: NOW });
  assert.deepEqual(results.map((item) => item.name), ['Ratargul', 'Ratargul Swamp Forest']);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://nominatim.example/search');
  assert.equal(url.searchParams.get('countrycodes'), 'bd');
  assert.equal(url.searchParams.get('q'), 'Ratargul');
  assert.match(calls[0].options.headers['User-Agent'], /^AkashSathi\//);

  await geocodePlace('ratargul', { fetchImpl, config, nowMs: NOW + 60_000 });
  assert.equal(calls.length, 1, 'cached');
  assert.deepEqual(await geocodePlace('Ratargul', { fetchImpl: () => assert.fail('must not search'), config: { ...config, geocoder: 'off' } }), []);
  await assert.rejects(
    geocodePlace('Somewhere', { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), config, nowMs: NOW }),
    { code: 'GEOCODER_UNAVAILABLE' },
  );
});
