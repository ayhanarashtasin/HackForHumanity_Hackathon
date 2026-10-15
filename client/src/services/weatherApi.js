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
  route: (start, end, signal) => request('/weather/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start, end }),
    signal,
  }),
  storms: (signal) => request('/storms', { signal }),
  stormDemo: (signal) => request('/storms/demo', { signal }),
};

export async function loadCatalogue(signal) {
  const response = await fetch('/data/locations.json', { signal });
  if (!response.ok) throw new Error('The location catalogue is missing. Run "npm run build:geo".');
  return response.json();
}
