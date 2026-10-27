import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeHospitalsHandler } from '../src/controllers/routeWeatherController.js';
import { buildRouteReport } from '../src/services/delivery/botReports/routeReport.js';
import { hospitalsFor } from '../src/services/delivery/botReports/data.js';
import { HOSPITALS_PER_PAGE, renderHospitalPage, renderRouteReport } from '../src/services/delivery/botReports/routeText.js';
import { toPlain } from '../src/services/delivery/botReports/text.js';
import {
  compactRoute, hospitalLabels, hospitalsAlongRoute, hospitalsInternals, indexHospitals, normalizePhone,
} from '../src/services/hospitals.js';
import { lintText } from '../src/services/alerts/messages.js';

// Savar -> Dhaka, about 18 km.
const ROAD = [[90.25, 23.85], [90.33, 23.815], [90.41, 23.78]];
const CONFIG = { enabled: true, radiusKm: 5, maxResults: 20 };

const ROWS = [
  // On the road, half way: ~9 km from both ends, so only a search along the whole road finds it.
  { id: 'node/1', name: 'Middle Hospital', nameBn: 'মধ্য হাসপাতাল', lat: 23.816, lon: 90.331, address: null, area: 'Savar, Dhaka', phone: '+880 2-7791234' },
  // Near the start, no name, no phone.
  { id: 'node/2', name: null, nameBn: null, lat: 23.852, lon: 90.255, address: null, area: null, phone: null },
  { id: 'way/3', name: 'Dhaka Clinic Building', nameBn: null, lat: 23.781, lon: 90.405, address: 'Mirpur Road', area: 'Mohammadpur, Dhaka', phone: '01711-000000; 01811-000000' },
  // ~40 km north: outside the radius.
  { id: 'node/4', name: 'Far Hospital', nameBn: null, lat: 24.2, lon: 90.33, address: null, area: null, phone: '01711000000' },
  // A phone tag that is not a number.
  { id: 'node/5', name: 'Bad Phone Hospital', nameBn: null, lat: 23.79, lon: 90.39, address: null, area: null, phone: 'n/a' },
  // Unusable rows are skipped, not crashed on.
  { id: 'node/6', name: 'No Position' },
  { name: 'No Id', lat: 23.8, lon: 90.3 },
];
const DATASET = indexHospitals(ROWS);

test('phone numbers are kept only when they look real', () => {
  assert.deepEqual(normalizePhone('+880 2-7791234'), { display: '+880 2-7791234', dial: '+88027791234' });
  assert.deepEqual(normalizePhone('01711-000000; 01811-000000'), { display: '01711-000000', dial: '01711000000' });
  assert.deepEqual(normalizePhone('01969943232/01722450094'), { display: '01969943232', dial: '01969943232' });
  assert.equal(normalizePhone('n/a'), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(undefined), null);
});

test('a hospital mapped twice (point and building) is shown once, keeping details from both copies', async () => {
  const rows = [
    { id: 'node/9575842322', name: 'City Lab diagnostic and specialized consultation center', lat: 23.8160, lon: 90.3310, phone: null, area: 'Savar, Dhaka' },
    { id: 'way/589226576', name: 'City Lab Diagnostic & Specialized Consultation Center.', lat: 23.81601, lon: 90.33099, phone: '01711000000', areaBn: 'সাভার, ঢাকা' },
    // Same name, but 30 km away: a different branch, kept.
    { id: 'node/other', name: 'City Lab diagnostic and specialized consultation center', lat: 24.09, lon: 90.33, phone: null },
    // A Bangla-named copy of the same place, matched through its English name.
    { id: 'node/bn', name: 'সিটি ল্যাব', nameEn: 'City Lab diagnostic and specialized consultation center', nameBn: 'সিটি ল্যাব', lat: 23.8161, lon: 90.3311 },
  ];
  const { hospitals } = indexHospitals(rows);
  assert.equal(hospitals.length, 2);
  const merged = hospitals.find((item) => item.id === 'node/9575842322');
  assert.equal(merged.phoneDial, '01711000000', 'the phone number from the other copy is kept');
  assert.equal(merged.areaBn, 'সাভার, ঢাকা');
  assert.equal(merged.nameBn, 'সিটি ল্যাব');
  const found = await hospitalsAlongRoute(ROAD, { config: CONFIG, dataset: indexHospitals(rows) });
  assert.equal(found.length, 1, 'only one City Lab near the road');
});

