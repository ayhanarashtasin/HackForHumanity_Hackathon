import { request } from './api.js';

// Every call reads the backend's shared cache; none of them triggers an upstream fetch.
export const weatherApi = {
  snapshot: (signal) => request('/weather/snapshot', { signal }),
  daily: (signal) => request('/weather/daily', { signal }),
  radarFrames: (signal) => request('/radar/frames', { signal }),
  satelliteFrames: (signal) => request('/satellite/frames', { signal }),
  lightningStatus: (signal) => request('/lightning/status', { signal }),
  lightningSummaries: (signal) => request('/lightning/summaries', { signal }),
  lightningForUpazila: (pcode, signal) => request(`/lightning/upazila/${pcode}`, { signal }),
};

export async function loadCatalogue(signal) {
  const response = await fetch('/data/locations.json', { signal });
  if (!response.ok) throw new Error('The location catalogue is missing. Run "npm run build:geo".');
  return response.json();
}
