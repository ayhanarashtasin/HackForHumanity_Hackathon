import { hazardRules } from '../../config/alertRules.js';
import { env } from '../../config/env.js';
import { dhakaDate } from '../time.js';
import { inWindow, stepSeries } from './normalize.js';

// Forecast confidence for rain alerts: a second opinion from the ML service (ml-service/), Random Forests trained on past Open-Meteo
// forecasts and the rain that actually fell (ERA5). Level 2+ alerts are rated by the heavy-rain model (did Level 2 rain happen?),
// Level 1 alerts by the moderate-rain model (did Level 1 rain happen?), and only when the amounts come from Open-Meteo, the provider
// both were trained on. It never creates, cancels, raises or lowers an alert, and when the service is off, slow or failing the
// alerts go out exactly as before.
const HOUR = 3_600_000;
const COOL_OFF_MS = 5 * 60_000; // after a failure, skip the service for a while so a dead service cannot slow every tick
// The rule looks at the next 24 hours from now; the closest training rows are the ones forecast on the day itself (lead 0).
const LEAD_DAY = 0;
const BANDS = new Set(['high', 'medium', 'low']);
const TARGETS = new Set(['heavy', 'moderate']);

let skipUntilMs = 0;

const present = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

// The model's inputs for one detection, or null when it does not apply. Rain amounts are the rule's own metrics; humidity and CAPE
// come from the same Open-Meteo 3-hour blocks over the same window, which is how the training features were built.
export function confidenceInput(detection, area, sources, nowMs) {
  if (detection?.hazardType !== 'HEAVY_RAIN' || !(detection.level >= 1) || detection.source?.provider !== 'open-meteo') return null;
  const metrics = detection.evidence?.metrics;
  if (!present(area?.lat) || !present(area?.lon) || !present(metrics?.rain24hMm) || !present(metrics?.rain3hMm)) return null;

  const until = nowMs + hazardRules.HEAVY_RAIN.lookaheadHours * HOUR;
  const values = (key) => inWindow(stepSeries(sources?.openMeteo, area.pcode, key), nowMs, until).map((period) => period.value).filter(present);
  const rh = values('rh');
  const cape = values('cape');
  if (!rh.length || !cape.length) return null;

  return {
    id: area.pcode,
    // Each model only answers the question its label asks: heavy rain for Level 2+, moderate rain for Level 1.
    target: detection.level >= 2 ? 'heavy' : 'moderate',
    lat: area.lat,
    lon: area.lon,
    date: dhakaDate(new Date(nowMs)),
    lead_day: LEAD_DAY,
    rain24_mm: metrics.rain24hMm,
    rain3h_max_mm: metrics.rain3hMm,
    rh_mean: round(rh.reduce((sum, value) => sum + value, 0) / rh.length, 1),
    cape_max: Math.max(...cape),
  };
}

// One request for every input of this tick -> Map(id -> { band, target, riskScore, predictedClass, modelVersion }). Never throws.
export async function fetchConfidence(inputs, { fetchImpl = fetch, nowMs = Date.now(), url = env.alerts.mlServiceUrl, timeoutMs = env.alerts.mlTimeoutMs } = {}) {
  if (!url || !inputs.length || nowMs < skipUntilMs) return new Map();
  try {
    const response = await fetchImpl(`${url}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: inputs }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`ML service HTTP ${response.status}`);
    const json = await response.json();
    const result = new Map();
    for (const item of Array.isArray(json?.items) ? json.items : []) {
      if (typeof item?.id !== 'string' || !BANDS.has(item.band)) continue;
      result.set(item.id, {
        band: item.band,
        target: TARGETS.has(item.target) ? item.target : null,
        riskScore: present(item.risk_score) ? item.risk_score : null,
        predictedClass: item.predicted_class === 1 ? 1 : 0,
        modelVersion: typeof item.model_version === 'string' ? item.model_version : null,
      });
    }
    return result;
  } catch (error) {
    skipUntilMs = nowMs + COOL_OFF_MS;
    console.error(`[alerts] forecast confidence unavailable, alerts continue without it: ${String(error?.message ?? error).slice(0, 160)}`);
    return new Map();
  }
}

// Adds evidence.forecastConfidence to the qualifying detections of this tick, in place. `entries` = [{ area, detections }].
export async function attachForecastConfidence(entries, { sources, nowMs, fetchImpl } = {}) {
  const pending = [];
  for (const { area, detections } of entries) {
    for (const detection of detections) {
      const input = confidenceInput(detection, area, sources, nowMs);
      if (input) pending.push({ detection, input });
    }
  }
  if (!pending.length) return 0;

  const results = await fetchConfidence(pending.map((item) => item.input), { fetchImpl, nowMs });
  let attached = 0;
  for (const { detection, input } of pending) {
    const result = results.get(input.id);
    // An answer from the wrong model (an old service that ignores `target`) is not used.
    if (!result || result.target !== input.target) continue;
    detection.evidence.forecastConfidence = {
      ...result,
      provider: 'open-meteo',
      window: { fromMs: nowMs, untilMs: nowMs + hazardRules.HEAVY_RAIN.lookaheadHours * HOUR },
      assessedAt: new Date(nowMs).toISOString(),
    };
    attached += 1;
  }
  return attached;
}

// Tests only: forget an earlier failure.
export function resetConfidenceCoolOff() {
  skipUntilMs = 0;
}
