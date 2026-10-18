import { env } from '../config/env.js';

// OpenStreetMap Nominatim place search for the Telegram /route command, used only for a name the bot's own place lists do not know.
// Nominatim's usage policy: at most one request per second, an identifying User-Agent, results cached, and OpenStreetMap credited (the route
// reply does). Only the typed name is sent; results outside Bangladesh are dropped.
const CACHE_MS = 24 * 3_600_000;
const MAX_CACHE = 500;
const GAP_MS = 1100;
const BD = { minLat: 20.3, maxLat: 26.9, minLon: 87.5, maxLon: 93.2 };

const cache = new Map();
let nextSlotMs = 0;

// One request at a time, a little more than a second apart, across every chat. Injected fetches (tests) do not wait.
async function waitTurn(fetchImpl) {
  if (fetchImpl !== globalThis.fetch) return;
  const now = Date.now();
  const wait = Math.max(0, nextSlotMs - now);
  nextSlotMs = Math.max(now, nextSlotMs) + GAP_MS;
  if (wait) await new Promise((resolve) => { setTimeout(resolve, wait); });
}

const searchError = () => Object.assign(new Error('Place search is unavailable.'), { code: 'GEOCODER_UNAVAILABLE' });

// -> [{ name, lat, lon }] (best first, at most 3), [] when nothing was found or the search is switched off. Throws when the service fails.
export async function geocodePlace(query, { fetchImpl = fetch, config = env.routing, nowMs = Date.now() } = {}) {
  const text = String(query ?? '').trim().slice(0, 120);
  if (config.geocoder === 'off' || text.length < 2) return [];
  const key = text.toLowerCase();
  const cached = cache.get(key);
  if (cached && nowMs - cached.at < CACHE_MS) return cached.results;

  await waitTurn(fetchImpl);
  const params = new URLSearchParams({
    q: text, countrycodes: 'bd', format: 'jsonv2', limit: '3', 'accept-language': 'en',
  });
  if (config.geocoderEmail) params.set('email', config.geocoderEmail);
  let response;
  try {
    response = await fetchImpl(`${config.geocoderUrl}/search?${params}`, {
      headers: { 'User-Agent': `AkashSathi/1.0 (Telegram weather bot; ${env.channels.publicUrl})`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw searchError();
  }
  const rows = response.ok ? await response.json().catch(() => null) : null;
  if (!Array.isArray(rows)) throw searchError();

  const results = rows
    .map((row) => ({ name: String(row.name || String(row.display_name ?? '').split(',')[0]).trim(), lat: Number(row.lat), lon: Number(row.lon) }))
    .filter((row) => row.name && row.lat >= BD.minLat && row.lat <= BD.maxLat && row.lon >= BD.minLon && row.lon <= BD.maxLon);
  cache.delete(key);
  cache.set(key, { at: nowMs, results });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return results;
}

export function resetGeocoderForTests() {
  cache.clear();
  nextSlotMs = 0;
}
