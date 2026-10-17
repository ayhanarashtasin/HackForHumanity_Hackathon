import { getUserLocation, locationIsFresh, pauseLocationAlerts, setLocationAlertStatus } from '../lib/userLocation.js';
import { alertApi } from '../services/alertApi.js';

const attempts = new Map();
let writes = Promise.resolve();

// Serialize one-time updates, live heartbeats and stop so a late save cannot undo a stop.
export function updateLocationArea(pcode) {
  const result = writes.catch(() => {}).then(() => alertApi.setCurrentArea(pcode, AbortSignal.timeout(15_000)));
  writes = result;
  return result;
}

export function stopLocationArea() {
  pauseLocationAlerts();
  return updateLocationArea(null);
}

export async function syncLocationArea(profile) {
  const location = getUserLocation();
  const eligible = () => {
    const current = getUserLocation();
    return current.revision === location.revision && current.source === 'capture'
      && current.alertsEnabled && current.pcode && locationIsFresh(current);
  };
  if (!eligible()) return null;
  const { revision } = location;
  try {
    const mine = profile === undefined ? (await alertApi.session()).profile : profile;
    if (!mine || !eligible()) return null;
    if (mine.currentArea?.source === 'telegram' && Date.parse(mine.currentArea.expiresAt) > Date.now()) {
      setLocationAlertStatus('telegram', revision);
      return null;
    }
    const key = `${mine.createdAt}:${revision}`;
    if (!attempts.has(key)) {
      setLocationAlertStatus('syncing', revision);
      const attempt = updateLocationArea(location.pcode).catch((error) => {
        attempts.delete(key);
        throw error;
      });
      attempts.set(key, attempt);
    }
    const data = await attempts.get(key);
    if (!eligible()) return null;
    setLocationAlertStatus('saved', revision);
    return data;
  } catch (error) {
    setLocationAlertStatus(error.status === 409 ? 'telegram' : 'error', revision);
    if (error.status === 409) return null;
    throw error;
  }
}
