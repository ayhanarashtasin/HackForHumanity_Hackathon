import { RULE_STATUS, RULE_VERSION, freshness, hazardRules } from '../../config/alertRules.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import { locationByPcode } from '../geo.js';
import { loadGeoData } from '../lightningCampaign.js';
import { haversineKm } from '../time.js';
import { threatAt } from '../xweatherLightning.js';
import { circlesCovering } from './lightningGate.js';
import { effectiveLightningStatus, effectiveStatus, loadSnapshots } from './snapshots.js';

// A lightning EPISODE is one hazard event per area, made of observed strikes and threat polygons together (ALERT_ENGINE_PLAN.md 10.1 and 11.2).
// It opens at the first covering threat period or the first strike near the area, later strikes and threat periods only update its evidence, and it
// closes 30 minutes after the last strike when no threat period is still ahead. One notification per subscriber per episode keeps lightning
// CRITICAL without alarm fatigue; the re-notification stages below are the only repeats.
const MINUTE = 60_000;
const MAX_STRIKE_IDS = 50;
const LIGHTNING_TYPES = ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'];
const rule = (key) => ({ key, version: RULE_VERSION, status: RULE_STATUS });

// Pure: the next state of one area's episode from its previous evidence, the strikes and the threats now known. Returns null when there is nothing.
export function episodeState({
  area, strikes, threats, previous = null, nowMs,
}) {
  const params = hazardRules.OBSERVED_LIGHTNING;
  const threatParams = hazardRules.LIGHTNING_THREAT;
  const closeAfterMs = params.episodeCloseMinutes * MINUTE;

  // Strikes older than the close window belong to an episode that already ended.
  const recent = strikes
    .filter((strike) => nowMs - strike.at <= closeAfterMs)
    .map((strike) => ({ ...strike, distanceKm: haversineKm(area.lat, area.lon, strike.lat, strike.lon) }));
  const near = recent.filter((strike) => strike.distanceKm <= params.nearKm);

  const before = previous?.observed ?? { strikeIds: [], count: 0, nearestKm: null, firstStrikeAtMs: null, lastStrikeAtMs: null, closeCount: 0 };
  const known = new Set(before.strikeIds ?? []);
  const fresh = near.filter((strike) => !known.has(strike.id));
  const strikeIds = [...known, ...fresh.map((strike) => strike.id)].slice(-MAX_STRIKE_IDS);
  const count = (before.count ?? 0) + fresh.length;
  const distances = [before.nearestKm, ...near.map((strike) => strike.distanceKm)].filter((value) => value !== null && value !== undefined);
  const nearestKm = distances.length ? Math.min(...distances) : null;
  const lastStrikeAtMs = Math.max(before.lastStrikeAtMs ?? 0, ...near.map((strike) => strike.at)) || null;
  const firstStrikeAtMs = Math.min(before.firstStrikeAtMs ?? Infinity, ...near.map((strike) => strike.at));
  const closeCount = (before.closeCount ?? 0) + fresh.filter((strike) => strike.distanceKm <= params.closeKm).length;

  const observed = count > 0 && nearestKm !== null
    ? {
      count,
      nearestKm: Math.round(nearestKm * 10) / 10,
      strikeIds,
      firstStrikeAtMs: Number.isFinite(firstStrikeAtMs) ? firstStrikeAtMs : null,
      lastStrikeAtMs,
      closeCount,
      // The provider's id of the first strike: the episode's stable reference.
      firstStrikeId: before.firstStrikeId ?? strikeIds[0],
    }
    : null;

  const threat = threatAt(threats, area.lon, area.lat, nowMs, threatParams.horizonMinutes * MINUTE);
  if (!observed && !threat) return null;

  const minutesAhead = threat ? Math.max(0, Math.round((threat.startMs - nowMs) / MINUTE)) : null;
  const observedLevel = observed ? (observed.nearestKm <= params.closeKm || observed.count >= params.manyStrikes ? 3 : 2) : 0;
  const threatLevel = threat ? (minutesAhead <= threatParams.imminentMinutes ? 3 : 2) : 0;
  const level = Math.max(observedLevel, threatLevel);

  const startMs = previous?.startMs ?? Math.min(observed?.firstStrikeAtMs ?? Infinity, threat?.startMs ?? Infinity, nowMs);
  const untilMs = Math.max(observed ? observed.lastStrikeAtMs + closeAfterMs : 0, threat ? threat.endMs : 0);
  const began = previous?.began ?? (observed ? 'observed' : 'threat');

  // The only two reasons to put the card back to unread, each at most once and only after the first notice.
  const notified = { threatToStrike: previous?.notified?.threatToStrike ?? false, close: previous?.notified?.close ?? false };
  if (previous) {
    if (!notified.threatToStrike && previous.began === 'threat' && observed) notified.threatToStrike = true;
    if (!notified.close && observed && (previous.observed?.closeCount ?? 0) === 0 && observed.closeCount > 0) notified.close = true;
  }
  const renotifyStage = (notified.threatToStrike ? 1 : 0) + (notified.close ? 1 : 0);

  return {
    hazardType: observed ? 'OBSERVED_LIGHTNING' : 'LIGHTNING_THREAT',
    level,
    startMs,
    untilMs,
    evidence: {
      metrics: {
        nearestKm: observed?.nearestKm ?? null,
        count: observed?.count ?? 0,
        lastStrikeAtMs: observed?.lastStrikeAtMs ?? null,
        threatMinutes: minutesAhead,
      },
      observed,
      threat: threat ? { startMs: threat.startMs, endMs: threat.endMs, minutesAhead } : null,
      began,
      notified,
      renotifyStage,
      startMs,
      agreement: 'single-source',
      coverage: 'regional',
      rule: rule(observed ? (level >= 3 ? 'OBSERVED_LIGHTNING.L3' : 'OBSERVED_LIGHTNING.L2') : (level >= 3 ? 'LIGHTNING_THREAT.L3' : 'LIGHTNING_THREAT.L2')),
    },
  };
}

