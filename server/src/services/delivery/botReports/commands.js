import { env } from '../../../config/env.js';
import { allStatuses } from '../../weatherStore.js';
import { defaultDeps } from './data.js';
import { findPlaces, placeById, placesForAreas } from './places.js';
import { forecastFor } from './readings.js';
import { answerRoute } from './routeCommand.js';
import {
  COMMAND_NAMES, buttonsFor, candidateButtons, renderAlerts, renderAmbiguous, renderAskPlace, renderFlood, renderFloodSafety, renderForecast, renderHeat, renderHospitalReport, renderLightning, renderNotFound, renderRain,
  renderStatus, renderThunderstorm, renderUpdate, renderWind,
} from './text.js';

// The bot's weather commands: parse the message, find the person's language and place, read the stored forecast, word the reply.
// A command never calls a weather provider, never stores anything about the person and never puts profile answers (work, crop, shift)
// into a reply: only the fresh current area (if any), else the saved areas, chooses where to look. /route (routeCommand.js) is the one
// exception to "never calls out": it asks the road-route service and, for a name the bot does not know, the OpenStreetMap place search.
// Commands whose report buttons carry one place ("r:<command>:<place id>:<language>"); /route has buttons of its own.
export const REPORT_COMMANDS = new Set(['update', 'heat', 'rain', 'wind', 'thunderstorm', 'lightning', 'flood', 'flood_safety', 'hospital', 'forecast']);
export const ALL_COMMANDS = new Set(COMMAND_NAMES);
const ALIASES = new Map([
  ['weather', 'update'], ['thunder', 'thunderstorm'], ['storm', 'thunderstorm'], ['days', 'forecast'], ['trip', 'route'], ['travel', 'route'], ['river', 'flood'],
  ['hospitals', 'hospital'], ['clinic', 'hospital'],
]);

