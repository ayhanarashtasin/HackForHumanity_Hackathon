import { addDays, dhakaDate } from '../../time.js';
import { normalize } from './places.js';
import { forecastFor } from './readings.js';
import {
  findRoutePlaces, hereEntry, pointEntry, routePlaceById, weatherPlaceOf,
} from './routePlaces.js';
import { keepHospitalList } from './hospitalLists.js';
import { buildRouteReport } from './routeReport.js';
import {
  candidateRouteButtons, hospitalsButton, renderRouteAsk, renderRouteAskEnd, renderRouteAskStart, renderRouteFailure, renderRouteProblem,
  renderRouteReport, renderRouteUnclear, routeButtons,
} from './routeText.js';
import { makeText, renderUpdate } from './text.js';

// /route: from what was typed (or a pressed button, or a shared location) to a road trip with its weather. "Dhaka Bandarban" needs no
// "to": every split of the words is tried and the one whose two halves name places best wins. A name the lists do not know goes to the
// OpenStreetMap search (deps.geocode), then to "did you mean". A missing end is asked for, and the answer (a name or a shared location)
// arrives as `routeToId` / `routeFromId` / `routeFromPoint` (telegramBot.js keeps the question for a few minutes).
const HOUR = 3_600_000;
const MAX_WORDS = 12;
const SEPARATOR = /\s+(?:to|theke|থেকে|হতে|->|=>|→|-|–|—)\s+/iu;
const TRAILING_SEPARATOR = /\s+(?:to|theke|থেকে|হতে)$/iu;
const LEADING_TO = /^to\s+/i;
const HERE_WORDS = new Set(['here', 'my location', 'current location', 'my position', 'amar location', 'আমার অবস্থান', 'আমার লোকেশন', 'এখান', 'এখানে']);
const HERE = Symbol('here');
const isHere = (text) => HERE_WORDS.has(normalize(text));

// -> { kind: empty | here | single (destination only) | from-only | pair | words, ... }
export function parseRouteText(text) {
  let body = String(text ?? '').trim().replace(/^(?:from|frm)\s+/i, '').replace(/\s+পর্যন্ত$/u, '').trim();
  if (!body) return { kind: 'empty' };
  if (isHere(body)) return { kind: 'here' };
  if (TRAILING_SEPARATOR.test(body)) return { kind: 'from-only', text: body.replace(TRAILING_SEPARATOR, '').trim() };
  if (LEADING_TO.test(body)) return { kind: 'single', text: body.replace(LEADING_TO, '').trim() };
  const match = SEPARATOR.exec(body);
  if (match) {
    const from = body.slice(0, match.index).trim();
    const to = body.slice(match.index + match[0].length).trim();
    if (from && to) return { kind: 'pair', from: isHere(from) ? HERE : from, to: isHere(to) ? HERE : to };
  }
  body = body.split(/\s+/).slice(0, MAX_WORDS).join(' ');
  const words = body.split(' ');
  for (const count of [2, 1]) {
    if (words.length > count && isHere(words.slice(0, count).join(' '))) return { kind: 'pair', from: HERE, to: words.slice(count).join(' ') };
  }
  return words.length === 1 ? { kind: 'single', text: body } : { kind: 'words', words };
}

const score = (result) => (result.tier - 1) * 2 + (result.matches.length > 1 ? 1 : 0) + (result.retried ? 1 : 0);

// "Dhaka Bandarban" -> { kind: 'pair', from: 'Dhaka', to: 'Bandarban' }. A whole text that is one place's exact name ("Cox's Bazar",
// "Mirpur 10") is a destination, not a trip. Two splits that name different trips equally well are 'unclear'.
export function splitWords(words) {
  const text = words.join(' ');
  const whole = findRoutePlaces(text);
  if (whole.tier === 1 && !whole.retried) return { kind: 'single', text };
  const options = [];
  for (let k = 1; k < words.length; k += 1) {
    const from = words.slice(0, k).join(' ');
    const to = words.slice(k).join(' ');
    options.push({ from, to, a: findRoutePlaces(from), b: findRoutePlaces(to) });
  }
  const both = options.filter((option) => option.a.matches.length && option.b.matches.length);
  if (both.length) {
    const best = Math.min(...both.map((option) => score(option.a) + score(option.b)));
    const top = both.filter((option) => score(option.a) + score(option.b) === best);
    if (new Set(top.map((option) => `${option.a.matches[0].id}>${option.b.matches[0].id}`)).size > 1) return { kind: 'unclear' };
    return { kind: 'pair', from: top[0].from, to: top[0].to };
  }
  // One end in the lists, the other not (a village, a landmark): the unknown end goes to the map search.
  const one = options.filter((option) => Boolean(option.a.matches.length) !== Boolean(option.b.matches.length));
  if (one.length) {
    const known = (option) => (option.a.matches.length ? option.a : option.b);
    one.sort((x, y) => score(known(x)) - score(known(y)));
    return { kind: 'pair', from: one[0].from, to: one[0].to };
  }
  return words.length === 2 ? { kind: 'pair', from: words[0], to: words[1] } : { kind: 'unclear' };
}

