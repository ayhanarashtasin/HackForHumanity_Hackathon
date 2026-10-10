// Alert thresholds, versioned. ALERT_ENGINE_PLAN.md section 11 explains every value.
//
// STATUS: every value here is a PROTOTYPE rule. It was set from the references listed in the plan and has NOT been reviewed by BMD,
// the Department of Agricultural Extension, an occupational-health reviewer or disaster-management staff. A rule only becomes
// 'validated' when a reviewer and a date are recorded in RuleSettings; until then the interface labels every alert "prototype".
//
// Basis tags: B = BMD figure as published or quoted, A = ACGIH / NIOSH occupational heat guidance, M = AMS / NWS convention,
// P = project choice (no published criterion found; chosen to be conservative and explainable).
// This file is separate from config/thresholds.js, whose values are display thresholds for map symbols, not alert rules.

export const RULE_VERSION = 'prototype-1';
export const RULE_STATUS = 'prototype';

export const BASIS_TAGS = {
  B: 'BMD figure, as published or quoted in reports of BMD statements',
  A: 'ACGIH / NIOSH occupational heat guidance',
  M: 'AMS or NWS convention',
  P: 'Project choice: no published criterion found, chosen to be conservative and explainable',
};

export const HAZARD_TYPES = [
  'HEAVY_RAIN',
  'HEAT_STRESS',
  'STRONG_WIND',
  'OBSERVED_LIGHTNING',
  'LIGHTNING_THREAT',
  'MARINE_WEATHER',
  'DRY_SPELL',
  'OFFICIAL_NOTICE',
  'ADMIN_NOTICE',
];

// ---------- detection rules (stage 1) ----------
export const hazardRules = {
  // Level 1 is a moderate-rain level that occupation scenarios (harvest, commute, shift) need; levels 2 and 3 are heavy and very heavy.
  HEAVY_RAIN: {
    lookaheadHours: 24,
    // A forecast period counts as rain-bearing from this amount (per 3 h period); used to delimit the validity window. [P]
    qualifyMmPerPeriod: 1,
    levels: {
      1: { rain3hMm: 7.5, popMin: 50 }, // [M] AMS "moderate" starts at 2.5 mm/h x 3 h; the probability cut-off is [P]
      2: { rain3hMm: 23, rain24hMm: 44 }, // [M] AMS "heavy" = 7.6 mm/h x 3 h; [B] BMD "heavy" = 44-88 mm per 24 h
      3: { rain3hMm: 50, rain24hMm: 89 }, // [B] BMD "very heavy" = more than 88 mm per 24 h; the 3 h figure is [P]
    },
  },
  // Indicator priority: provider WBGT, then the computed heat index. BMD air temperature is recorded as evidence only.
  HEAT_STRESS: {
    lookaheadHours: 24,
    wbgtC: { 1: 23, 2: 28, 3: 31 }, // [A] 28 = ACGIH moderate-work screening value, 31 = light work; 23 = the heavy-work advisory line
    heatIndexC: { 1: 27, 2: 32, 3: 39 }, // [M] NWS caution / extreme caution / danger edges
    airTempC: { 1: 36, 2: 38, 3: 40 }, // [B] BMD heat-wave classes: mild 36-37.9, moderate 38-39.9, severe 40-41.9
  },
  STRONG_WIND: {
    lookaheadHours: 12,
    gustKph: { 1: 40, 2: 60, 3: 80 }, // 1 [P] start of Beaufort force 6; 2 [B] BMD river-port signal 2 / Kalbaishakhi squalls 60-80 km/h; 3 [P]
  },
  OBSERVED_LIGHTNING: {
    nearKm: 16, // [P] about 10 miles: industry stand-down radii are 8-10 miles
    closeKm: 10, // [M] a 30 second flash-to-thunder gap is about 6 miles
    manyStrikes: 5, // strikes within nearKm that make level 3
    episodeCloseMinutes: 30, // [M] "30 minutes after the last thunder"
  },
  LIGHTNING_THREAT: {
    horizonMinutes: 60, // the provider's nowcast horizon
    imminentMinutes: 30, // level 3 when the threat period starts within this many minutes
  },
  MARINE_WEATHER: {
    lookaheadHours: 24,
    waveM: { 1: 1.5, 2: 2.1, 3: 3.0 }, // [M] NWS small-craft seas criteria start at about 5-7 ft; no BMD wave criterion found
    gustKph: { 1: 40, 2: 51, 3: 62 }, // [B] BMD sea-port local cautionary signal 3 (~40-50) and warning signal 4 (~51-61), as reported
  },
  DRY_SPELL: {
    dryDayMm: 2.5, // [M] IMD convention for a dry day; no Bangladesh standard found
    minDays: 7, // consecutive forecast dry days
    meanTmaxMinC: 32, // [P]
    cropStages: ['planting', 'growing'],
    repeatDays: 3,
  },
};

