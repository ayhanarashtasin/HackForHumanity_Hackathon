import { env } from '../../config/env.js';
import { RULE_STATUS, RULE_VERSION, freshness, hazardRules, notifyRules } from '../../config/alertRules.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import {
  fetchObserved, fetchObservedRainfall, fetchStations, fetchThreeDayRainfall, fetchUpdateDate, ffwcConfigured,
} from '../ffwc.js';
import { haversineKm } from '../time.js';
import { buildFloodReadings, groupFloodReadings } from './floodStations.js';
import { loadShelterSnapshot, nearestShelters, refreshFloodShelters, shelterSnapshotStatus } from './floodShelters.js';
import { effectiveStatus, loadSnapshots, saveSnapshot } from './snapshots.js';
import { withdrawEvent } from './events.js';

// FloodSense ties three public sources together: FFWC gauge readings (river level against the published danger level), the same
// stations' rainfall figures, and DDM's flood-shelter list. It creates one RIVER_FLOOD event per upazila, not per gauge, and reuses
// the ordinary notification pipeline: recipients, Bangla/English text, dedup, Telegram and SMS all stay in one place.
const HOUR = 3_600_000;
const BLOCKING = new Set(['STALE', 'UNAVAILABLE']);
const PROVIDER = 'ffwc';
const PRODUCT = 'river-gauge';
const PUBLIC_URL = 'https://ffwc.gov.bd/';

const round1 = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10) / 10);

// A failed refresh stores UNAVAILABLE but deliberately keeps the last good readings. When those rows still exist, the feed is stale,
// not empty: saying "unavailable" would hide usable context and make the outage look like a normal river.
export function floodSnapshotStatus(snapshot, nowMs = Date.now()) {
  const status = effectiveStatus(snapshot, freshness.flood.maxCheckAgeMs, nowMs);
  if (status === 'UNAVAILABLE' && snapshot?.data?.readings?.length) return 'STALE';
  return status;
}

export async function loadFloodSnapshot(nowMs = Date.now()) {
  const row = (await loadSnapshots(PROVIDER, PRODUCT, ['bd'])).get('bd') ?? null;
  if (!row) return { snapshot: null, status: 'UNAVAILABLE', data: null };
  return { snapshot: row, status: floodSnapshotStatus(row, nowMs), data: row.data ?? null };
}

