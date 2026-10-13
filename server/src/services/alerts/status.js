import { MARINE_ZONES } from '../../config/alertConstants.js';
import { RULE_STATUS, RULE_VERSION, freshness } from '../../config/alertRules.js';
import { env } from '../../config/env.js';
import { JobState } from '../../models/JobState.js';
import { Subscriber } from '../../models/Subscriber.js';
import { dhakaIso, haversineKm } from '../time.js';
import { locationByPcode } from '../geo.js';
import { loadGeoData } from '../lightningCampaign.js';
import { allStatuses } from '../weatherStore.js';
import { createXweatherClient } from '../xweather.js';
import { createXweatherBudget } from '../xweatherBudget.js';
import { BN_REVIEWED } from './schema.js';
import { PRODUCTS, bulletinStatus } from '../bmdBulletins.js';
import { primarySource } from './hazards.js';
import { getSettings } from './settings.js';
import { monitoredAreas } from './engine.js';
import { buildAreaForecast, loadSources, toDataStatus } from './normalize.js';
import {
  effectiveLightningStatus, loadForecastInputs, loadMarineInput, loadSnapshots,
} from './snapshots.js';

// "What we checked": the data behind every alert, with its status and last-checked time. Unknown is never shown as calm.
const ORDER = ['UNAVAILABLE', 'STALE', 'PARTIAL', 'NO_MATCH', 'FRESH'];

// The weakest status wins: a person must never see FRESH when one of the things they depend on is not.
export function worstStatus(statuses) {
  const known = statuses.filter(Boolean);
  if (!known.length) return 'UNAVAILABLE';
  return known.reduce((worst, status) => (ORDER.indexOf(status) < ORDER.indexOf(worst) ? status : worst));
}

// Which hazards are checked for each occupation (the same ones the scenarios use).
export function hazardsFor(subscriber) {
  const data = subscriber.occupationData ?? {};
  const sensitive = subscriber.isHeatSensitive ? ['HEAT_STRESS'] : [];
  switch (subscriber.occupation) {
    case 'farmer': return ['HEAVY_RAIN', 'HEAT_STRESS', 'LIGHTNING', ...(['planting', 'growing'].includes(data.cropStage) ? ['DRY_SPELL'] : [])];
    case 'fisherman': return ['STRONG_WIND', ...(data.waterBody === 'river' ? [] : ['MARINE_WEATHER']), 'LIGHTNING', 'OFFICIAL_NOTICE', ...sensitive];
    case 'construction': return ['HEAT_STRESS', 'STRONG_WIND', 'LIGHTNING'];
    case 'vendor': return ['STRONG_WIND', 'HEAT_STRESS'];
    case 'student_public': return ['HEAVY_RAIN', ...(data.outdoorPlay ? ['LIGHTNING'] : []), ...sensitive];
    case 'rickshaw_labourer': return ['HEAT_STRESS', 'HEAVY_RAIN', 'LIGHTNING'];
    default: return [];
  }
}

const circlesCovering = (geo, location) => geo.circles.filter((circle) => haversineKm(location.lat, location.lon, circle.lat, circle.lon) <= geo.apiRadiusKm);

