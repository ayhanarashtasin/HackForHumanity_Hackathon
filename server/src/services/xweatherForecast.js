import { locationByPcode } from './geo.js';
import { saveSnapshot, upazilaKey } from './alerts/snapshots.js';

// Xweather hourly forecast for one upazila's representative point: aligned probability, precipitation, WBGT, gusts, in one request (1 token).
// Normalised here; nothing downstream sees Xweather field names. `null` means "not provided", never zero.
const HOUR = 3_600_000;
export const FORECAST_HOURS = 24;

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// json.response[0].periods -> hourly periods. Returns null when the response has no usable period.
export function normalizeForecast(json) {
  const periods = json?.response?.[0]?.periods;
  if (!Array.isArray(periods)) return null;

  const hourly = [];
  for (const period of periods) {
    const startMs = Date.parse(period?.dateTimeISO ?? period?.validTime ?? '');
    if (Number.isNaN(startMs)) continue;
    hourly.push({
      startMs,
      endMs: startMs + HOUR,
      tempC: number(period.tempC),
      feelsLikeC: number(period.feelslikeC),
      wbgtC: number(period.wetBulbGlobeTempC),
      pop: number(period.pop),
      precipMM: number(period.precipMM),
      humidity: number(period.humidity),
      windKph: number(period.windSpeedKPH),
      windGustKph: number(period.windGustKPH),
      // coverage:intensity:weather, e.g. "::CL" (clear) or "SC:H:T" (a thunderstorm code ends in T)
      weatherCode: typeof period.weatherPrimaryCoded === 'string' ? period.weatherPrimaryCoded : null,
    });
  }
  return hourly.length ? hourly : null;
}

export const thunderInForecast = (hourly, fromMs, toMs) => hourly.some((period) => period.startMs < toMs && period.endMs > fromMs
  && typeof period.weatherCode === 'string' && period.weatherCode.split(':')[2]?.split(',').includes('T'));

// Fetches the forecast for each due upazila through the token governor. Stops early on an exhausted allowance, a rejected key or
// a rate limit; any other failure only marks that one area unavailable (its last good data is kept and reported as such).
export async function refreshForecasts({
  client, budget, pcodes, now = () => new Date(), log = console,
}) {
  const summary = { fetched: 0, failed: 0, refused: 0, stoppedBy: null, cost: 0 };

  for (const pcode of pcodes) {
    const location = locationByPcode.get(pcode);
    if (!location) continue;

    const decision = await budget.reserve('forecast', 1);
    if (!decision.ok) {
      summary.refused += 1;
      summary.stoppedBy = `budget:${decision.reason}`;
      break;
    }

    await budget.pace();
    const result = await client.fetchJson({
      path: `/forecasts/${location.lat},${location.lon}`,
      query: { filter: '1hr', limit: FORECAST_HOURS },
    });
    await budget.settle({ cls: 'forecast', reserved: 1, headers: result.headers });
    summary.cost += result.headers.cost ?? 1;
    const at = now();
    const scope = { lat: location.lat, lon: location.lon, hours: FORECAST_HOURS };
    const base = { provider: 'xweather', product: 'forecast-1hr', queryKey: upazilaKey(pcode), scope, costTokens: result.headers.cost, httpStatus: result.httpStatus, now: at };

    if (result.class === 'ok') {
      const hourly = normalizeForecast(result.json);
      if (!hourly) {
        await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: 'invalid', message: 'Xweather returned a forecast without usable periods.' });
        summary.failed += 1;
        continue;
      }
      const hasWbgt = hourly.some((period) => period.wbgtC !== null);
      await saveSnapshot({
        ...base,
        status: hasWbgt ? 'FRESH' : 'PARTIAL',
        data: { periods: hourly },
        issuedAt: at,
        validFrom: new Date(hourly[0].startMs),
        validTo: new Date(hourly[hourly.length - 1].endMs),
      });
      summary.fetched += 1;
      continue;
    }

    await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: result.class, message: result.message });
    summary.failed += 1;
    if (['auth', 'quota', 'rate-limit'].includes(result.class)) {
      if (result.class === 'quota') await budget.markExhausted();
      summary.stoppedBy = result.class;
      log.error?.(`[alerts] Xweather forecast refresh stopped: ${result.class}`);
      break;
    }
  }
  return summary;
}