// Fetch and normalise one bundle. `observed` is the only mandatory call: without a current reading there is nothing to say. Rainfall
// and the station registry enrich the card; a failure there makes a PARTIAL snapshot, not a lost warning.
export async function refreshFloodData({ fetchImpl, nowMs = Date.now(), log = () => {} } = {}) {
  if (!ffwcConfigured()) return { status: 'UNAVAILABLE', reason: 'not-configured', data: null };

  const [stationsResult, observedResult, updateResult, rainfallResult, threeDayResult] = await Promise.allSettled([
    fetchStations({ fetchImpl }),
    fetchObserved({ fetchImpl }),
    fetchUpdateDate({ fetchImpl }),
    fetchObservedRainfall({ fetchImpl }),
    fetchThreeDayRainfall({ fetchImpl }),
  ]);

  if (observedResult.status === 'rejected') {
    const error = observedResult.reason;
    await saveSnapshot({
      provider: PROVIDER,
      product: PRODUCT,
      queryKey: 'bd',
      status: 'UNAVAILABLE',
      httpStatus: error?.httpStatus ?? null,
      errorClass: error?.errorClass ?? 'observed',
      message: error?.message ?? 'FFWC observation failed.',
      now: new Date(nowMs),
    });
    log({ provider: PROVIDER, product: PRODUCT, error: error?.message ?? 'observed failed' });
    return { status: 'UNAVAILABLE', reason: 'observed', error };
  }

  const stations = stationsResult.status === 'fulfilled' && Array.isArray(stationsResult.value) ? stationsResult.value : [];
  const observed = Array.isArray(observedResult.value) ? observedResult.value : [];
  // An empty successful response is a feed failure, not a country with no rivers. Keeping the previous snapshot is safer than
  // overwriting a live warning with "no gauges" and silently letting every flood event expire.
  if (!observed.length) {
    const error = new Error('FFWC returned no observed river readings.');
    await saveSnapshot({
      provider: PROVIDER,
      product: PRODUCT,
      queryKey: 'bd',
      status: 'UNAVAILABLE',
      errorClass: 'observed-empty',
      message: error.message,
      now: new Date(nowMs),
    });
    log({ provider: PROVIDER, product: PRODUCT, error: error.message });
    return { status: 'UNAVAILABLE', reason: 'observed-empty', error };
  }
  const rainfall = rainfallResult.status === 'fulfilled' && Array.isArray(rainfallResult.value) ? rainfallResult.value : [];
  const threeDayRainfall = threeDayResult.status === 'fulfilled' && threeDayResult.value && typeof threeDayResult.value === 'object' ? threeDayResult.value : {};
  const update = updateResult.status === 'fulfilled' ? updateResult.value : null;
  const partial = stationsResult.status === 'rejected'
    || rainfallResult.status === 'rejected'
    || updateResult.status === 'rejected';

  const { readings, unmatched } = buildFloodReadings({ stations, observed, rainfall, threeDayRainfall });
  const groups = groupFloodReadings(readings);
  const parsedIssuedAt = Date.parse(update?.entry_date);
  const issuedAt = Number.isFinite(parsedIssuedAt) ? new Date(parsedIssuedAt) : new Date(nowMs);
  const data = {
    updateDate: update?.last_update_date ?? null,
    issuedAt: issuedAt.toISOString(),
    stationsFetched: stations.length,
    observedFetched: observed.length,
    rainfallFetched: rainfall.length,
    readings,
    groups,
    unmatched,
  };

  const saved = await saveSnapshot({
    provider: PROVIDER,
    product: PRODUCT,
    queryKey: 'bd',
    scope: { sourceUrl: PUBLIC_URL, product: 'observed' },
    status: partial ? 'PARTIAL' : 'FRESH',
    data,
    issuedAt,
    validFrom: issuedAt,
    validTo: new Date(nowMs + hazardRules.RIVER_FLOOD.validityHours * HOUR),
    httpStatus: 200,
    errorClass: partial ? 'partial' : null,
    message: partial ? 'One optional FFWC feed was unavailable.' : null,
    now: new Date(nowMs),
  });

  // Shelters are cached for a day independently; a DDM outage never turns the gauge reading into a failed refresh.
  if (env.flood.sheltersEnabled) await refreshFloodShelters({ fetchImpl, nowMs, log });

  log({
    provider: PROVIDER,
    product: PRODUCT,
    stations: readings.length,
    groupedAreas: groups.filter((group) => group.level > 0).length,
    unmatched: unmatched.length,
    status: partial ? 'PARTIAL' : 'FRESH',
  });
  return { status: saved.status, data, snapshot: saved };
}

const ruleFor = (level) => ({ key: `RIVER_FLOOD.L${level}`, version: RULE_VERSION, status: RULE_STATUS });
export const sameCoverage = (event, group) => event.coverage?.scope === group.scope && (group.scope === 'upazila'
  ? event.coverage?.upazilaPcodes?.includes(group.upazilaPcode)
  : event.coverage?.districtPcodes?.includes(group.districtPcode));

// The bundle can be fresh while one gauge's last reading is not. Treat an old or undated reading as STALE for that area only.
function readingFresh(group, nowMs) {
  const measured = group?.lead?.wlAt ? Date.parse(group.lead.wlAt) : Number.NaN;
  return Number.isFinite(measured) && nowMs - measured <= freshness.flood.maxCheckAgeMs;
}

const stationEvidence = (group) => group.stations.map((station) => ({
  name: station.stationName,
  river: station.river,
  waterLevelM: station.waterLevelM,
  dangerLevelM: station.dangerLevelM,
  aboveDangerM: station.aboveDangerM,
  measuredAt: station.wlAt,
  distanceFromAreaKm: station.area?.distanceKm ?? null,
}));