// -> { status: 'ok', place } or a problem { side, status: ambiguous | suggest | none, query, candidates, total, hidden }.
async function resolveSide(text, side, geocode, state) {
  const local = findRoutePlaces(text);
  if (local.matches.length === 1) return { side, status: 'ok', place: local.matches[0] };
  if (local.matches.length > 1) {
    return {
      side, status: 'ambiguous', query: text, candidates: local.matches, total: local.total, hidden: local.hidden,
    };
  }
  if (geocode) {
    try {
      const found = (await geocode(text)).map((row) => pointEntry(row)).find(Boolean);
      if (found) return { side, status: 'ok', place: found };
    } catch {
      state.searchDown = true;
    }
  }
  const near = findRoutePlaces(text, { near: true });
  if (near.matches.length) {
    return {
      side, status: 'suggest', query: text, candidates: near.matches, total: near.total,
    };
  }
  return { side, status: 'none', query: text };
}

// 0 = now, 3 = in three hours, m = tomorrow 07:00 Bangladesh time.
export function departureTime(departure, nowMs) {
  if (departure === '3') return nowMs + 3 * HOUR;
  if (departure === 'm') return Date.parse(`${addDays(dhakaDate(new Date(nowMs)), 1)}T07:00:00+06:00`);
  return nowMs;
}

const reply = (lang, action, message, extra = {}) => ({ messages: [message], action, lang, ...extra });

async function planRoute({
  from, to, departure = '0', lang, nowMs, deps,
}) {
  if (!from.here && from.id === to.id) return reply(lang, 'route-same', { text: renderRouteFailure(lang, 'ROUTE_SAME', { from, to }) });
  const departMs = departureTime(departure, nowMs);
  const ctx = deps.loadForecast({ now: nowMs });
  let route;
  try {
    route = await deps.routeWeather({
      start: { name: from.name, lat: from.lat, lon: from.lon }, end: { name: to.name, lat: to.lat, lon: to.lon }, nowMs: departMs, forecast: ctx,
    });
  } catch (error) {
    const code = ['ROUTE_NO_ROAD', 'ROUTE_SAME', 'ROUTE_POINTS'].includes(error?.code) ? error.code : 'ROUTE_SERVICE';
    const messages = [{ text: renderRouteFailure(lang, code, { from, to }) }];
    // No road (an island, say): the destination's weather is still worth having.
    const place = code === 'ROUTE_NO_ROAD' ? weatherPlaceOf(to) : null;
    if (place) messages.push({ text: renderUpdate(forecastFor(place, ctx), { lang, nowMs }) });
    return { messages, action: code === 'ROUTE_SERVICE' ? 'route-error' : `route-${code.slice(6).toLowerCase().replace('_', '-')}`, lang };
  }
  const report = await buildRouteReport({
    route, from, to, departure, departMs, nowMs, ctx, deps,
  });
  // One message: the report with its departure buttons, and a "🏥 Hospitals" button that opens the list (kept for its page buttons).
  const buttons = routeButtons({ fromId: from.id, toId: to.id, departure }, lang);
  if (Array.isArray(report.hospitals) && report.hospitals.length) {
    buttons.unshift(hospitalsButton(keepHospitalList(report, nowMs), report.hospitals.length, lang));
  }
  return reply(lang, 'route', { text: renderRouteReport(report, { lang, nowMs }), buttons });
}

function problemReply(lang, problems, { known = null, searchDown = false, texts = {} } = {}) {
  const withButtons = Boolean(known) && problems.length === 1 && problems[0].candidates?.length > 0;
  return reply(lang, problems.some((problem) => problem.status === 'ambiguous') ? 'route-ambiguous' : 'route-not-found', {
    text: renderRouteProblem(lang, problems, { withButtons, searchDown, texts }),
    ...(withButtons ? { buttons: candidateRouteButtons(problems[0], known.id, lang) } : {}),
  });
}

