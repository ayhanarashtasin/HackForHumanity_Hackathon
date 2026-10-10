import { MARINE_ZONES } from '../config/alertConstants.js';
import { marineKey, saveSnapshot } from './alerts/snapshots.js';

// Marine conditions for one zone's reference point: wave height from /maritime and gusts from the forecast at the same point
// (the maritime product carries no wind), merged by hour. Two requests, one token each.
const HOUR = 3_600_000;
export const MARINE_HOURS = 24;

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function normalizeMaritime(maritimeJson, forecastJson) {
  const waves = new Map();
  for (const period of maritimeJson?.response?.[0]?.periods ?? []) {
    const startMs = Date.parse(period?.dateTimeISO ?? '');
    if (!Number.isNaN(startMs)) waves.set(startMs, number(period.significantWaveHeightM));
  }
  const gusts = new Map();
  for (const period of forecastJson?.response?.[0]?.periods ?? []) {
    const startMs = Date.parse(period?.dateTimeISO ?? '');
    if (!Number.isNaN(startMs)) gusts.set(startMs, number(period.windGustKPH));
  }

  const times = [...new Set([...waves.keys(), ...gusts.keys()])].sort((a, b) => a - b);
  return times.map((startMs) => ({ startMs, endMs: startMs + HOUR, waveM: waves.get(startMs) ?? null, gustKph: gusts.get(startMs) ?? null }));
}

async function call({ client, budget, cls, path, query }) {
  const decision = await budget.reserve(cls, 1);
  if (!decision.ok) return { refused: decision.reason };
  await budget.pace();
  const result = await client.fetchJson({ path, query });
  await budget.settle({ cls, reserved: 1, headers: result.headers });
  return { result };
}

export async function refreshMaritime({
  client, budget, zones = MARINE_ZONES, now = () => new Date(), log = console,
}) {
  const summary = { fetched: 0, failed: 0, refused: 0, stoppedBy: null, cost: 0 };

  for (const zone of zones) {
    const maritime = await call({ client, budget, cls: 'maritime', path: `/maritime/${zone.lat},${zone.lon}`, query: { filter: '1hr', limit: MARINE_HOURS } });
    if (maritime.refused) { summary.refused += 1; summary.stoppedBy = `budget:${maritime.refused}`; break; }
    const wind = await call({ client, budget, cls: 'maritime', path: `/forecasts/${zone.lat},${zone.lon}`, query: { filter: '1hr', limit: MARINE_HOURS } });
    if (wind.refused) { summary.refused += 1; summary.stoppedBy = `budget:${wind.refused}`; }

    const results = [maritime.result, wind.result].filter(Boolean);
    summary.cost += results.reduce((sum, result) => sum + (result.headers.cost ?? 1), 0);
    const at = now();
    const base = {
      provider: 'xweather',
      product: 'maritime',
      queryKey: marineKey(zone.id),
      scope: { lat: zone.lat, lon: zone.lon, hours: MARINE_HOURS },
      costTokens: results.reduce((sum, result) => sum + (result.headers.cost ?? 0), 0),
      httpStatus: maritime.result.httpStatus,
      now: at,
    };

    const fatal = results.find((result) => ['auth', 'quota', 'rate-limit'].includes(result.class));
    if (fatal) {
      await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: fatal.class, message: fatal.message });
      if (fatal.class === 'quota') await budget.markExhausted();
      summary.failed += 1;
      summary.stoppedBy = fatal.class;
      log.error?.(`[alerts] Xweather maritime refresh stopped: ${fatal.class}`);
      break;
    }

    const periods = normalizeMaritime(maritime.result.class === 'ok' ? maritime.result.json : null, wind.result?.class === 'ok' ? wind.result.json : null);
    if (!periods.length) {
      await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: maritime.result.class, message: maritime.result.message ?? 'No marine periods were returned.' });
      summary.failed += 1;
      continue;
    }

    // Waves without gusts (or the reverse) still tell part of the story, and the status says it is partial.
    const partial = !periods.some((period) => period.waveM !== null) || !periods.some((period) => period.gustKph !== null);
    await saveSnapshot({
      ...base,
      status: partial ? 'PARTIAL' : 'FRESH',
      data: { periods },
      issuedAt: at,
      validFrom: new Date(periods[0].startMs),
      validTo: new Date(periods[periods.length - 1].endMs),
    });
    summary.fetched += 1;
  }
  return summary;
}