function sheltersFor(group, shelters) {
  return nearestShelters(shelters, group.lat, group.lon);
}

function evidenceFor({ group, shelters, shelterStatus, dataStatus }) {
  const lead = group.lead;
  return {
    metrics: {
      waterLevelM: lead.waterLevelM,
      dangerLevelM: lead.dangerLevelM,
      aboveDangerM: lead.aboveDangerM,
      rainfall24hMm: lead.rainfall24hMm,
      rainfall3dMm: lead.rainfall3dMm,
      rainfallMonthMm: lead.rainfallMonthMm,
      normalRainfallMm: lead.normalRainfallMm,
    },
    area: {
      name: group.name,
      nameBn: group.nameBn,
      scope: group.scope,
      upazilaPcode: group.upazilaPcode,
      districtPcode: group.districtPcode,
      matchMethod: group.matchMethod,
    },
    stations: stationEvidence(group),
    shelters,
    shelterStatus,
    dataStatus,
    observedAt: lead.wlAt,
    validityAssumed: false,
    rule: ruleFor(group.level),
    // The danger level is FFWC's; the half-metre "approaching" band is ours and is named as such on the card.
    asserted: group.classification === 'APPROACHING' ? 'approaching_danger_level' : 'at_or_above_danger_level',
  };
}

