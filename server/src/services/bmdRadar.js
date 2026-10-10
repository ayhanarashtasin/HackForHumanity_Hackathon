import { env } from '../config/env.js';
import { recordCheck, recordFailure } from './weatherStore.js';

// BMD's radar web app lists georeferenced PNG frames in these public JSON files (no CORS headers, so images are proxied).
const INDEX_FILES = ['radar-images-dhaka.json', 'radar-images-rangpur.json'];
const PRODUCTS = {
  'Surface-R': { id: 'sri', label: 'Rain rate (surface)', keep: 18 },
  'CAPPI-R (01km)': { id: 'cappi', label: 'Rain rate (1 km CAPPI)', keep: 18 },
  'Accumulated-R (12h)': { id: 'rain12h', label: 'Rain accumulation (12 h)', keep: 6 },
};
const IMAGE_CACHE_LIMIT = 400;

const state = { fetchedAt: null, sites: [], files: new Map() };
const imageCache = new Map();

// Frame times ("2026-10-10 16:51") are Bangladesh local time.
export function frameTimeToIso(datetime) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/.exec(datetime);
  return match ? `${match[1]}T${match[2]}:00+06:00` : null;
}

// BMD lists corners as [[north, west], [south, east]].
function toBounds(corners) {
  if (!Array.isArray(corners) || corners.length !== 2) return null;
  const [[north, west], [south, east]] = corners;
  return [north, west, south, east].every(Number.isFinite) ? { north, west, south, east } : null;
}

export function parseRadarIndex(json) {
  const sites = [];
  const files = new Map();

  for (const site of json.radarSites ?? []) {
    const bounds = {};
    for (const [radius, corners] of Object.entries(site.imageBounds ?? {})) {
      const parsed = toBounds(corners);
      if (parsed) bounds[radius] = parsed;
    }

    const frames = {};
    for (const image of (json.radarImages ?? []).filter((entry) => entry.radarSiteId === site.id)) {
      const product = PRODUCTS[image.product];
      const time = frameTimeToIso(image.datetime);
      if (!product || !time || !/^[\w.-]+\.png$/.test(image.file) || !bounds[image.radius]) continue;

      (frames[product.id] ??= []).push({ time, radius: image.radius, file: image.file });
      files.set(`${site.id}/${image.file}`, image.url);
    }

    for (const [id, list] of Object.entries(frames)) {
      const keep = Object.values(PRODUCTS).find((product) => product.id === id).keep;
      frames[id] = list.sort((a, b) => a.time.localeCompare(b.time)).slice(-keep);
    }

    sites.push({
      id: site.id,
      name: site.name,
      maintenance: Boolean(site.isMaintenance),
      center: site.center,
      bounds,
      frames,
    });
  }

  return { sites, files };
}

async function fetchIndex(file, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${env.weather.bmdRadarUrl}/${file}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`BMD radar HTTP ${response.status}`);
  return parseRadarIndex(await response.json());
}

export async function refreshRadar(options = {}) {
  try {
    const settled = await Promise.allSettled(INDEX_FILES.map((file) => fetchIndex(file, options)));
    const parsed = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (!parsed.length) throw settled[0].reason;

    state.sites = parsed.flatMap((entry) => entry.sites);
    state.files = new Map(parsed.flatMap((entry) => [...entry.files]));
    state.fetchedAt = new Date();

    const newest = state.sites.flatMap((site) => site.frames.sri ?? []).map((frame) => frame.time).sort().at(-1) ?? null;
    recordCheck('radar', { dataTime: newest });
  } catch (error) {
    recordFailure('radar', error);
    throw error;
  }
}

export function getRadarFrames() {
  return {
    fetchedAt: state.fetchedAt ? state.fetchedAt.toISOString() : null,
    products: Object.values(PRODUCTS).map(({ id, label }) => ({ id, label })),
    sites: state.sites.map((site) => ({
      ...site,
      frames: Object.fromEntries(Object.entries(site.frames).map(([id, list]) => [
        id,
        list.map((frame) => ({ time: frame.time, radius: frame.radius, url: `/api/radar/image/${site.id}/${frame.file}` })),
      ])),
    })),
  };
}

// Only files listed in BMD's own index can be requested, so this is not an open proxy.
export async function getRadarImage(site, file, { fetchImpl = fetch } = {}) {
  const key = `${site}/${file}`;
  const path = state.files.get(key);
  if (!path) return null;

  if (imageCache.has(key)) return imageCache.get(key);

  const response = await fetchImpl(`${env.weather.bmdRadarUrl}/${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`BMD radar image HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  imageCache.set(key, buffer);
  if (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
  return buffer;
}

export function resetRadarForTests() {
  state.fetchedAt = null;
  state.sites = [];
  state.files = new Map();
  imageCache.clear();
}