test('websites, emails and number sources are kept only when they are real links, and a source only with its number', () => {
  const { hospitals } = indexHospitals([
    { id: 'node/a', name: 'Rajapur Upazila Health Complex', lat: 22.57, lon: 90.13, phone: '01730-324425', phoneSource: 'https://health.rajapur.jhalakathi.gov.bd/pages/static-pages/69789bc435ce18e1c06707e9', website: 'https://health.rajapur.jhalakathi.gov.bd', email: 'rajapur@uhfpo.dghs.gov.bd' },
    { id: 'node/b', name: 'Bad Links', lat: 23.0, lon: 90.0, phone: null, phoneSource: 'https://example.test/', website: 'javascript:alert(1)', email: 'not an email' },
    { id: 'node/c', name: 'Quote Link', lat: 24.0, lon: 90.0, website: 'https://x.test/"><script>' },
  ]);
  const [good, bad, quote] = hospitals;
  assert.equal(good.phoneDial, '01730324425');
  assert.match(good.phoneSource, /^https:\/\/health\.rajapur\.jhalakathi\.gov\.bd\//);
  assert.equal(good.website, 'https://health.rajapur.jhalakathi.gov.bd');
  assert.equal(good.email, 'rajapur@uhfpo.dghs.gov.bd');
  assert.equal(bad.phoneSource, null, 'no number, so no number source');
  assert.equal(bad.website, null, 'only http(s) links');
  assert.equal(bad.email, null);
  assert.equal(quote.website, null, 'a link that could break out of an attribute is dropped');
});

test('the Telegram report links an official website', async () => {
  const { list: text } = await report(async () => [{
    id: 'node/a', name: 'Rajapur Upazila Health Complex', phone: '01730-324425', phoneDial: '01730324425', website: 'https://health.rajapur.jhalakathi.gov.bd', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=22.57,90.13', distanceFromRouteKm: 0.2, alongKm: 3,
  }]);
  assert.match(text, /<a href="tel:01730324425">01730-324425<\/a>/);
  assert.match(text, /<a href="https:\/\/health\.rajapur\.jhalakathi\.gov\.bd">Official website<\/a>/);
});

// A government contact page: its own content is base64 in <rt-renderer>, and the shared hotline widget sits outside it.
const govPage = (content) => `<html><body><nav>০১৯০৮৮৮৮৮৮৮ মাদকদ্রব্য নিয়ন্ত্রণ হটলাইন</nav>
  <rt-renderer encoded-content="${Buffer.from(content).toString('base64')}"></rt-renderer>${content}
  <div class="widget">জরুরি সেবা নম্বরসমূহ ৯৯৯ জরুরি সেবা ০১৯০৮৮৮৮৮৮৮ মাদকদ্রব্য নিয়ন্ত্রণ হটলাইন</div></body></html>`;

test('official numbers are read from the page\'s own contact text, emergency department first, never from the shared hotline list', async () => {
  const { officialNumbers } = await import('../../scripts/lib/official-numbers.mjs');
  assert.deepEqual(officialNumbers(govPage('<p>উপজেলা স্বাস্থ্য কমপ্লেক্স</p><p>Email- nikli@uhfpo.dghs.gov.bd</p><p>টেলিফোন নং-0943256004</p><p>জরুরি বিভাগ - ০১৭৩০৩২৪৫০২</p>')), {
    mobile: '01730324502', landline: '0943256004', email: 'nikli@uhfpo.dghs.gov.bd', emergency: true,
  });
  const rajapur = officialNumbers(govPage('<p>সরকারি টেলিফোন নং - ০৪৯৫৪-৬৫০০৯</p><p>সরকারি মোবাইল নং -০১৭৩০৩২৪৪২৫</p>'));
  assert.equal(rajapur.mobile, '01730324425');
  assert.equal(rajapur.landline, '0495465009');
  assert.equal(rajapur.emergency, false);
  // An unlabelled number in the contact text is still the office's.
  assert.equal(officialNumbers(govPage('<p>উপজেলা স্বাস্থ্য কমপ্লেক্স, ভাণ্ডারিয়া, পিরোজপুর। 01730324431</p>')).mobile, '01730324431');
  // Only an email: no number is made up, and the hotline widget's mobile is never taken.
  assert.deepEqual(officialNumbers(govPage('<p>jhalokathisadar@uhfpo.dghs.gov .bd</p>')), { mobile: null, landline: null, email: 'jhalokathisadar@uhfpo.dghs.gov.bd', emergency: false });
  // A fax number is not a phone number.
  assert.equal(officialNumbers(govPage('<p>ফ্যাক্স: 0432156789</p>')).landline, null);
  // A page without the portal's content block yields nothing rather than guessing from the whole page.
  assert.deepEqual(officialNumbers('<p>মোবাইল 01730324425</p>'), { mobile: null, landline: null, email: null, emergency: false });
});

test('names and place lines follow the page language when OpenStreetMap has them, and are never translated', () => {
  const both = { name: 'Square Hospital', nameEn: 'Square Hospital', nameBn: 'স্কয়ার হাসপাতাল', area: 'Dhanmondi, Dhaka', areaBn: 'ধানমন্ডি, ঢাকা' };
  assert.deepEqual(hospitalLabels(both, 'bn'), { name: 'স্কয়ার হাসপাতাল', area: 'ধানমন্ডি, ঢাকা' });
  assert.deepEqual(hospitalLabels(both, 'en'), { name: 'Square Hospital', area: 'Dhanmondi, Dhaka' });
  const englishOnly = { name: 'Pirozpur General Hospital', nameEn: 'Pirozpur General Hospital', nameBn: null, area: 'Pirojpur Sadar, Pirojpur', areaBn: 'পিরোজপুর সদর, পিরোজপুর' };
  assert.deepEqual(hospitalLabels(englishOnly, 'bn'), { name: 'Pirozpur General Hospital', area: 'পিরোজপুর সদর, পিরোজপুর' }, 'the place line is still Bangla');
  const banglaOnly = { name: 'ঝালকাঠি সদর হাসপাতাল', nameEn: null, nameBn: 'ঝালকাঠি সদর হাসপাতাল', area: 'Jhalokati Sadar, Jhalokati', areaBn: null };
  assert.equal(hospitalLabels(banglaOnly, 'en').name, 'ঝালকাঠি সদর হাসপাতাল');
  assert.deepEqual(hospitalLabels({ name: null }, 'en'), { name: null, area: null });
});

test('the shipped file has a Bangla place line for every hospital and no same-name twins left on one spot', () => {
  const { hospitals } = hospitalsInternals.loadDataset();
  assert.ok(hospitals.every((item) => item.areaBn), 'every place line exists in Bangla');
  const city = hospitals.filter((item) => /City Lab diagnostic/i.test(item.name ?? ''));
  assert.equal(city.length, 1);
});

test('road points cover both ends and every half kilometre', () => {
  const points = hospitalsInternals.roadPoints(ROAD);
  assert.deepEqual(points[0], ROAD[0]);
  assert.deepEqual(points.at(-1), ROAD.at(-1));
  const length = hospitalsInternals.routeLengthKm(ROAD);
  assert.ok(points.length >= Math.floor(length / 0.5), `${points.length} points for ${length.toFixed(1)} km`);
  const long = [[88.1, 26.5], [92.2, 21.5]]; // ~700 km
  assert.ok(hospitalsInternals.roadPoints(long).length <= 2001, 'very long trips stay bounded');
});

test('hospitals along a route are found along the whole road, nearest first, once each, and never invented', async () => {
  const hospitals = await hospitalsAlongRoute(ROAD, { config: CONFIG, dataset: DATASET });
  const ids = hospitals.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('node/1'), 'the hospital half way along the road is found');
  assert.ok(!ids.includes('node/4'), 'a hospital outside the radius is left out');
  assert.ok(!ids.includes('node/6'));
  assert.ok(hospitals.every((item, index) => index === 0 || hospitals[index - 1].alongKm <= item.alongKm), 'in travel order');
  assert.ok(hospitals.every((item) => item.distanceFromRouteKm <= CONFIG.radiusKm));
  assert.ok(hospitals[0].alongKm < 1 && hospitals.at(-1).alongKm > 15, 'from the start of the trip to the end');

  const middle = hospitals.find((item) => item.id === 'node/1');
  assert.ok(middle.distanceFromRouteKm <= 0.3, `measured against the road, not its ends (${middle.distanceFromRouteKm} km)`);
  assert.equal(middle.nameBn, 'মধ্য হাসপাতাল');
  assert.equal(middle.area, 'Savar, Dhaka');
  assert.equal(middle.phoneDial, '+88027791234');
  assert.equal(middle.mapsUrl, 'https://www.google.com/maps/dir/?api=1&destination=23.816000,90.331000');

  const unnamed = hospitals.find((item) => item.id === 'node/2');
  assert.equal(unnamed.name, null, 'a missing name stays missing');
  assert.equal(unnamed.phone, null, 'a missing phone stays missing');
  assert.equal(unnamed.address, null);
  assert.equal(hospitals.find((item) => item.id === 'way/3').phoneDial, '01711000000', 'the first of several numbers');
  assert.equal(middle.searchUrl, 'https://www.google.com/maps/search/?api=1&query=Middle%20Hospital%2C%20Savar%2C%20Dhaka', 'a Google Maps search link by name and place');
  assert.equal(unnamed.searchUrl, null, 'no name, nothing to search for');
  const generic = indexHospitals([
    { id: 'node/g1', name: 'Eye Hospital', lat: 22.67, lon: 90.34 },
    { id: 'node/g2', name: 'চক্ষু হাসপাতাল', lat: 22.68, lon: 90.35 },
    { id: 'node/g3', name: 'Upazila Health Complex', lat: 22.69, lon: 90.36 },
    { id: 'node/g4', name: 'Barisal Eye Hospital', lat: 22.70, lon: 90.37 },
  ]).hospitals;
  assert.deepEqual(generic.map((item) => Boolean(item.searchUrl)), [false, false, false, true], 'a name that is only a kind of hospital gets no search link');
  assert.equal(hospitals.find((item) => item.id === 'node/5').phone, null, 'a phone tag that is not a number is not shown');
});

