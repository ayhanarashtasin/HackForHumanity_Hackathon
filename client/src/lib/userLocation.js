import { pcodeFromSelection } from './alertForm.js';
import { locateUpazila } from './locate.js';
import { loadCatalogue } from '../services/weatherApi.js';

export const LOCATION_MAX_AGE_MS = 15 * 60_000;
const INITIAL = {
  status: 'idle', position: null, match: null, pcode: null, locatedAt: null,
  revision: 0, source: null, message: '', alertsEnabled: false, alertStatus: 'idle',
};
const STORAGE_KEY = 'akashsathi:user-location';
const listeners = new Set();
let location = INITIAL;
let pending = null;
let locationData = null;

export const getUserLocation = () => location;
export function subscribeUserLocation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function locationIsFresh(value = location) {
  const age = Date.now() - value.locatedAt;
  return value.status === 'ready' && value.locatedAt !== null && age >= 0 && age < LOCATION_MAX_AGE_MS;
}

function readStoredLocation() {
  try {
    const raw = typeof window !== 'undefined' ? window.sessionStorage?.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && locationIsFresh(parsed)) return parsed;
  } catch {}
  return null;
}

function persistLocation(val) {
  try {
    if (typeof window !== 'undefined') {
      if (val && val.status === 'ready' && locationIsFresh(val)) {
        window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(val));
      } else if (val && val.status !== 'ready' && val.status !== 'locating' && val.status !== 'resolving') {
        window.sessionStorage?.removeItem(STORAGE_KEY);
      }
    }
  } catch {}
}

const restored = readStoredLocation();
if (restored) location = restored;

function publish(patch) {
  location = { ...location, ...patch };
  persistLocation(location);
  listeners.forEach((listener) => listener());
  return location;
}

// Shared by one-time capture and opt-in live following. No position is persisted or sent to a geocoding service.
export function loadLocationData() {
  if (!locationData) {
    locationData = Promise.all([
      loadCatalogue(AbortSignal.timeout(15_000)),
      fetch('/data/bd-upazila.geojson', { signal: AbortSignal.timeout(15_000) }).then((response) => {
        if (!response.ok) throw new Error('boundaries');
        return response.json();
      }),
    ]).then(([catalogue, boundaries]) => ({ catalogue, boundaries })).catch((error) => {
      locationData = null;
      throw error;
    });
  }
  return locationData;
}

export async function resolveUserPosition(coords) {
  const position = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy };
  if (!Number.isFinite(position.lat) || !Number.isFinite(position.lon) || Math.abs(position.lat) > 90 || Math.abs(position.lon) > 180
    || !Number.isFinite(position.accuracy) || position.accuracy < 0) throw new Error('position');
  if (position.accuracy > 10_000) throw new Error('inaccurate');
  const { catalogue, boundaries } = await loadLocationData();
  const match = locateUpazila(position, boundaries, catalogue);
  return { position, match, pcode: pcodeFromSelection(match?.selection, catalogue) };
}

export function rememberUserPosition(resolved, locatedAt = Date.now(), source = 'live') {
  return publish({
    ...resolved, locatedAt, source, revision: location.revision + 1,
    alertStatus: 'idle',
    status: resolved.match ? 'ready' : 'outside',
    message: resolved.match ? '' : 'We could not match this position to a Bangladesh upazila. Search for an area, especially if you are near a border.',
  });
}

export function pauseLocationAlerts() {
  publish({ alertsEnabled: false, alertStatus: 'idle' });
}

export function setLocationAlertStatus(status, revision) {
  if (location.revision === revision && location.alertsEnabled && location.alertStatus !== status) publish({ alertStatus: status });
}

// Called only by an explained, user-initiated control. Concurrent callers share a request; navigation never prompts again.
export function requestUserLocation({ refresh = false } = {}) {
  if (pending) return pending;
  if (!refresh && locationIsFresh()) return Promise.resolve(location);
  if (!globalThis.isSecureContext || !navigator.geolocation) {
    return Promise.resolve(publish({ ...INITIAL, revision: location.revision + 1, status: 'unsupported', message: 'Location needs a supported browser and a secure (HTTPS) connection. You can still search for your upazila.' }));
  }

  publish({ ...INITIAL, revision: location.revision + 1, status: 'locating', alertsEnabled: true });
  const revision = location.revision;
  const fail = (status, message) => publish({ status, message, position: null, match: null, pcode: null, locatedAt: null });
  const operation = new Promise((resolve) => {
    const failed = (error) => {
      if (location.revision !== revision) { resolve(location); return; }
      resolve(fail(error.code === 1 ? 'denied' : 'error', error.code === 1
        ? 'Location access is blocked. Allow location in your browser’s site settings, then try again. Or search for your upazila above.'
        : error.code === 3 ? 'Finding your location took too long. Try again, or search for your upazila.'
          : 'Your device could not find its location. Try again, or search for your upazila.'));
    };
    try {
      navigator.geolocation.getCurrentPosition(async ({ coords, timestamp }) => {
        if (location.revision !== revision) { resolve(location); return; }
        publish({ status: 'resolving' });
        const locatedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
        try {
          const resolved = await resolveUserPosition(coords);
          resolve(location.revision === revision ? rememberUserPosition(resolved, locatedAt, 'capture') : location);
        } catch (error) {
          if (location.revision !== revision) { resolve(location); return; }
          resolve(fail(error.message === 'inaccurate' ? 'inaccurate' : 'error', error.message === 'inaccurate'
            ? 'Location is too imprecise to choose an area safely. Try again or choose your area manually.'
            : error.message === 'position' ? 'Your device could not find its location. Try again, or search for your upazila.'
              : 'Area boundaries could not be loaded. Try again or search for your upazila.'));
        }
      }, failed, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 });
    } catch {
      failed({ code: 2 });
    }
  });
  pending = operation.finally(() => { pending = null; });
  return pending;
}
