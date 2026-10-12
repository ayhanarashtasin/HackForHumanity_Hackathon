import { env } from '../../../config/env.js';
import { allStatuses } from '../../weatherStore.js';
import { defaultDeps } from './data.js';
import { findPlaces, placeById, placesForAreas } from './places.js';
import { forecastFor } from './readings.js';
import {
  COMMAND_NAMES, buttonsFor, renderAlerts, renderAmbiguous, renderAskPlace, renderForecast, renderHeat, renderLightning, renderNotFound, renderRain,
  renderRoute, renderRoutePlaceError, renderRoutePrompt, renderStatus, renderThunderstorm, renderUpdate, renderWind,
} from './text.js';

// The bot's weather commands: parse the message, find the person's language and place, read the stored forecast, word the reply.
// A command never calls a weather provider, never stores anything about the person and never puts profile answers (work, crop, shift)
// into a reply: the only profile fact used is the saved area, and only to choose where to look.
export const REPORT_COMMANDS = new Set(['update', 'heat', 'rain', 'wind', 'thunderstorm', 'lightning', 'forecast', 'route']);
export const ALL_COMMANDS = new Set(COMMAND_NAMES);
const ALIASES = new Map([['weather', 'update'], ['thunder', 'thunderstorm'], ['storm', 'thunderstorm'], ['days', 'forecast']]);

function splitRouteQuery(query) {
  const match = String(query).match(/\s+(?:to|theke|থেকে|->|→)\s+/i);
  if (!match) return null;
  const index = match.index;
  const start = query.slice(0, index).trim();
  const end = query.slice(index + match[0].length).trim();
  return start && end ? { start, end } : null;
}

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
    // -> { allowed, announce }: announce is true once per window, so the "slow down" reply is not itself a flood.
    hit(key, nowMs = Date.now()) {
      let entry = entries.get(key);
      if (!entry || nowMs - entry.start >= windowMs) {
        entry = { start: nowMs, count: 0, warned: false };
        entries.set(key, entry);
        if (entries.size > 5000) for (const [other, value] of entries) if (nowMs - value.start >= windowMs) entries.delete(other);
      }
      entry.count += 1;
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
    case 'forecast': return renderForecast;
    default: return renderUpdate;
  }
}

// -> { messages: [{ text, buttons? }], action, lang }. `placeId` (from a button) replaces the typed place.
export async function answerCommand({
  command, rest = [], placeId = null, langOverride = null, chatId, languageCode = null, nowMs = Date.now(), deps = defaultDeps,
}) {
  const subscriber = await deps.subscriberForChat(chatId, new Date(nowMs));
  const parsed = parseArgs(rest);
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
    const routeQuery = splitRouteQuery(parsed.query);
    if (!routeQuery) return { messages: [{ text: renderRoutePrompt(lang) }], action: 'ask-route', lang };
    const from = findPlaces(routeQuery.start);
    if (from.matches.length !== 1) return { messages: [{ text: renderRoutePlaceError(lang, routeQuery.start, from.matches) }], action: from.matches.length ? 'ambiguous-start' : 'not-found-start', lang };
    const to = findPlaces(routeQuery.end);
    if (to.matches.length !== 1) return { messages: [{ text: renderRoutePlaceError(lang, routeQuery.end, to.matches) }], action: to.matches.length ? 'ambiguous-end' : 'not-found-end', lang };
    try {
      const route = await deps.routeWeather({ start: from.matches[0], end: to.matches[0], nowMs });
      return { messages: [{ text: renderRoute(route, { lang, nowMs }) }], action: 'route', lang };
    } catch (error) {
      const text = /No road route|Route service/.test(error?.message)
        ? error.message
        : renderRoutePrompt(lang);
      return { messages: [{ text }], action: 'route-error', lang };
    }
  }

  let places;
  if (placeId) {
    const place = placeById(placeId);
    places = place ? [place] : [];
  } else if (parsed.query) {
    const { matches, total } = findPlaces(parsed.query);
    if (!matches.length) return { messages: [{ text: renderNotFound(lang, parsed.query) }], action: 'not-found', lang };
    if (matches.length > 1) return { messages: [{ text: renderAmbiguous(lang, matches, total, command) }], action: 'ambiguous', lang };
    places = matches;
  } else {
    places = subscriber ? placesForAreas(subscriber.areas, 2) : [];
  }
  if (!places.length) return { messages: [{ text: renderAskPlace(lang) }], action: 'ask-place', lang };

  const ctx = deps.loadForecast({ now: nowMs });
  const render = pickRenderer(command);
  let alertCount = null;
  if (command === 'update' && subscriber) {
    alertCount = await deps.alertsFor(subscriber, nowMs).then((result) => result.items.length).catch(() => null);
  }

  const messages = [];
  for (const place of places) {
    const forecast = forecastFor(place, ctx);
    let lightning;
    if (command === 'update' || command === 'lightning') lightning = await deps.lightningFor(place, { nowMs }).catch(() => ({ pick: null, error: true }));
    const text = command === 'lightning'
      ? renderLightning(forecast, { lang, nowMs, lightning, place })
      : render(forecast, { lang, nowMs, lightning, alertCount });
    messages.push({ text });
  }
  if (command === 'update') messages[0].buttons = buttonsFor(places[0], lang);
  return { messages, action: command, lang };
}