// Create or refresh one area's event. A STALE/UNAVAILABLE source may only update the data-status flag on an event that already exists;
// it can never create or raise one.
async function upsertFloodEvent({ group, dataStatus, snapshot, shelters, shelterStatus, nowMs, settings }) {
  const now = new Date(nowMs);
  const blocked = BLOCKING.has(dataStatus);
  const rules = hazardRules.RIVER_FLOOD;
  const validUntil = new Date(nowMs + rules.validityHours * HOUR);
  const validFrom = snapshot?.fetchedAt ? new Date(snapshot.fetchedAt) : now;
  const evidence = evidenceFor({ group, shelters, shelterStatus, dataStatus });

  const existing = await HazardEvent.findOne({
    hazardType: 'RIVER_FLOOD',
    origin: 'detected',
    lifecycle: 'active',
    'coverage.scope': group.scope,
    ...(group.scope === 'upazila' ? { 'coverage.upazilaPcodes': group.upazilaPcode } : { 'coverage.districtPcodes': group.districtPcode }),
  }).sort({ firstDetectedAt: 1 });

  if (existing) {
    if (blocked) {
      if (existing.dataStatus !== dataStatus) {
        existing.dataStatus = dataStatus;
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        await existing.save();
        return { event: existing, created: false, material: true, blocked: true };
      }
      return { event: existing, created: false, material: false, blocked: true };
    }

    const material = existing.level !== group.level
      || existing.dataStatus !== dataStatus
      || Math.abs(+existing.validUntil - +validUntil) > notifyRules.materialValidityExtensionMs
      || (() => {
        const before = existing.evidence?.metrics;
        const after = evidence.metrics;
        return Object.keys(after).some((key) => Number.isFinite(after[key]) && Number.isFinite(before?.[key])
          && Math.abs(after[key] - before[key]) / Math.max(Math.abs(before[key]), 1) >= notifyRules.materialMetricChange);
      })();

    existing.level = group.level;
    existing.evidence = evidence;
    existing.source = { provider: PROVIDER, product: 'observed', url: PUBLIC_URL, referenceId: null };
    existing.dataStatus = dataStatus;
    existing.validFrom = +existing.validFrom < +now ? existing.validFrom : validFrom;
    existing.validUntil = validUntil;
    existing.forecastIssuedAt = snapshot?.issuedAt ? new Date(snapshot.issuedAt) : existing.forecastIssuedAt;
    existing.lastConfirmedAt = now;
    if (material) {
      existing.lastUpdatedAt = now;
      existing.revision += 1;
    }
    await existing.save();
    return { event: existing, created: false, material };
  }

  if (blocked || settings?.hazardEnabled?.RIVER_FLOOD === false) return null;

  const doc = {
    eventKey: `ffwc:river:${group.scope}:${group.scope === 'upazila' ? group.upazilaPcode : group.districtPcode}:${now.toISOString()}`,
    hazardType: 'RIVER_FLOOD',
    origin: 'detected',
    source: { provider: PROVIDER, product: 'observed', url: PUBLIC_URL, referenceId: null },
    coverage: {
      scope: group.scope,
      upazilaPcodes: group.scope === 'upazila' ? [group.upazilaPcode] : [],
      districtPcodes: [group.districtPcode],
      marineZone: null,
      matchMethod: group.matchMethod,
    },
    level: group.level,
    evidence,
    validFrom,
    validUntil,
    forecastIssuedAt: snapshot?.issuedAt ? new Date(snapshot.issuedAt) : null,
    lifecycle: 'active',
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
    revision: 1,
    dataStatus,
  };

  try {
    return { event: await HazardEvent.create(doc), created: true, material: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { event: await HazardEvent.findOne({ eventKey: doc.eventKey }), created: false, material: false };
  }
}

// Stage 1 for flood: reads only the cached snapshot. Existing active events in areas whose gauge is now back in the normal band are
// withdrawn by the system with a note that this is not an all-clear. Missing gauges are left alone (not evidence that the river fell).
export async function floodStage({ nowMs = Date.now(), settings, stats, log = () => {} } = {}) {
  if (!env.flood.enabled || !env.flood.apiKey) return;
  if (settings?.hazardEnabled?.RIVER_FLOOD === false) return;
  const { snapshot, status, data } = await loadFloodSnapshot(nowMs);
  if (!data) return;

  const shelterRow = env.flood.sheltersEnabled ? await loadShelterSnapshot() : null;
  const shelterStatus = shelterSnapshotStatus(shelterRow, nowMs);
  const shelters = shelterRow?.data?.shelters ?? [];
  const alerting = data.groups.filter((group) => group.level > 0);

  for (const group of alerting) {
    const matchedShelters = sheltersFor(group, shelters);
    const groupStatus = readingFresh(group, nowMs) ? status : 'STALE';
    const result = await upsertFloodEvent({
      group, dataStatus: groupStatus, snapshot, shelters: matchedShelters, shelterStatus, nowMs, settings,
    });
    if (!result) {
      stats.blocked += 1;
      continue;
    }
    if (result.blocked) stats.blocked += 1;
    if (result.created) stats.eventsCreated += 1;
    else if (result.material) stats.eventsUpdated += 1;
  }

  // Only a fresh snapshot may withdraw: a dead feed is not a receding river.
  if (status === 'FRESH' || status === 'PARTIAL') {
    const normalGroups = data.groups.filter((group) => group.level === 0 && readingFresh(group, nowMs));
    if (normalGroups.length) {
      const active = await HazardEvent.find({ hazardType: 'RIVER_FLOOD', origin: 'detected', lifecycle: 'active', validUntil: { $gt: new Date(nowMs) } });
      for (const event of active) {
        if (!normalGroups.some((group) => sameCoverage(event, group))) continue;
        await withdrawEvent(event, { source: 'system', reason: 'river-below-approaching-band', nowMs });
        log({ provider: PROVIDER, product: PRODUCT, withdrew: event.eventKey, reason: 'river-below-approaching-band' });
      }
    }
  }

  if (stats && 'floodAreas' in stats) stats.floodAreas = alerting.length;
  if (stats && 'floodStations' in stats) stats.floodStations = data.readings.length;
}

// Nearest DDM shelters for a point; used by the API when the UI asks for a station rather than a whole event.
export function sheltersNear(lat, lon, shelters) {
  return nearestShelters(shelters, lat, lon);
}

// A short list for the public "how close is the gauge" panel: three nearest mapped gauges to a district, not an alert decision.
export function nearestGauges(data, lat, lon, limit = 3) {
  if (!data || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return [...(data.readings ?? [])]
    .map((reading) => ({ ...reading, distanceKm: round1(haversineKm(lat, lon, reading.area.lat, reading.area.lon)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