// ---------- heat load classes (stage 3) ----------
// The hazard event is occupation-neutral. A subscriber maps to a class, and the class sets where ADVISORY and WARNING begin.
// WARNING = ACGIH acclimatized value (heavy: project estimate, ACGIH gives none); ADVISORY = WARNING - 3 C (NIOSH: unacclimatized limits run 2-3.5 C lower).
export const heatClasses = {
  light: { wbgtC: { advisory: 28, warning: 31 }, heatIndexC: { advisory: 39, warning: 51 } },
  moderate: { wbgtC: { advisory: 25, warning: 28 }, heatIndexC: { advisory: 32, warning: 39 } },
  heavy: { wbgtC: { advisory: 23, warning: 26 }, heatIndexC: { advisory: 27, warning: 32 } },
};
export const HEAT_CLASS_ORDER = ['light', 'moderate', 'heavy'];

// ---------- freshness (when a source stops being allowed to create or escalate alerts) ----------
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const freshness = {
  xweatherForecast: { maxCheckAgeMs: 9 * HOUR }, // cadence 3 h
  xweatherMaritime: { maxCheckAgeMs: 18 * HOUR }, // cadence 6 h
  lightningProbe: { maxCheckAgeMs: 15 * MINUTE, baselineMaxCheckAgeMs: 3 * HOUR },
  lightningThreat: { maxCheckAgeMs: 30 * MINUTE },
  bulletins: { maxCheckAgeMs: 3 * HOUR },
};

// ---------- scenario timing and de-duplication ----------
export const timing = {
  rainLeadHours: 12,
  harvestWarningLeadHours: 6, // FARM-01 becomes a WARNING only when the rain starts this soon
  heatLeadHours: 6, // worker scenarios speak up to this long before the shift or outdoor window
  heatPeakLeadHours: 2, // ...and not later than this long before the forecast peak
  heatEarliestLocalHour: 6, // never before 06:00 local
  windLeadHours: 12,
  marineLeadHours: 24,
  quickStatusStaleHours: 6, // an on-water status older than this makes the location uncertain (FISH-05)
};

export const notifyRules = {
  // A change this large counts as material (it updates the notification and records it); anything smaller only confirms it.
  materialValidityExtensionMs: 3 * HOUR,
  materialMetricChange: 0.25,
  // Lightning: at most this many re-notifications per episode (first strike after a threat, first strike within closeKm).
  lightningMaxRenotifications: 2,
  purgeAfterDays: 30,
  inactivityExpiryDays: 90,
};

// ---------- the rules, as rows for the admin "Rules" screen ----------
const row = (id, hazard, level, rule, basis) => ({ id, hazard, level, rule, basis, version: RULE_VERSION, status: RULE_STATUS });

