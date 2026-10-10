import { env } from '../config/env.js';

const REQUEST_TIMEOUT_MS = 15_000;

// Xweather error codes are matched by pattern because the full list is not published in one place.
const QUOTA_CODE = /^maxhits_(?!minute)|usage_limit|quota/i;
const RATE_CODE = /^maxhits_minute|rate_?limit|too_many/i;
const AUTH_CODE = /invalid_client|client_id|client_secret|namespace|unauthori[sz]ed|forbidden|denied|subscription|credential|auth/i;
const SERVER_CODE = /server|internal|unavailable|timeout/i;

const COUNT_KEYS = ['total', 'totalCount', 'count', 'num', 'numStrikes', 'strikes', 'lightningCount'];
const CLOUD_TO_GROUND_KEYS = ['cg', 'cloudToGround', 'cloud_to_ground', 'cgCount', 'groundStrikes'];
const INTRACLOUD_KEYS = ['ic', 'intracloud', 'intraCloud', 'intra_cloud', 'icCount'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function findNumber(containers, keys) {
  for (const container of containers) {
    if (!isObject(container)) continue;
    for (const key of keys) {
      if (typeof container[key] === 'number' && Number.isFinite(container[key])) return container[key];
    }
  }
  return null;
}

// The only place that knows the shape of a lightning summary. The exact response was never observed
// (no credentials were available when this was written), so it searches likely keys and never invents numbers.
export function parseSummary(json) {
  const raw = json?.response;
  const response = Array.isArray(raw) ? raw[0] : raw;
  const empty = { populated: false, count: null, cloudToGround: null, intracloud: null, detail: null };

  if (!isObject(response) || Object.keys(response).length === 0) return empty;

  const summary = isObject(response.summary) ? response.summary : response;
  const containers = [
    summary,
    summary.total,
    summary.types,
    summary.counts,
    summary.totals,
    summary.byType,
    response,
  ];

  const cloudToGround = findNumber(containers, CLOUD_TO_GROUND_KEYS);
  const intracloud = findNumber(containers, INTRACLOUD_KEYS);
  let count = findNumber(containers, COUNT_KEYS);
  let detail = null;

  if (count === null && cloudToGround !== null && intracloud !== null) {
    count = cloudToGround + intracloud;
    detail = 'Total is the sum of the cloud-to-ground and intracloud counts.';
  } else if (count === null) {
    detail = 'A summary was returned, but its count field was not recognised, so no count is shown.';
  }

  return { populated: true, count, cloudToGround, intracloud, detail };
}

// Removes credentials from any text that could reach a log, an error or an API response.
export function redactSecrets(text, config = env.xweather) {
  let output = String(text ?? '');
  for (const secret of [config.clientId, config.clientSecret]) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output.replace(/(client_(?:id|secret)=)[^&\s"']+/gi, '$1[redacted]');
}

function numberHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readHeaders(headers) {
  return {
    cost: numberHeader(headers, 'x-cost-tokens'),
    remainingPeriod: numberHeader(headers, 'x-ratelimit-remaining-period'),
    remainingMinute: numberHeader(headers, 'x-ratelimit-remaining-minute'),
    limitMinute: numberHeader(headers, 'x-ratelimit-limit-minute'),
    limitPeriod: numberHeader(headers, 'x-ratelimit-limit-period'),
    retryAfterSeconds: numberHeader(headers, 'retry-after'),
  };
}

function classifyErrorCode(code) {
  if (QUOTA_CODE.test(code)) return 'quota';
  if (RATE_CODE.test(code)) return 'rate-limit';
  if (AUTH_CODE.test(code)) return 'auth';
  if (SERVER_CODE.test(code)) return 'server';
  return 'invalid';
}

// Classes: ok | no-data | warning | invalid | auth | quota | rate-limit | server | network.
export function createXweatherClient({ fetchImpl = globalThis.fetch, config = env.xweather, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const redact = (text) => redactSecrets(text, config);

  function hasCredentials() {
    return Boolean(config.clientId && config.clientSecret);
  }

  const credentialQuery = () => [
    `client_id=${encodeURIComponent(config.clientId)}`,
    `client_secret=${encodeURIComponent(config.clientSecret)}`,
  ];

  // One request, with every failure classified. Returns { stop } when the result is already final (a network, HTTP, JSON or API error,
  // or "valid request, no matching data"), otherwise { json, result, detail } for the caller to read the payload.
  async function call(url) {
    const base = { httpStatus: null, code: null, message: null, headers: readHeaders(new Headers()), summary: null };
    let response;

    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { stop: { ...base, class: 'network', message: timedOut ? 'The request timed out.' : redact(`Network error: ${error?.message ?? 'unknown'}`) } };
    }

    const headers = readHeaders(response.headers);
    const result = { ...base, httpStatus: response.status, headers };

    if (response.status === 429) return { stop: { ...result, class: 'rate-limit', code: 'http_429', message: 'Rate limit reached.' } };
    if (response.status === 401 || response.status === 403) {
      return { stop: { ...result, class: 'auth', code: `http_${response.status}`, message: 'Xweather rejected the credentials or the subscription.' } };
    }
    if (response.status >= 500) return { stop: { ...result, class: 'server', code: `http_${response.status}`, message: 'Xweather server error.' } };

    let json;
    try {
      json = await response.json();
    } catch {
      return { stop: { ...result, class: 'server', code: 'invalid_json', message: 'Xweather returned a response that is not valid JSON.' } };
    }

    const code = typeof json?.error?.code === 'string' ? json.error.code : null;
    const description = redact(json?.error?.description ?? '');
    const detail = { code, message: description || null };

    if (json?.success === false || (!json?.success && response.status >= 400)) {
      const errorClass = code ? classifyErrorCode(code) : 'invalid';
      return { stop: { ...result, ...detail, class: errorClass, message: description || `Xweather reported an error${code ? ` (${code})` : ''}.` } };
    }

    if (code === 'warn_no_data') return { stop: { ...result, ...detail, class: 'no-data' } };

    return { json, result, detail, code, description };
  }

  async function fetchSummary({ lat, lon, radiusKm }) {
    const query = [`p=${lat},${lon}`, `radius=${radiusKm}km`, 'from=-5minutes', 'to=now', ...credentialQuery()].join('&');
    const step = await call(`${config.baseUrl}/lightning/summary/closest?${query}`);
    if (step.stop) return step.stop;

    const { json, result, detail, code, description } = step;
    const summary = parseSummary(json);

    if (code && /^warn/i.test(code)) {
      // Other warnings (e.g. adjusted or invalid parameters): usable data is kept, otherwise the sample is unavailable.
      return summary.populated
        ? { ...result, ...detail, class: 'ok', summary }
        : { ...result, ...detail, class: 'warning', message: description || `Xweather warning: ${code}.` };
    }

    // A success with an empty response means nothing matched the query.
    return summary.populated ? { ...result, ...detail, class: 'ok', summary } : { ...result, ...detail, class: 'no-data' };
  }

  // A generic authenticated GET for the alert engine's other products (forecasts, maritime, lightning strikes and threats).
  // `query` is a plain object of non-secret parameters. The caller reads `json.response`; classes are the same as above.
  async function fetchJson({ path, query = {} }) {
    if (typeof path !== 'string' || !/^\/[a-z0-9/_,.-]+$/i.test(path) || path.includes('..')) throw new Error('Invalid Xweather path.');
    const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    const step = await call(`${config.baseUrl}${path}?${[...pairs, ...credentialQuery()].join('&')}`);
    if (step.stop) return step.stop;

    const { json, result, detail } = step;
    const response = json?.response;
    const empty = response === undefined || response === null || (Array.isArray(response) && response.length === 0);
    // An empty response is "nothing matched"; a populated one is usable even when it carries a non-fatal warning code.
    return { ...result, ...detail, class: empty ? 'no-data' : 'ok', json };
  }

  return { hasCredentials, fetchSummary, fetchJson };
}