// -> { messages, action, lang, remember? }: `remember` ({ routeTo } or { routeFrom }) is what the bot keeps while it waits for the other end.
export async function answerRoute({
  query = '', routeIds = null, departure = '0', routeFromPoint = null, routeToId = null, routeFromId = null, lang, nowMs, deps,
}) {
  const T = makeText(lang, nowMs);

  // A pressed route button: both ends are ids.
  if (routeIds) {
    const from = routePlaceById(routeIds.from);
    const to = routePlaceById(routeIds.to);
    if (!from || !to) return reply(lang, 'route-expired', { text: renderRouteFailure(lang, 'EXPIRED') });
    return planRoute({
      from, to, departure, lang, nowMs, deps,
    });
  }

  // A shared location as the start. The exact point is used for this one road search and then dropped.
  if (routeFromPoint) {
    const from = hereEntry(routeFromPoint.lat, routeFromPoint.lon);
    if (!from) return reply(lang, 'route-points', { text: renderRouteFailure(lang, 'ROUTE_POINTS'), removeKeyboard: true });
    const to = routeToId ? routePlaceById(routeToId) : null;
    if (!to) return reply(lang, 'ask-route-end', { text: renderRouteAskEnd(lang, from), removeKeyboard: true }, { remember: { routeFrom: from.id } });
    const result = await planRoute({
      from, to, lang, nowMs, deps,
    });
    result.messages.push({
      text: T.s('Your location was used only for this route and was not saved.', 'আপনার অবস্থান শুধু এই পথের জন্য ব্যবহার হয়েছে; সংরক্ষণ করা হয়নি।'),
      removeKeyboard: true,
    });
    return result;
  }

  const geocode = deps.geocode ?? null;
  const state = { searchDown: false };
  const parsed = parseRouteText(query);

  // The answer to "where do you start?" or "where are you going?": the whole text names the missing end (a full new trip also works).
  const pending = routeToId ?? routeFromId;
  if (pending && ['single', 'words'].includes(parsed.kind)) {
    const known = routePlaceById(pending);
    if (known) {
      const side = routeToId ? 'from' : 'to';
      const found = await resolveSide(query, side, geocode, state);
      if (found.status !== 'ok') return problemReply(lang, [found], { known, searchDown: state.searchDown, texts: { [side]: query } });
      return planRoute({
        from: side === 'from' ? found.place : known, to: side === 'to' ? found.place : known, lang, nowMs, deps,
      });
    }
  }

  let trip = parsed;
  if (trip.kind === 'words') trip = splitWords(trip.words);
  switch (trip.kind) {
    case 'empty':
      return reply(lang, 'ask-route', { text: renderRouteAsk(lang) });
    case 'here':
      return reply(lang, 'ask-route', { text: renderRouteAsk(lang), requestLocation: true });
    case 'unclear':
      return reply(lang, 'route-unclear', { text: renderRouteUnclear(lang) });
    case 'from-only': {
      const found = await resolveSide(trip.text, 'from', geocode, state);
      if (found.status !== 'ok') return problemReply(lang, [found], { searchDown: state.searchDown, texts: { from: trip.text } });
      return reply(lang, 'ask-route-end', { text: renderRouteAskEnd(lang, found.place) }, { remember: { routeFrom: found.place.id } });
    }
    case 'single': {
      const found = await resolveSide(trip.text, 'to', geocode, state);
      if (found.status !== 'ok') return problemReply(lang, [found], { searchDown: state.searchDown, texts: { to: trip.text } });
      return reply(lang, 'ask-route-start', { text: renderRouteAskStart(lang, found.place), requestLocation: true }, { remember: { routeTo: found.place.id } });
    }
    default:
      break;
  }

  if (trip.from === HERE) {
    if (trip.to === HERE) return reply(lang, 'ask-route', { text: renderRouteAsk(lang) });
    const found = await resolveSide(trip.to, 'to', geocode, state);
    if (found.status !== 'ok') return problemReply(lang, [found], { searchDown: state.searchDown, texts: { to: trip.to } });
    return reply(lang, 'ask-route-start', { text: renderRouteAskStart(lang, found.place), requestLocation: true }, { remember: { routeTo: found.place.id } });
  }
  if (trip.to === HERE) return reply(lang, 'ask-route', { text: renderRouteAsk(lang) });

  const [from, to] = await Promise.all([resolveSide(trip.from, 'from', geocode, state), resolveSide(trip.to, 'to', geocode, state)]);
  const problems = [from, to].filter((side) => side.status !== 'ok');
  if (problems.length) {
    const known = problems.length === 1 ? (problems[0].side === 'from' ? to.place : from.place) : null;
    return problemReply(lang, problems, { known, searchDown: state.searchDown, texts: { from: trip.from, to: trip.to } });
  }
  return planRoute({
    from: from.place, to: to.place, lang, nowMs, deps,
  });
}
