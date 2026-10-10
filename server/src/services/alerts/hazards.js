import { RULE_STATUS, RULE_VERSION, hazardRules } from '../../config/alertRules.js';
import { inWindow } from './normalize.js';

// Stage 1: hazard detection. Pure functions: an area forecast and a clock in, a detection (or null) out.
// A detection describes the weather, never a person: occupation advice is stage 3. Thresholds live in config/alertRules.js.
const HOUR = 3_600_000;

const rule = (key) => ({ key, version: RULE_VERSION, status: RULE_STATUS });
const present = (value) => value !== null && value !== undefined && Number.isFinite(value);
const round = (value, digits = 1) => (present(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

// 3-hour equivalent of one period's amount (an hourly period counts for a third; a 3-hour period counts as it is).
const per3h = (period) => (period.endMs > period.startMs ? period.mm * ((3 * HOUR) / (period.endMs - period.startMs)) : 0);

// The wettest 3-hour window: for each period start, sum the proportional amounts of every period overlapping [start, start + 3 h).
export function rain3hMax(periods) {
  let best = 0;
  for (const anchor of periods) {
    const from = anchor.startMs;
    const to = from + 3 * HOUR;
    let sum = 0;
    for (const other of periods) {
      const overlap = Math.min(to, other.endMs) - Math.max(from, other.startMs);
      if (overlap > 0 && present(other.mm)) sum += other.mm * (overlap / (other.endMs - other.startMs));
    }
    best = Math.max(best, sum);
  }
  return best;
}

// Contiguous run of qualifying periods around the first qualifying one (a gap of up to `gapMs` is bridged).
function runBounds(periods, qualifies, gapMs = 3 * HOUR) {
  const hits = periods.filter(qualifies);
  if (!hits.length) return null;
  let end = hits[0].endMs;
  for (const hit of hits.slice(1)) {
    if (hit.startMs - end <= gapMs) end = Math.max(end, hit.endMs);
    else break;
  }
  return { startMs: hits[0].startMs, endMs: end };
}

// The first series (in preference order) that is FRESH; otherwise the first one that exists. Its status then decides whether an alert may be created.
function choosePrimary(series) {
  return series.find((item) => item.status === 'FRESH') ?? series[0] ?? null;
}

function agreementOf(levels) {
  const known = levels.filter((entry) => entry.level !== null);
  if (known.length < 2) return 'single-source';
  return known.every((entry) => entry.level === known[0].level) ? 'agree' : 'differ';
}

// ---------- heavy rain ----------
function rainLevel({ rain3h, rain24h, popMax }) {
  const levels = hazardRules.HEAVY_RAIN.levels;
  if (rain24h >= levels[3].rain24hMm || rain3h >= levels[3].rain3hMm) return 3;
  if (rain24h >= levels[2].rain24hMm || rain3h >= levels[2].rain3hMm) return 2;
  if (rain3h >= levels[1].rain3hMm && (popMax === null || popMax >= levels[1].popMin)) return 1;
  return 0;
}

function evaluateRain(series, nowMs) {
  const params = hazardRules.HEAVY_RAIN;
  const periods = inWindow(series.periods, nowMs, nowMs + params.lookaheadHours * HOUR).filter((period) => present(period.mm));
  if (!periods.length) return { level: null, metrics: null, window: null };

  const rain24h = periods.reduce((sum, period) => sum + period.mm, 0);
  const rain3h = rain3hMax(periods);
  const pops = periods.map((period) => period.pop).filter(present);
  const popMax = pops.length ? Math.max(...pops) : null;
  const level = rainLevel({ rain3h, rain24h, popMax });
  // The rain-bearing run; if no single period reaches the per-period line (a total made of many light periods), the whole forecast window is used.
  const window = level > 0
    ? (runBounds(periods, (period) => per3h(period) >= params.qualifyMmPerPeriod) ?? { startMs: periods[0].startMs, endMs: periods[periods.length - 1].endMs })
    : null;

  return {
    level,
    metrics: { rain3hMm: round(rain3h), rain24hMm: round(rain24h), popPercent: popMax },
    window,
  };
}

export function detectHeavyRain(area, nowMs) {
  // A provider whose rainfall unit is not confirmed (BMD, plan spike S3) is only ever a second opinion, never the source of an amount.
  const usable = area.rain.filter((series) => series.unitVerified);
  const primary = choosePrimary(usable);
  if (!primary) return null;

  const evaluated = area.rain.map((series) => ({ series, ...evaluateRain(series, nowMs) }));
  const main = evaluated.find((item) => item.series === primary);
  if (!main || main.level === null) return null;

  const agreement = agreementOf(evaluated.filter((item) => item.series.unitVerified).map((item) => ({ level: item.level })));
  const alternatives = evaluated.filter((item) => item !== main && item.metrics).map((item) => ({
    provider: item.series.provider,
    level: item.level,
    ...item.metrics,
    unitVerified: item.series.unitVerified,
  }));

  return {
    hazardType: 'HEAVY_RAIN',
    level: main.level,
    window: main.window ? { fromMs: main.window.startMs, untilMs: main.window.endMs } : null,
    source: { provider: primary.provider, product: primary.product },
    dataStatus: primary.status,
    evidence: { metrics: main.metrics, agreement, alternatives, coverage: 'exact', rule: rule('HEAVY_RAIN') },
  };
}

// ---------- heat stress ----------
function heatLevel(indicator, value) {
  const bands = indicator === 'wbgt' ? hazardRules.HEAT_STRESS.wbgtC : hazardRules.HEAT_STRESS.heatIndexC;
  if (value >= bands[3]) return 3;
  if (value >= bands[2]) return 2;
  if (value >= bands[1]) return 1;
  return 0;
}

// BMD heat-wave classes are a statement about maximum air temperature, recorded as evidence only.
export function airTempClass(maxC) {
  const bands = hazardRules.HEAT_STRESS.airTempC;
  if (!present(maxC) || maxC < bands[1]) return null;
  if (maxC >= 42) return 'very_severe';
  if (maxC >= bands[3]) return 'severe';
  if (maxC >= bands[2]) return 'moderate';
  return 'mild';
}

function evaluateHeat(series, nowMs) {
  const params = hazardRules.HEAT_STRESS;
  const periods = inWindow(series.periods, nowMs, nowMs + params.lookaheadHours * HOUR).filter((period) => present(period.value));
  if (!periods.length) return { level: null, peak: null };

  const peak = periods.reduce((best, period) => (period.value > best.value ? period : best));
  const level = heatLevel(series.indicator, peak.value);
  const bands = series.indicator === 'wbgt' ? params.wbgtC : params.heatIndexC;
  // The window is the run of periods at or above level 1 that contains the peak.
  let window = null;
  if (level > 0) {
    const sorted = [...periods].sort((a, b) => a.startMs - b.startMs);
    const at = sorted.indexOf(peak);
    let from = at;
    let to = at;
    while (from > 0 && sorted[from - 1].value >= bands[1] && sorted[from - 1].endMs === sorted[from].startMs) from -= 1;
    while (to < sorted.length - 1 && sorted[to + 1].value >= bands[1] && sorted[to + 1].startMs === sorted[to].endMs) to += 1;
    window = { startMs: sorted[from].startMs, endMs: sorted[to].endMs };
  }
  return { level, peak: { value: peak.value, startMs: peak.startMs, endMs: peak.endMs }, window };
}

export function detectHeat(area, nowMs) {
  const primary = choosePrimary(area.heat.filter((series) => series.periods.some((period) => present(period.value))));
  if (!primary) return null;

  const evaluated = area.heat.map((series) => ({ series, ...evaluateHeat(series, nowMs) }));
  const main = evaluated.find((item) => item.series === primary);
  if (!main || main.level === null) return null;

  const tempWindow = inWindow(area.airTemp, nowMs, nowMs + hazardRules.HEAT_STRESS.lookaheadHours * HOUR).filter((period) => present(period.value));
  const airTempMaxC = tempWindow.length ? Math.max(...tempWindow.map((period) => period.value)) : null;

  const comparable = evaluated.filter((item) => item.series.indicator === primary.indicator);
  return {
    hazardType: 'HEAT_STRESS',
    level: main.level,
    window: main.window ? { fromMs: main.window.startMs, untilMs: main.window.endMs } : null,
    source: { provider: primary.provider, product: primary.product },
    // Without a provider WBGT the indicator is the computed heat index: usable, but the data is only partly what the rules prefer.
    dataStatus: primary.status === 'FRESH' && primary.indicator !== 'wbgt' ? 'PARTIAL' : primary.status,
    evidence: {
      metrics: {
        indicator: primary.indicator,
        peakValueC: round(main.peak.value),
        peakStartMs: main.peak.startMs,
        peakEndMs: main.peak.endMs,
        airTempMaxC: round(airTempMaxC),
        airTempClass: airTempClass(airTempMaxC),
      },
      agreement: agreementOf(comparable.map((item) => ({ level: item.level }))),
      alternatives: evaluated.filter((item) => item !== main && item.peak).map((item) => ({
        provider: item.series.provider, indicator: item.series.indicator, level: item.level, peakValueC: round(item.peak.value),
      })),
      coverage: 'exact',
      rule: rule(primary.indicator === 'wbgt' ? 'HEAT_STRESS.WBGT' : 'HEAT_STRESS.HEAT_INDEX'),
    },
  };
}

// ---------- strong wind ----------
function windLevel(gust) {
  const bands = hazardRules.STRONG_WIND.gustKph;
  if (gust >= bands[3]) return 3;
  if (gust >= bands[2]) return 2;
  if (gust >= bands[1]) return 1;
  return 0;
}

function evaluateWind(series, nowMs) {
  const params = hazardRules.STRONG_WIND;
  const periods = inWindow(series.periods, nowMs, nowMs + params.lookaheadHours * HOUR).filter((period) => present(period.value));
  if (!periods.length) return { level: null, maxGust: null, window: null };

  const maxGust = Math.max(...periods.map((period) => period.value));
  const level = windLevel(maxGust);
  const window = level > 0 ? runBounds(periods, (period) => period.value >= params.gustKph[1]) : null;
  return { level, maxGust, window };
}

export function detectWind(area, nowMs) {
  const usable = area.gust.filter((series) => series.periods.some((period) => present(period.value)));
  const primary = choosePrimary(usable);
  if (!primary) return null;

  const evaluated = usable.map((series) => ({ series, ...evaluateWind(series, nowMs) }));
  const main = evaluated.find((item) => item.series === primary);
  if (!main || main.level === null) return null;

  return {
    hazardType: 'STRONG_WIND',
    level: main.level,
    window: main.window ? { fromMs: main.window.startMs, untilMs: main.window.endMs } : null,
    source: { provider: primary.provider, product: primary.product },
    dataStatus: primary.status,
    evidence: {
      metrics: { maxGustKph: round(main.maxGust) },
      agreement: agreementOf(evaluated.map((item) => ({ level: item.level }))),
      alternatives: evaluated.filter((item) => item !== main && item.maxGust !== null).map((item) => ({
        provider: item.series.provider, level: item.level, maxGustKph: round(item.maxGust),
      })),
      coverage: 'exact',
      rule: rule('STRONG_WIND.GUST'),
    },
  };
}

// ---------- marine weather (a coastal or marine zone, not an upazila) ----------
export function detectMarine(zone, nowMs) {
  const params = hazardRules.MARINE_WEATHER;
  const periods = inWindow(zone.periods ?? [], nowMs, nowMs + params.lookaheadHours * HOUR);
  if (!periods.length) return null;

  const levelOf = (bands, value) => (!present(value) ? 0 : value >= bands[3] ? 3 : value >= bands[2] ? 2 : value >= bands[1] ? 1 : 0);
  const waves = periods.map((period) => period.waveM).filter(present);
  const gusts = periods.map((period) => period.gustKph).filter(present);
  if (!waves.length && !gusts.length) return null;

  const maxWave = waves.length ? Math.max(...waves) : null;
  const maxGust = gusts.length ? Math.max(...gusts) : null;
  const level = Math.max(levelOf(params.waveM, maxWave), levelOf(params.gustKph, maxGust));
  const window = level > 0
    ? runBounds(periods, (period) => levelOf(params.waveM, period.waveM) > 0 || levelOf(params.gustKph, period.gustKph) > 0)
    : null;

  // Only a wave height or only a gust means part of the picture is missing.
  const partial = !waves.length || !gusts.length;
  return {
    hazardType: 'MARINE_WEATHER',
    level,
    window: window ? { fromMs: window.startMs, untilMs: window.endMs } : null,
    source: { provider: 'xweather', product: 'maritime' },
    dataStatus: partial && zone.status === 'FRESH' ? 'PARTIAL' : zone.status,
    evidence: {
      metrics: { maxWaveM: round(maxWave, 2), maxGustKph: round(maxGust) },
      agreement: 'single-source',
      coverage: 'regional',
      rule: rule(levelOf(params.waveM, maxWave) >= levelOf(params.gustKph, maxGust) ? 'MARINE_WEATHER.WAVE' : 'MARINE_WEATHER.GUST'),
    },
  };
}

// ---------- dry spell (FARM-03) ----------
// A forecast dry day is rain below 2.5 mm. BMD's rainfall unit is unconfirmed, so until it is, only an exact zero counts as dry
// (zero is dry in any unit); the 2.5 mm line is used once ALERT_BMD_RAIN_VERIFIED=on.
export function detectDrySpell(area, nowMs) {
  const daily = area.daily;
  if (!daily?.days?.length) return null;
  const params = hazardRules.DRY_SPELL;
  const dayMs = 24 * HOUR;
  const todayAt = daily.days.findIndex((day) => day.startMs <= nowMs && nowMs < day.startMs + dayMs);
  if (todayAt < 0) return null;

  const isDry = (day) => present(day.rainMm) && (daily.rainUnitVerified ? day.rainMm < params.dryDayMm : day.rainMm === 0);
  let count = 0;
  const run = [];
  for (let i = todayAt; i < daily.days.length && isDry(daily.days[i]); i += 1) {
    count += 1;
    run.push(daily.days[i]);
  }

  const tmax = run.map((day) => day.tmaxC).filter(present);
  const meanTmax = tmax.length ? tmax.reduce((sum, value) => sum + value, 0) / tmax.length : null;
  if (count < params.minDays || meanTmax === null || meanTmax < params.meanTmaxMinC) return null;

  return {
    hazardType: 'DRY_SPELL',
    level: 1,
    window: { fromMs: run[0].startMs, untilMs: run[run.length - 1].startMs + dayMs },
    source: { provider: daily.provider, product: daily.product },
    dataStatus: daily.status === 'FRESH' && !daily.rainUnitVerified ? 'PARTIAL' : daily.status,
    evidence: {
      metrics: { dryDays: count, meanTmaxC: round(meanTmax) },
      agreement: 'single-source',
      coverage: 'exact',
      forecastOnly: true,
      rule: rule('DRY_SPELL'),
    },
  };
}

export const detectors = [detectHeavyRain, detectHeat, detectWind, detectDrySpell];

// Detection for every forecast hazard of one area.
export function detectAreaHazards(area, nowMs) {
  return detectors.map((detect) => detect(area, nowMs)).filter((detection) => detection && detection.level > 0 && detection.window);
}

// The series that decides one hazard type for an area (null when no source can say). The engine only supersedes an event that is no
// longer detected when this source is FRESH: a missing or stale source never silently clears an alert.
export function primarySource(area, hazardType) {
  switch (hazardType) {
    case 'HEAVY_RAIN': return choosePrimary(area.rain.filter((series) => series.unitVerified));
    case 'HEAT_STRESS': return choosePrimary(area.heat.filter((series) => series.periods.some((period) => present(period.value))));
    case 'STRONG_WIND': return choosePrimary(area.gust.filter((series) => series.periods.some((period) => present(period.value))));
    case 'DRY_SPELL': return area.daily ?? null;
    default: return null;
  }
}

export const primaryStatus = (area, hazardType) => primarySource(area, hazardType)?.status ?? null;