// Whether the engine is still WATCHING an area: a fresh probe (even a quiet one) means no lightning matched in its window, so an open
// episode keeps its data status; no fresh probe means the source is stale or unavailable and the card says so.
function watching(statuses) {
  if (statuses.some((status) => ['FRESH', 'NO_MATCH'].includes(status))) return 'FRESH';
  return statuses.includes('STALE') ? 'STALE' : 'UNAVAILABLE';
}

// ---------- the engine stage ----------
export async function lightningStage({
  nowMs, settings, stats, areas,
}) {
  if (!LIGHTNING_TYPES.some((type) => settings.hazardEnabled?.[type] !== false) || !areas.length) return;

  const geo = loadGeoData();
  const circleIds = new Map();
  for (const pcode of areas) {
    const location = locationByPcode.get(pcode);
    if (location) circleIds.set(pcode, circlesCovering(geo, location).map((circle) => circle.id));
  }
  const keys = [...new Set([...circleIds.values()].flat())].map((id) => `c:${id}`);
  if (!keys.length) return;

  const [probeRows, strikeRows, threatRows] = await Promise.all([
    loadSnapshots('xweather', 'lightning-summary', keys),
    loadSnapshots('xweather', 'lightning-strikes', keys),
    loadSnapshots('xweather', 'lightning-threats', keys),
  ]);
  const threatStatus = (row) => (row ? effectiveStatus({ ...row, data: row.data ?? {} }, freshness.lightningThreat.maxCheckAgeMs, nowMs) : 'UNAVAILABLE');
  const now = new Date(nowMs);

  for (const pcode of areas) {
    const location = locationByPcode.get(pcode);
    const ids = circleIds.get(pcode) ?? [];
    if (!location || !ids.length) continue;
    const area = { pcode, lat: location.lat, lon: location.lon };

    const strikes = new Map();
    const threats = [];
    for (const id of ids) {
      const strikeRow = strikeRows.get(`c:${id}`);
      if (strikeRow && ['FRESH', 'NO_MATCH'].includes(effectiveLightningStatus(strikeRow, nowMs))) {
        for (const strike of strikeRow.data?.strikes ?? []) strikes.set(strike.id, strike);
      }
      const threatRow = threatRows.get(`c:${id}`);
      if (threatRow && ['FRESH', 'PARTIAL'].includes(threatStatus(threatRow))) threats.push(...(threatRow.data?.threats ?? []));
    }

    const existing = await HazardEvent.findOne({
      origin: 'detected', lifecycle: 'active', eventKey: /^ltg:/, 'coverage.upazilaPcodes': pcode, validUntil: { $gt: now },
    });
    const state = episodeState({ area, strikes: [...strikes.values()], threats, previous: existing ? existing.evidence : null, nowMs });
    const dataStatus = watching(ids.map((id) => effectiveLightningStatus(probeRows.get(`c:${id}`), nowMs)));

    if (!state) {
      // Nothing now. An open episode is left alone: it ends by time (30 minutes after the last strike), never as an "all-clear".
      if (existing && existing.dataStatus !== dataStatus) {
        existing.dataStatus = dataStatus;
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        await existing.save();
        stats.eventsUpdated += 1;
      }
      continue;
    }

    if (existing) {
      // A source that is no longer fresh cannot move an open episode: it keeps its last level and says its data is stale.
      if (dataStatus !== 'FRESH') {
        if (existing.dataStatus !== dataStatus) {
          existing.dataStatus = dataStatus;
          existing.lastUpdatedAt = now;
          existing.revision += 1;
          await existing.save();
        }
        continue;
      }
      const changed = existing.hazardType !== state.hazardType || existing.level !== state.level
        || (existing.evidence.renotifyStage ?? 0) !== state.evidence.renotifyStage || (existing.evidence.metrics?.count ?? 0) !== state.evidence.metrics.count;
      existing.hazardType = state.hazardType;
      existing.level = state.level;
      existing.evidence = state.evidence;
      existing.validFrom = new Date(state.startMs);
      existing.validUntil = new Date(state.untilMs);
      existing.observedAt = state.evidence.observed ? new Date(state.evidence.observed.lastStrikeAtMs) : null;
      // An episode that opened as a threat gets the provider's id of its first strike as soon as there is one.
      if (!existing.source?.referenceId && state.evidence.observed?.firstStrikeId) existing.set('source.referenceId', state.evidence.observed.firstStrikeId);
      existing.dataStatus = dataStatus;
      existing.lastConfirmedAt = now;
      if (changed) {
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        stats.eventsUpdated += 1;
      }
      await existing.save();
      continue;
    }

    if (dataStatus !== 'FRESH') { stats.blocked += 1; continue; }
    try {
      await HazardEvent.create({
        eventKey: `ltg:${pcode}:${new Date(state.startMs).toISOString()}`,
        hazardType: state.hazardType,
        origin: 'detected',
        source: { provider: 'xweather', product: 'lightning', referenceId: state.evidence.observed?.firstStrikeId ?? null },
        coverage: { scope: 'upazila', upazilaPcodes: [pcode], districtPcodes: [], marineZone: null, matchMethod: 'representative_point' },
        level: state.level,
        evidence: state.evidence,
        validFrom: new Date(state.startMs),
        validUntil: new Date(state.untilMs),
        observedAt: state.evidence.observed ? new Date(state.evidence.observed.lastStrikeAtMs) : null,
        lifecycle: 'active',
        firstDetectedAt: now,
        lastConfirmedAt: now,
        lastUpdatedAt: now,
        revision: 1,
        dataStatus,
      });
      stats.eventsCreated += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
}