export function ruleCatalogue() {
  const rain = hazardRules.HEAVY_RAIN.levels;
  const heat = hazardRules.HEAT_STRESS;
  const wind = hazardRules.STRONG_WIND.gustKph;
  const ltg = hazardRules.OBSERVED_LIGHTNING;
  const threat = hazardRules.LIGHTNING_THREAT;
  const marine = hazardRules.MARINE_WEATHER;
  const dry = hazardRules.DRY_SPELL;

  return [
    row('HEAVY_RAIN.L1', 'HEAVY_RAIN', 1, `3 h rain >= ${rain[1].rain3hMm} mm and (probability >= ${rain[1].popMin}% or probability not available)`, ['M', 'P']),
    row('HEAVY_RAIN.L2', 'HEAVY_RAIN', 2, `3 h rain >= ${rain[2].rain3hMm} mm or 24 h rain >= ${rain[2].rain24hMm} mm`, ['M', 'B']),
    row('HEAVY_RAIN.L3', 'HEAVY_RAIN', 3, `24 h rain >= ${rain[3].rain24hMm} mm or 3 h rain >= ${rain[3].rain3hMm} mm`, ['B', 'P']),
    row('HEAT_STRESS.WBGT', 'HEAT_STRESS', null, `Peak WBGT in the next 24 h: level 1 >= ${heat.wbgtC[1]}, level 2 >= ${heat.wbgtC[2]}, level 3 >= ${heat.wbgtC[3]} C (provider estimate)`, ['A']),
    row('HEAT_STRESS.HEAT_INDEX', 'HEAT_STRESS', null, `Peak computed heat index: level 1 >= ${heat.heatIndexC[1]}, level 2 >= ${heat.heatIndexC[2]}, level 3 >= ${heat.heatIndexC[3]} C (fallback when no WBGT)`, ['M']),
    row('HEAT_STRESS.AIR_TEMP', 'HEAT_STRESS', null, `BMD maximum air temperature, recorded as evidence: >= ${heat.airTempC[1]} / ${heat.airTempC[2]} / ${heat.airTempC[3]} C`, ['B']),
    row('STRONG_WIND.GUST', 'STRONG_WIND', null, `Highest gust in the next 12 h: level 1 >= ${wind[1]}, level 2 >= ${wind[2]}, level 3 >= ${wind[3]} km/h`, ['P', 'B']),
    row('OBSERVED_LIGHTNING.L2', 'OBSERVED_LIGHTNING', 2, `At least 1 strike within ${ltg.nearKm} km of the area point`, ['P']),
    row('OBSERVED_LIGHTNING.L3', 'OBSERVED_LIGHTNING', 3, `At least 1 strike within ${ltg.closeKm} km, or at least ${ltg.manyStrikes} within ${ltg.nearKm} km`, ['M']),
    row('OBSERVED_LIGHTNING.EPISODE', 'OBSERVED_LIGHTNING', null, `An episode closes ${ltg.episodeCloseMinutes} minutes after the last strike when no threat period is still ahead`, ['M']),
    row('LIGHTNING_THREAT.L3', 'LIGHTNING_THREAT', 3, `A threat polygon covers the area point and starts within ${threat.imminentMinutes} minutes`, ['P']),
    row('LIGHTNING_THREAT.L2', 'LIGHTNING_THREAT', 2, `A threat polygon covers the area point and starts within ${threat.horizonMinutes} minutes`, ['P']),
    row('MARINE_WEATHER.WAVE', 'MARINE_WEATHER', null, `Significant wave height: level 1 >= ${marine.waveM[1]}, level 2 >= ${marine.waveM[2]}, level 3 >= ${marine.waveM[3]} m`, ['M']),
    row('MARINE_WEATHER.GUST', 'MARINE_WEATHER', null, `Gust: level 1 >= ${marine.gustKph[1]}, level 2 >= ${marine.gustKph[2]}, level 3 >= ${marine.gustKph[3]} km/h`, ['B']),
    row('DRY_SPELL', 'DRY_SPELL', 1, `At least ${dry.minDays} consecutive forecast days below ${dry.dryDayMm} mm and mean maximum >= ${dry.meanTmaxMinC} C`, ['M', 'P']),
    ...Object.entries(heatClasses).map(([name, lines]) => row(
      `HEAT_CLASS.${name.toUpperCase()}`,
      'HEAT_STRESS',
      null,
      `${name} work: WBGT advisory >= ${lines.wbgtC.advisory} / warning >= ${lines.wbgtC.warning} C; heat index advisory >= ${lines.heatIndexC.advisory} / warning >= ${lines.heatIndexC.warning} C`,
      name === 'heavy' ? ['A', 'P'] : ['A'],
    )),
  ];
}