test('a capped list is spread over the whole trip, not taken from one busy city', async () => {
  // 30 hospitals crowded at the end of the road, one lone hospital near the start.
  const city = Array.from({ length: 30 }, (_, i) => ({ id: `node/c${i}`, name: `City ${i}`, lat: 23.78 + i * 1e-4, lon: 90.41, phone: null }));
  const lone = { id: 'node/lone', name: 'Start Hospital', lat: 23.851, lon: 90.251, phone: null };
  const found = await hospitalsAlongRoute(ROAD, { config: { ...CONFIG, maxResults: 5 }, dataset: indexHospitals([...city, lone]) });
  assert.equal(found.length, 5);
  assert.equal(found[0].id, 'node/lone', 'the start of the trip is covered even though the city has more, nearer hospitals');
});

test('within a stretch of road a named hospital with a phone is preferred', async () => {
  const rows = [
    { id: 'node/a', name: null, lat: 23.8501, lon: 90.2501, phone: null },
    { id: 'node/b', name: 'Named', lat: 23.851, lon: 90.251, phone: null },
    { id: 'node/c', name: 'Named With Phone', lat: 23.852, lon: 90.252, phone: '01711000000' },
  ];
  const [best] = await hospitalsAlongRoute(ROAD, { config: { ...CONFIG, maxResults: 1 }, dataset: indexHospitals(rows) });
  assert.equal(best.id, 'node/c');
});

