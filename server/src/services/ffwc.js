import { env } from '../config/env.js';

// FFWC (Flood Forecasting and Warning Centre) public data API. The gateway requires the project key header plus an Origin/Referer
// from the public site; without both it answers 403 with a short text body. The key never leaves the server.
const PATHS = {
  updateDate: '/data_load/update-date/',
  stations: '/data_load/stations-2025/',
  observed: '/data_load/observed/',
  observedRainfall: '/data_load/observed-rainfall/',
  threeDayRainfall: '/data_load/three-days-observed-rainfall/',
};

export class FfwcError extends Error {
  constructor(message, { httpStatus = null, errorClass = 'ffwc-error' } = {}) {
    super(message);
    this.name = 'FfwcError';
    this.httpStatus = httpStatus;
    this.errorClass = errorClass;
  }
}

const configured = () => env.flood.enabled && Boolean(env.flood.apiKey);

async function getJson(path, { fetchImpl = fetch, timeoutMs = env.flood.timeoutMs } = {}) {
  if (!configured()) throw new FfwcError('FFWC is not configured.', { errorClass: 'not-configured' });

  let response;
  try {
    response = await fetchImpl(`${env.flood.apiUrl}${path}`, {
      headers: {
        accept: 'application/json',
        'x-ffwc-internal-key': env.flood.apiKey,
        origin: env.flood.origin,
        referer: `${env.flood.origin}/`,
        'user-agent': 'AkashSathi/1.0 (+https://akashsathi.example; flood alerts)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new FfwcError(timedOut ? 'The FFWC request timed out.' : 'The FFWC API could not be reached.', {
      errorClass: timedOut ? 'timeout' : 'network',
    });
  }

  if (!response.ok) {
    // Read a short body for the log, but never surface it to users: it can be a gateway page rather than JSON.
    const detail = await response.text().catch(() => '');
    throw new FfwcError(`FFWC returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`, {
      httpStatus: response.status,
      errorClass: response.status === 403 || response.status === 401 ? 'unauthorized' : 'http',
    });
  }

  const type = response.headers.get('content-type') ?? '';
  if (!/json/i.test(type)) throw new FfwcError('FFWC returned a non-JSON response.', { httpStatus: response.status, errorClass: 'content-type' });

  try {
    return await response.json();
  } catch {
    throw new FfwcError('FFWC returned malformed JSON.', { httpStatus: response.status, errorClass: 'json' });
  }
}

export const ffwcConfigured = configured;
export const ffwcPaths = PATHS;

export const fetchUpdateDate = (options) => getJson(PATHS.updateDate, options);
export const fetchStations = (options) => getJson(PATHS.stations, options);
export const fetchObserved = (options) => getJson(PATHS.observed, options);
export const fetchObservedRainfall = (options) => getJson(PATHS.observedRainfall, options);
export const fetchThreeDayRainfall = (options) => getJson(PATHS.threeDayRainfall, options);