// ---------- per-subscriber coverage ----------
export async function coverageFor(subscriber, nowMs = Date.now()) {
  const upazilas = [...new Set([...subscriber.relevantUpazilas, ...(subscriber.currentArea?.expiresAt > new Date(nowMs) ? [subscriber.currentArea.upazilaPcode] : [])])];
  const sources = loadSources(nowMs);
  const geo = loadGeoData();
  const circleKeys = [...new Set(upazilas.flatMap((pcode) => circlesCovering(geo, locationByPcode.get(pcode) ?? { lat: 0, lon: 0 }).map((circle) => `c:${circle.id}`)))];
  // The three reads do not depend on each other, so they go out together (each is a database round trip).
  const [inputs, probes, bulletins] = await Promise.all([
    loadForecastInputs(upazilas, nowMs),
    loadSnapshots('xweather', 'lightning-summary', circleKeys),
    subscriber.occupation === 'fisherman' ? loadSnapshots('bmd', 'bulletin', PRODUCTS.map((product) => product.key)) : new Map(),
  ]);
  const areas = upazilas.map((pcode) => buildAreaForecast(pcode, { now: nowMs, sources, xweather: inputs.get(pcode) ?? null })).filter(Boolean);

  const rows = [];
  for (const hazard of hazardsFor(subscriber)) {
    if (hazard === 'OFFICIAL_NOTICE') {
      const products = PRODUCTS.filter((product) => subscriber.occupationData.waterBody === 'river' ? product.kind === 'river' : ['fishermen-forecast', 'sea-bulletin'].includes(product.key));
      const checked = products.map((product) => bulletins.get(product.key)).filter(Boolean);
      rows.push({ hazard, provider: 'bmd', status: worstStatus(checked.map((row) => bulletinStatus(row, nowMs))), checkedAt: stamp(checked.map((row) => row.attemptedAt ?? row.fetchedAt).sort((a, b) => +a - +b)[0]), note: 'official-documents' });
      continue;
    }
    if (hazard === 'LIGHTNING') {
      const statuses = circleKeys.map((key) => effectiveLightningStatus(probes.get(key), nowMs));
      const checked = circleKeys.map((key) => probes.get(key)?.fetchedAt).filter(Boolean).sort((a, b) => +b - +a)[0] ?? null;
      rows.push({
        hazard,
        status: circleKeys.length ? worstStatus(statuses) : 'UNAVAILABLE',
        checkedAt: checked ? dhakaIso(new Date(checked)) : null,
        provider: 'xweather',
        note: 'lightning-window',
      });
      continue;
    }

    if (hazard === 'MARINE_WEATHER') {
      const input = await loadMarineInput(MARINE_ZONES[0].id, nowMs);
      rows.push({ hazard, status: input?.status ?? 'UNAVAILABLE', checkedAt: input ? dhakaIso(new Date(input.fetchedAt)) : null, provider: 'xweather', note: null });
      continue;
    }

    const perArea = areas.map((area) => {
      const source = primarySource(area, hazard);
      const info = source ? area.providers.find((item) => item.provider === source.provider) : null;
      return { status: source?.status ?? 'UNAVAILABLE', provider: source?.provider ?? null, checkedAt: info?.checkedAt ?? null };
    });
    const statuses = perArea.map((item) => item.status);
    const oldest = perArea.map((item) => item.checkedAt).filter(Boolean).sort()[0] ?? null;
    // A heat index fallback is usable but is not the preferred WBGT.
    const fallback = hazard === 'HEAT_STRESS' && areas.some((area) => primarySource(area, hazard)?.indicator !== 'wbgt');
    rows.push({
      hazard,
      status: worstStatus(statuses) === 'FRESH' && (fallback || hazard === 'DRY_SPELL') ? 'PARTIAL' : worstStatus(statuses),
      checkedAt: oldest ? dhakaIso(new Date(oldest)) : null,
      provider: perArea.find((item) => item.provider)?.provider ?? null,
      note: fallback ? 'heat-index-fallback' : (hazard === 'DRY_SPELL' ? 'bmd-rain-unit-unconfirmed' : null),
    });
  }
  return rows;
}

// ---------- source rows (public status and admin overview) ----------
const stamp = (value) => (value ? dhakaIso(new Date(value)) : null);

const JOB_SOURCES = [
  { key: 'xweather-forecast', label: 'Xweather forecast (WBGT, rain probability)', cadenceMinutes: 180, maxAgeMs: freshness.xweatherForecast.maxCheckAgeMs },
  { key: 'xweather-maritime', label: 'Xweather maritime', cadenceMinutes: 360, maxAgeMs: freshness.xweatherMaritime.maxCheckAgeMs },
  { key: 'lightning-gate', label: 'Xweather lightning', cadenceMinutes: 5, maxAgeMs: freshness.lightningProbe.baselineMaxCheckAgeMs },
  { key: 'bulletins', label: 'BMD bulletins', cadenceMinutes: 30, maxAgeMs: freshness.bulletins.maxCheckAgeMs },
];

