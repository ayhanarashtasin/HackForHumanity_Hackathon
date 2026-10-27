import { env } from '../../config/env.js';
import { haversineKm } from '../time.js';
import { effectiveStatus, loadSnapshots, saveSnapshot } from './snapshots.js';

// DDM's public shelter page embeds its list as `let shelter = [...]` in HTML. We keep only Flood shelters with usable coordinates and
// leaving contact fields out entirely: the alert is public, and a shelter guard's phone number is not weather information.
const HOUR = 3_600_000;
const MAX_DISTANCE_KM = 50;

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const truthy = (value) => /^(yes|true|1|available)$/i.test(String(value ?? '').trim());

export function parseShelterHtml(html) {
  const text = String(html ?? '');
  const match = /(?:let|var|const)\s+shelter\s*=\s*/.exec(text);
  if (!match) throw new Error('The DDM page did not contain the shelter list.');
  const start = match.index + match[0].length;
  const end = text.indexOf('];', start);
  if (end === -1) throw new Error('The DDM shelter list was truncated.');
  let rows;
  try {
    rows = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('The DDM shelter list was not valid JSON.');
  }
  if (!Array.isArray(rows)) throw new Error('The DDM shelter list was not an array.');
  return rows;
}

export function normaliseShelters(rows) {
  const shelters = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!/^flood$/i.test(String(row?.shelter_type_id ?? '').trim())) continue;
    if (row?.status && !/useable|usable/i.test(String(row.status))) continue;
    const lat = finite(row.lat);
    const lon = finite(row.lon);
    // A handful of rows use 0,0 or swapped coordinates; Bangladesh is roughly 20-27 N, 87-93.5 E.
    if (lat === null || lon === null || lat < 20 || lat > 27 || lon < 87 || lon > 93.5) continue;
    const rawName = String(row.name ?? '').trim();
    const name = rawName && rawName !== '0' ? rawName : `${String(row.upazila_name ?? 'Flood').trim()} flood shelter`;
    const capacity = finite(row.capacity);
    shelters.push({
      id: String(row.id ?? `${lat},${lon}`),
      name,
      lat,
      lon,
      upazila: String(row.upazila_name ?? '').trim() || null,
      district: String(row.district_name ?? '').trim() || null,
      union: String(row.union_name ?? '').trim() || null,
      capacity: capacity !== null && capacity >= 0 ? capacity : null,
      distanceFromUpazilaKm: finite(row.distance_from_upz),
      disabledFriendly: truthy(row.disabled_friendly),
      womenSpace: truthy(row.seperate_womens_place),
      womenToilet: truthy(row.seperate_womens_toilet),
      safeWater: truthy(row.safe_water),
      childrenFriendly: truthy(row.children_friendly),
      elderlyFriendly: truthy(row.elderly_friendly),
      toilets: finite(row.num_toilet),
      source: 'ddm',
    });
  }
  return shelters;
}

// Nearest shelters to the alert area's point. Distance is the only ranking: DDM does not publish live occupancy or open/closed status.
export function nearestShelters(shelters, lat, lon, limit = env.flood.maxShelters) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return (Array.isArray(shelters) ? shelters : [])
    .map((shelter) => ({ ...shelter, distanceKm: Math.round(haversineKm(lat, lon, shelter.lat, shelter.lon) * 10) / 10 }))
    .filter((shelter) => shelter.distanceKm <= MAX_DISTANCE_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map((shelter) => ({
      ...shelter,
      mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${shelter.lat},${shelter.lon}`,
    }));
}

async function fetchShelterHtml({ fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const response = await fetchImpl(env.flood.shelterUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`DDM shelters returned HTTP ${response.status}`);
  return { html: await response.text(), status: response.status };
}

export const loadShelterSnapshot = async () => (await loadSnapshots('ddm', 'flood-shelters', ['bd'])).get('bd') ?? null;

// A failed DDM refresh stores UNAVAILABLE while deliberately keeping the last good list. For display, that old list is STALE, not
// missing: treating it as unavailable would hide usable shelters and make the outage look like there are none.
export function shelterSnapshotStatus(snapshot, nowMs = Date.now()) {
  const status = effectiveStatus(snapshot, env.flood.shelterRefreshHours * HOUR, nowMs);
  if (status === 'UNAVAILABLE' && snapshot?.data?.shelters?.length) return 'STALE';
  return status;
}

// The shelter page changes rarely; a daily refresh is enough. If DDM is down, the previous list stays usable and is labelled STALE.
export async function refreshFloodShelters({ fetchImpl, nowMs = Date.now(), log = () => {} } = {}) {
  if (!env.flood.sheltersEnabled) return null;
  const existing = await loadShelterSnapshot();
  const existingStatus = effectiveStatus(existing, env.flood.shelterRefreshHours * HOUR, nowMs);
  if (existingStatus === 'FRESH' || existingStatus === 'PARTIAL') return existing;

  const now = new Date(nowMs);
  try {
    const { html, status } = await fetchShelterHtml({ fetchImpl });
    const shelters = normaliseShelters(parseShelterHtml(html));
    if (!shelters.length) throw new Error('The DDM shelter list had no usable Flood shelters.');
    const saved = await saveSnapshot({
      provider: 'ddm',
      product: 'flood-shelters',
      queryKey: 'bd',
      scope: { sourceUrl: env.flood.shelterUrl },
      status: 'FRESH',
      data: { shelters, sourceUrl: env.flood.shelterUrl, fetchedFrom: 'rapid.ddm.gov.bd' },
      issuedAt: now,
      httpStatus: status,
      now,
    });
    log({ provider: 'ddm', product: 'flood-shelters', count: shelters.length });
    return saved;
  } catch (error) {
    await saveSnapshot({
      provider: 'ddm',
      product: 'flood-shelters',
      queryKey: 'bd',
      status: 'UNAVAILABLE',
      errorClass: 'shelter-fetch',
      message: error.message,
      now,
    });
    log({ provider: 'ddm', product: 'flood-shelters', error: error.message });
    return loadShelterSnapshot();
  }
}