// "/heat@AkshSathiBot" -> "heat"; aliases are folded in; anything that is not a weather command gives null.
export function canonicalCommand(word) {
  const name = String(word ?? '').replace(/^\//, '').split('@')[0].toLowerCase();
  const folded = ALIASES.get(name) ?? name;
  return ALL_COMMANDS.has(folded) ? folded : null;
}

// ["Savar,", "Dhaka", "bn"] -> { query: "Savar, Dhaka", override: "bn" }. A trailing bn/en picks the language of the reply.
export function parseArgs(rest = []) {
  const words = [...rest];
  let override = null;
  if (words.length && ['bn', 'en'].includes(words.at(-1).toLowerCase())) override = words.pop().toLowerCase();
  return { query: words.join(' ').trim(), override };
}

// A typed bn/en, else a linked profile's language, else Bangla when the place was typed in Bangla script, else the person's Telegram
// language (Bangla if it is bn), else English.
const BANGLA_SCRIPT = /[ঀ-৿]/;
export function resolveLanguage({
  override = null, subscriber = null, languageCode = null, query = '',
} = {}) {
  if (override === 'bn' || override === 'en') return override;
  if (subscriber?.language === 'bn' || subscriber?.language === 'en') return subscriber.language;
  if (BANGLA_SCRIPT.test(String(query))) return 'bn';
  return /^bn\b/i.test(String(languageCode ?? '')) ? 'bn' : 'en';
}

// ---------- a request limit per chat, kept in memory (nothing about the person is stored) ----------
export function createRateLimiter({ max = () => env.channels.telegram.commandLimit, windowMs = 10 * 60_000 } = {}) {
  const entries = new Map();
  const limit = () => (typeof max === 'function' ? max() : max);
  return {
    // -> { allowed, announce }: announce is true once per window, so the "slow down" reply is not itself a flood. A request may weigh
    // more than one (a /route search asks the road service up to three times).
    hit(key, nowMs = Date.now(), weight = 1) {
      let entry = entries.get(key);
      if (!entry || nowMs - entry.start >= windowMs) {
        entry = { start: nowMs, count: 0, warned: false };
        entries.set(key, entry);
        if (entries.size > 5000) for (const [other, value] of entries) if (nowMs - value.start >= windowMs) entries.delete(other);
      }
      entry.count += weight;
      if (entry.count <= limit()) return { allowed: true, announce: false };
      const announce = !entry.warned;
      entry.warned = true;
      return { allowed: false, announce };
    },
    reset() {
      entries.clear();
    },
  };
}

// ---------- the answer to one command ----------
function pickRenderer(command) {
  switch (command) {
    case 'heat': return renderHeat;
    case 'rain': return renderRain;
    case 'wind': return renderWind;
    case 'thunderstorm': return renderThunderstorm;
    case 'flood': return renderFlood;
    case 'hospital': return renderHospitalReport;
    case 'forecast': return renderForecast;
    default: return renderUpdate;
  }
}

// -> { messages: [{ text, buttons? }], action, lang, remember? }. `placeId` (from a button) replaces the typed place. The route* fields
// are /route's: a pressed route button (routeIds, departure), a shared location as the start (routeFromPoint) and the end the bot already
// knows while it waits for the other one (routeToId, routeFromId).
export async function answerCommand({
  command, rest = [], placeId = null, langOverride = null, chatId, languageCode = null, sharedPlace = false, sharedPoint = null, nowMs = Date.now(), deps = defaultDeps,
  routeIds = null, departure = '0', routeFromPoint = null, routeToId = null, routeFromId = null,
}) {
  const subscriber = await deps.subscriberForChat(chatId, new Date(nowMs));
  const parsed = parseArgs(rest);
  if (command === 'flood' && /^safety(?:\s|$)/i.test(parsed.query)) {
    command = 'flood_safety';
    parsed.query = parsed.query.replace(/^safety(?:\s|$)/i, '').trim();
  }
  const lang = resolveLanguage({
    override: langOverride ?? parsed.override, subscriber, languageCode, query: parsed.query,
  });

  if (command === 'alerts') {
    const items = subscriber ? (await deps.alertsFor(subscriber, nowMs)).items : [];
    return { messages: [{ text: renderAlerts({ lang, nowMs, linked: Boolean(subscriber), items }) }], action: 'alerts', lang };
  }
  if (command === 'status') {
    const engine = await deps.engineStatus();
    return { messages: [{ text: renderStatus({ lang, nowMs, statuses: (deps.statuses ?? allStatuses)(nowMs), engine }) }], action: 'status', lang };
  }

  if (command === 'route') {
    return answerRoute({
      query: parsed.query, routeIds, departure, routeFromPoint, routeToId, routeFromId, lang, nowMs, deps,
    });
  }

  let places;
  if (placeId) {
    const place = placeById(placeId);
    places = place ? [place] : [];
  } else if (parsed.query) {
    const { matches, total } = findPlaces(parsed.query);
    if (!matches.length) return { messages: [{ text: renderNotFound(lang, parsed.query) }], action: 'not-found', lang, remember: { command } };
    if (matches.length > 1) return { messages: [{ text: renderAmbiguous(lang, matches, total, command), buttons: candidateButtons(matches, command, lang) }], action: 'ambiguous', lang, remember: { command } };
    places = matches;
  } else {
    const current = subscriber?.currentArea?.expiresAt && +new Date(subscriber.currentArea.expiresAt) > nowMs
      ? placeById(subscriber.currentArea.upazilaPcode) : null;
    places = current ? [current] : (subscriber ? placesForAreas(subscriber.areas, command === 'flood_safety' ? 1 : 2) : []);
  }
  // The bot remembers this question for a few minutes (telegramBot.js), so a typed place name or a shared location answers it.
  if (!places.length) return { messages: [{ text: renderAskPlace(lang), requestLocation: true }], action: 'ask-place', lang, remember: { command } };

  const ctx = command === 'flood_safety' ? null : deps.loadForecast({ now: nowMs });
  const render = pickRenderer(command);
  let alertCount = null;
  if (command === 'update' && subscriber) {
    alertCount = await deps.alertsFor(subscriber, nowMs).then((result) => result.items.length).catch(() => null);
  }

  const messages = [];
  for (const place of places) {
    if (command === 'flood_safety') {
      const reference = sharedPoint ? { ...place, lat: sharedPoint.lat, lon: sharedPoint.lon } : place;
      const shelters = deps.schoolSheltersFor
        ? await deps.schoolSheltersFor(reference, { nowMs }).catch(() => ({ status: 'UNAVAILABLE' }))
        : { status: 'UNAVAILABLE' };
      messages.push({ text: renderFloodSafety(place, { lang, nowMs, shelters, sharedPoint: Boolean(sharedPoint) }) });
      continue;
    }
    const forecast = forecastFor(place, ctx);
    let lightning;
    if (command === 'update' || command === 'lightning') lightning = await deps.lightningFor(place, { nowMs }).catch(() => ({ pick: null, error: true }));
    // The satellite storm tracker's "right now" for /thunderstorm.
    let storm;
    if (command === 'thunderstorm' && deps.stormFor) storm = await deps.stormFor(place, { nowMs }).catch(() => ({ status: 'UNAVAILABLE', hit: null }));
    let flood;
    if (command === 'flood' && deps.floodFor) flood = await deps.floodFor(place, { nowMs }).catch(() => ({ status: 'UNAVAILABLE', error: true }));
    let hospitalsList;
    if (command === 'hospital' && deps.nearestHospitalsForPlace) {
      hospitalsList = await deps.nearestHospitalsForPlace(place, { limit: 3 }).catch(() => []);
    }
    const text = command === 'lightning'
      ? renderLightning(forecast, { lang, nowMs, lightning, place })
      : command === 'flood'
        ? renderFlood(forecast, { lang, nowMs, flood, place })
        : command === 'hospital'
          ? renderHospitalReport(place, { lang, nowMs, hospitals: hospitalsList })
          : render(forecast, { lang, nowMs, lightning, alertCount, storm });
    const message = { text };
    if (command === 'flood') message.buttons = [[{
      text: lang === 'bn' ? '🏫 নিকটবর্তী স্কুল আশ্রয়কেন্দ্র' : '🏫 Nearby school shelters', data: `r:flood_safety:${place.id}:${lang}`,
    }]];
    messages.push(message);
  }
  if (command === 'update') messages[0].buttons = buttonsFor(places[0], lang);
  if (command === 'update' && !placeId && !parsed.query) {
    const current = subscriber?.currentArea?.expiresAt && +new Date(subscriber.currentArea.expiresAt) > nowMs;
    messages[0].text = `${current
      ? (lang === 'bn' ? '📍 আপনার সাম্প্রতিক অবস্থানের এলাকা (নতুন GPS পাঠানো হয়নি)।' : '📍 Your recently shared area (not a new GPS reading).')
      : (lang === 'bn' ? '📍 সংরক্ষিত এলাকা।' : '📍 Saved area.')}
\n${messages[0].text}`;
    if (!current) messages.push({ text: lang === 'bn' ? 'বর্তমান আবহাওয়ার জন্য অবস্থান পাঠান। এতে স্বয়ংক্রিয় অবস্থান অনুসরণ চালু হবে না।' : 'Share your location for current-area weather. This does not turn on live tracking.', requestLocation: true });
  }
  if (sharedPlace) {
    const heading = command === 'flood_safety'
      ? (lang === 'bn' ? '📍 আপনি এখন যে অবস্থান পাঠিয়েছেন তার কাছের স্কুল আশ্রয়কেন্দ্র।' : '📍 School shelters near the location you just shared.')
      : (lang === 'bn' ? '📍 আপনি এখন যে অবস্থান পাঠিয়েছেন তার নিকটতম পূর্বাভাস এলাকার তথ্য।' : '📍 Forecast for the nearest available area to the location you just shared.');
    messages[0].text = `${heading}\n${messages[0].text}`;
    messages.push({ text: sharedPlace === 'live'
      ? (lang === 'bn' ? 'লাইভ অবস্থান অনুসরণ চালু আছে। থামাতে /unfollow পাঠান বা Telegram-এ শেয়ারিং বন্ধ করুন।' : 'Live location following is on. Send /unfollow or stop sharing in Telegram to end it.')
      : (lang === 'bn' ? 'এই অবস্থান শুধু এই প্রতিবেদনের জন্য ব্যবহৃত হয়েছে; সতর্কবার্তা অনুসরণ চালু হয়নি।' : 'This location was used only for this report; alert following was not enabled.'), removeKeyboard: true });
  }
  return { messages, action: command, lang };
}