export async function sourceRows(nowMs = Date.now()) {
  const map = allStatuses(nowMs);
  const rows = [
    { key: 'bmd', label: 'BMD forecast', status: toDataStatus(map.bmd.status), checkedAt: map.bmd.checkedAt, dataTime: map.bmd.dataTime, cadenceMinutes: env.weather.bmdCheckMinutes },
    { key: 'openMeteo', label: 'Open-Meteo forecast', status: toDataStatus(map.openMeteo.status), checkedAt: map.openMeteo.checkedAt, dataTime: map.openMeteo.dataTime, cadenceMinutes: env.weather.openMeteoMinutes },
  ];

  const states = await JobState.find({ key: { $in: JOB_SOURCES.map((item) => item.key) } }).lean();
  const byKey = new Map(states.map((state) => [state.key, state]));
  const xweatherOn = env.alerts.xweatherEnabled && createXweatherClient().hasCredentials();

  for (const source of JOB_SOURCES) {
    const state = byKey.get(source.key);
    const checked = state?.lastCompletedAt ?? null;
    let status = 'UNAVAILABLE';
    if (source.key.startsWith('xweather') || source.key === 'lightning-gate') {
      if (!xweatherOn) status = 'UNAVAILABLE';
      else if (checked) status = nowMs - +checked > source.maxAgeMs ? 'STALE' : (state.lastStatus === 'ok' ? 'FRESH' : 'PARTIAL');
    } else if (checked) {
      status = nowMs - +checked > source.maxAgeMs ? 'STALE' : (state.lastStatus === 'ok' ? 'FRESH' : 'PARTIAL');
    }
    rows.push({
      key: source.key,
      label: source.label,
      status,
      checkedAt: checked,
      cadenceMinutes: source.cadenceMinutes,
      note: source.key.startsWith('xweather') || source.key === 'lightning-gate'
        ? (xweatherOn ? null : 'not-configured')
        : null,
      error: state?.lastError ?? null,
    });
  }
  return rows.map((row) => ({ ...row, checkedAt: stamp(row.checkedAt), dataTime: stamp(row.dataTime) }));
}

// The current official notices, linked to their originals: people should read these themselves.
export async function bulletinList(nowMs = Date.now()) {
  const rows = await loadSnapshots('bmd', 'bulletin', PRODUCTS.map((product) => product.key));
  return PRODUCTS.map((product) => {
    const row = rows.get(product.key);
    const data = row?.data;
    return {
      key: product.key,
      label: product.label,
      kind: product.kind,
      documentUrl: data?.documentFound === false ? null : (data?.documentUrl ?? null),
      issuedDate: data?.issuedDate ?? null,
      checkedAt: stamp(row?.attemptedAt ?? row?.fetchedAt),
      status: bulletinStatus(row, nowMs),
      issuedAt: data?.issuedAt ?? null,
      validFrom: data?.validFrom ?? null,
      validUntil: data?.validUntil ?? null,
      validityAssumed: Boolean(data?.validityAssumed),
      marineZone: data?.marineZone ?? null,
      parserStatus: data?.parserStatus ?? null,
      statement: data?.parserStatus === 'parsed' ? data.statement : null,
    };
  });
}

// ---------- public monitoring status ----------
export async function publicStatus(nowMs = Date.now()) {
  // Every read goes out at once: each is a round trip to the database, and run one after another they made this endpoint take ~200 ms.
  const [settings, areaCodes, engineState, budget, sources, bulletins] = await Promise.all([
    getSettings({ now: nowMs }),
    monitoredAreas(nowMs),
    JobState.findOne({ key: 'alert-engine' }).lean(),
    createXweatherBudget().summary(),
    sourceRows(nowMs),
    bulletinList(nowMs),
  ]);
  const geo = loadGeoData();
  const circles = new Set(areaCodes.flatMap((pcode) => {
    const location = locationByPcode.get(pcode);
    return location ? circlesCovering(geo, location).map((circle) => circle.id) : [];
  }));

  return {
    generatedAt: dhakaIso(new Date(nowMs)),
    engine: {
      enabled: env.alerts.engineEnabled,
      tickMinutes: env.alerts.tickMinutes,
      lastCompletedAt: engineState?.lastCompletedAt ? dhakaIso(new Date(engineState.lastCompletedAt)) : null,
      lastStatus: engineState?.lastStatus ?? null,
    },
    monitoring: {
      areas: areaCodes.length,
      circles: [...circles].sort(),
      marineZones: MARINE_ZONES.map((zone) => zone.id),
      lightning: 'Checked when forecasts indicate thunderstorm potential and hourly in daytime. A check covers the previous 5 minutes only, so this is not continuous monitoring and an unforecast storm can be missed.',
    },
    sources,
    hold: Object.entries(settings.hold).filter(([, on]) => on).map(([severity]) => severity),
    rules: { version: RULE_VERSION, status: RULE_STATUS },
    languages: { bnReviewed: BN_REVIEWED },
    bulletins,
    xweather: {
      enabled: env.alerts.xweatherEnabled,
      remaining: budget.remaining,
      usable: budget.usable,
      resetAt: budget.resetAt,
    },
  };
}