test('no hospital nearby, switched off and a too-short road are told apart', async () => {
  const empty = indexHospitals([]);
  assert.deepEqual(await hospitalsAlongRoute(ROAD, { config: CONFIG, dataset: empty }), []);
  assert.equal(await hospitalsAlongRoute(ROAD, { config: { ...CONFIG, enabled: false }, dataset: DATASET }), null);
  assert.deepEqual(await hospitalsAlongRoute([ROAD[0]], { config: CONFIG, dataset: DATASET }), []);
  assert.deepEqual(await hospitalsAlongRoute([ROAD[0], ROAD[0]], { config: CONFIG, dataset: DATASET }), []);
});

test('the shipped hospital file loads and finds real hospitals on a Dhaka road, with no network', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('the hospital search must not use the network');
  try {
    const dataset = hospitalsInternals.loadDataset();
    assert.ok(dataset.hospitals.length > 1000, `${dataset.hospitals.length} hospitals in the file`);
    const started = Date.now();
    const found = await hospitalsAlongRoute([[90.4125, 23.7104], [90.4152, 23.7808]], { config: { enabled: true, radiusKm: 5, maxResults: 20 } });
    assert.ok(Date.now() - started < 1000, 'answers well within a second');
    assert.equal(found.length, 20);
    assert.ok(found.every((item) => item.distanceFromRouteKm <= 5));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a long road (over the 10 kB limit used elsewhere) reaches the hospital search; other routes keep their limit', async () => {
  const { app } = await import('../src/app.js');
  const { once } = await import('node:events');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/weather`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // ~3,000 points through central Dhaka: about the size of a real Mongla -> Dhaka road (53 kB) before the client thins it.
    const road = Array.from({ length: 3000 }, (_, i) => [90.41 + (i % 7) * 1e-6, 23.70 + (0.15 * i) / 2999]);
    assert.ok(JSON.stringify({ coordinates: road }).length > 50_000);
    const big = await post('/route/hospitals', { coordinates: road });
    assert.equal(big.status, 200);
    assert.ok((await big.json()).data.hospitals.length > 0, 'hospitals found on the long road');

    const huge = await post('/route/hospitals', { coordinates: road, padding: 'x'.repeat(300_000) });
    assert.equal(huge.status, 413, 'the larger limit is still a limit');

    const elsewhere = await post('/route', { start: { lat: 23.7, lon: 90.4 }, end: { lat: 23.8, lon: 90.4 }, padding: 'x'.repeat(20_000) });
    assert.equal(elsewhere.status, 413, 'the route planner itself keeps the 10 kB limit');
  } finally {
    server.close();
  }
});

// ---------- API ----------
const response = () => ({
  statusCode: 200,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  set(name, value) { this.headers[name] = value; return this; },
  json(body) { this.body = body; return this; },
});

test('hospital API validates coordinates and reports the three outcomes distinctly', async () => {
  const never = routeHospitalsHandler(async () => assert.fail('must not search'));
  for (const body of [{}, { coordinates: [[90, 23]] }, { coordinates: [[90, 23], ['x', 23]] }, { coordinates: 'abc' }]) {
    const res = response();
    await never({ body }, res);
    assert.equal(res.statusCode, 400);
  }

  const found = response();
  await routeHospitalsHandler(async () => [{ id: 'node/1' }])({ body: { coordinates: ROAD } }, found);
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.body.data, { hospitals: [{ id: 'node/1' }] });
  assert.equal(found.headers['Cache-Control'], 'no-store');

  const off = response();
  await routeHospitalsHandler(async () => null)({ body: { coordinates: ROAD } }, off);
  assert.deepEqual(off.body.data, { hospitals: null, disabled: true });

  const down = response();
  await routeHospitalsHandler(async () => { throw new Error('boom'); })({ body: { coordinates: ROAD } }, down);
  assert.equal(down.statusCode, 503);
  assert.match(down.body.message, /unavailable/);
});

// ---------- Telegram ----------
const ROUTE = {
  coordinates: ROAD, distanceKm: 18, durationMinutes: 40, samples: [], summary: {}, alternatives: [], snap: { startKm: 0, endKm: 0 },
};
const FROM = { id: 'a', name: 'Savar', level: 'upazila' };
const TO = { id: 'b', name: 'Dhaka', level: 'district' };
const NOW = Date.parse('2026-10-27T04:00:00Z');

async function report(hospitalsFor, lang = 'en') {
  const built = await buildRouteReport({
    route: ROUTE, from: FROM, to: TO, departMs: NOW, nowMs: NOW, ctx: null, deps: hospitalsFor === undefined ? {} : { hospitalsFor },
  });
  // Every page of the hospital list, as the "See more" button turns them.
  const pages = [];
  if (Array.isArray(built.hospitals)) {
    for (let page = 0; page * HOSPITALS_PER_PAGE < built.hospitals.length; page += 1) {
      pages.push(renderHospitalPage(built, page, { token: 'tok12345', lang, nowMs: NOW }));
    }
  }
  const messages = pages.map((page) => page.text);
  return { built, text: renderRouteReport(built, { lang, nowMs: NOW }), pages, messages, list: messages.join('\n') };
}

const HOSPITALS = [
  { id: 'node/1', name: 'Middle Hospital', nameBn: 'মধ্য হাসপাতাল', phone: '+880 2-7791234', phoneDial: '+88027791234', mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=23.816,90.331', distanceFromRouteKm: 0.1 },
  { id: 'node/2', name: null, nameBn: null, phone: null, phoneDial: null, mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=23.852,90.255', distanceFromRouteKm: 0.6 },
  ...[3, 4, 5].map((n) => ({ id: `node/${n}`, name: `H${n}`, nameBn: null, phone: null, phoneDial: null, mapsUrl: 'https://example.test/', searchUrl: n === 4 ? 'https://www.google.com/maps/search/?api=1&query=Clinic%20Two' : null, distanceFromRouteKm: n })),
];

test('the Telegram route report lists hospitals with tappable call and map links', async () => {
  const { text, list, messages } = await report(async () => HOSPITALS);
  assert.match(text, /Hospitals along the way/);
  assert.match(text, /5 hospitals near this road \(1 with a phone number\)/);
  assert.match(list, /<a href="tel:\+88027791234">\+880 2-7791234<\/a>/);
  assert.match(list, /<a href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=23\.816,90\.331">Map<\/a>/, 'the & is escaped for Telegram HTML');
  assert.match(list, /Name not available/);
  assert.match(list, /Contact not available/);
  assert.match(list, /Contact not available \(<a href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=Clinic%20Two">see on Google Maps<\/a>\)/);
  assert.doesNotMatch(list, /\+880 2-7791234<\/a> \(/, 'a hospital with its own number gets no Google link');
  assert.equal(list.match(/^• /gm).length, HOSPITALS.length, 'every hospital is listed, as on the website');
  assert.match(list, /not verified for opening hours or emergency capacity/);
  for (const message of messages) {
    assert.ok(message.length <= 3800);
    assert.deepEqual(lintText(toPlain(message)), []);
  }
});

test('Telegram pages through every hospital the website shows, in travel order, with See more and Back buttons', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `node/t${i}`, name: `Trip Hospital ${i}`, area: 'Savar, Dhaka', phone: '+880 2-7791234', phoneDial: '+88027791234', mapsUrl: 'https://example.test/', distanceFromRouteKm: 1, alongKm: i * 10,
  }));
  const { list, pages } = await report(async () => many);
  const shown = [...list.matchAll(/Trip Hospital (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(shown, many.map((_, i) => i), 'every hospital, once, over the pages');
  assert.equal(pages.length, 3);
  assert.match(pages[0].text, /1–5 of 12/);
  assert.deepEqual(pages[0].buttons, [[{ text: 'See more (7) ▸', data: 'hp:tok12345:1:en' }]]);
  assert.deepEqual(pages[1].buttons[0].map((button) => button.data), ['hp:tok12345:0:en', 'hp:tok12345:2:en']);
  assert.match(pages[2].text, /11–12 of 12/);
  assert.deepEqual(pages[2].buttons, [[{ text: '◂ Back', data: 'hp:tok12345:1:en' }]]);
  for (const page of pages) assert.ok(page.text.length <= 3800);
  assert.match(renderHospitalPage({ from: FROM, to: TO, hospitals: many }, 99, { token: 'tok12345', lang: 'en', nowMs: NOW }).text, /11–12 of 12/, 'a page past the end shows the last one');
});

test('the Telegram bot searches the same compacted road as the website, so both list the same hospitals', async () => {
  const road = Array.from({ length: 400 }, (_, i) => [90.25 + i * 0.0002, 23.85 - i * 0.0001]);
  const compact = compactRoute(road);
  assert.ok(compact.length < road.length);
  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
  assert.ok(near(compact[0], road[0]) && near(compact.at(-1), road.at(-1)), 'both ends are kept');
  assert.deepEqual(await hospitalsFor(road), await hospitalsAlongRoute(compact));
});

test('the Telegram hospital section is in Bangla too', async () => {
  const { text, list } = await report(async () => HOSPITALS, 'bn');
  assert.match(text, /পথে হাসপাতাল/);
  assert.match(list, /মধ্য হাসপাতাল/);
  assert.match(list, /যোগাযোগের নম্বর নেই/);
});

test('a failed hospital search still produces the route, saying the search is unavailable', async () => {
  const { built, text } = await report(async () => { throw new Error('overpass down'); });
  assert.equal(built.hospitals, null);
  assert.match(text, /Hospital search is unavailable right now/);
  assert.doesNotMatch(text, /No mapped hospital found/);
  assert.match(text, /Savar → Dhaka/);
});

test('no hospitals found, switched off, and not wired are worded differently', async () => {
  assert.match((await report(async () => [])).text, /No mapped hospital found near this road/);
  const off = await report(async () => null);
  assert.equal(off.built.hospitals, undefined);
  assert.doesNotMatch(off.text, /Hospital/);
  assert.doesNotMatch((await report(undefined)).text, /Hospital/, 'older callers without the lookup are unchanged');
});
