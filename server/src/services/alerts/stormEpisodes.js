import { RULE_STATUS, RULE_VERSION, hazardRules } from '../../config/alertRules.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import {
  approaching, latestStormSnapshot, stormDataStatus, stormReach, warnableCell,
} from '../stormOutlook.js';

// A storm-approach EPISODE is one hazard event per area: a cold, not-weakening thunderstorm cell on the satellite image whose
// straight-line track reaches the area within the next hour, counted from now (hazardRules.STORM_APPROACH). It is a WARNING with
// advice to get under cover before the storm arrives; real lightning near the area still comes from the lightning stage (CRITICAL),
// whose checks this signal opens (lightningGate.js). Like lightning, an episode ends by time and never as an "all-clear": a cell that
// turns away or weakens leaves the open warning alone until it runs out.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const rule = (key) => ({ key, version: RULE_VERSION, status: RULE_STATUS });

// Pure: the next state of one area's episode from the cell reaching it (stormReach) and the previous evidence. null when the area is
// not being approached now (an open episode is then left as it is).
export function stormEpisodeState({ hit, previous = null, nowMs, observedAtMs }) {
  const rules = hazardRules.STORM_APPROACH;
  if (!approaching(hit, rules)) return null;

  const { cell } = hit;
  const level = Math.max(hit.minutesFromNow <= rules.soonMinutes ? 3 : 2, previous?.level ?? 0);
  const startMs = previous?.startMs ?? nowMs;
  const untilMs = Math.max(hit.arrivalMs, nowMs) + rules.passMinutes * MINUTE;
  return {
    level,
    startMs,
    untilMs: Math.max(untilMs, previous?.untilMs ?? 0),
    evidence: {
      // Only slow-moving numbers here: a metric that changes by a quarter rewrites everyone's card (notify.js isMaterial).
      metrics: { arrivalAtMs: hit.arrivalMs, minTempC: Number.isFinite(cell.minTempC) ? cell.minTempC : null },
      storm: {
        observedAtMs,
        intensity: cell.intensity ?? null,
        trend: cell.trend ?? null,
        areaKm2: cell.areaKm2 ?? null,
        speedKmh: cell.motion?.speedKmh ?? null,
        towards: cell.motion?.towards ?? null,
      },
      level,
      startMs,
      untilMs,
      agreement: 'single-source',
      coverage: 'regional',
      rule: rule(level >= 3 ? 'STORM_APPROACH.L3' : 'STORM_APPROACH.L2'),
    },
  };
}

// ---------- the engine stage ----------
export async function stormStage({
  nowMs, settings, stats, areas, snapshot: given,
}) {
  if (settings.hazardEnabled?.STORM_APPROACH === false || !areas.length) return;
  const rules = hazardRules.STORM_APPROACH;
  const snapshot = given === undefined ? await latestStormSnapshot() : given;
  const dataStatus = stormDataStatus(snapshot, nowMs);
  const now = new Date(nowMs);

  const hits = dataStatus === 'FRESH' ? stormReach(snapshot, areas, nowMs, warnableCell) : new Map();
  const [open, recent] = await Promise.all([
    HazardEvent.find({ origin: 'detected', lifecycle: 'active', hazardType: 'STORM_APPROACH', validUntil: { $gt: now }, 'coverage.upazilaPcodes': { $in: areas } }),
    HazardEvent.find(
      { origin: 'detected', hazardType: 'STORM_APPROACH', firstDetectedAt: { $gt: new Date(nowMs - rules.cooldownHours * HOUR) }, 'coverage.upazilaPcodes': { $in: areas } },
      { 'coverage.upazilaPcodes': 1 },
    ).lean(),
  ]);
  const openBy = new Map(open.map((event) => [event.coverage.upazilaPcodes[0], event]));
  const cooling = new Set(recent.flatMap((event) => event.coverage.upazilaPcodes));

  for (const pcode of areas) {
    const existing = openBy.get(pcode) ?? null;
    const state = dataStatus === 'FRESH'
      ? stormEpisodeState({ hit: hits.get(pcode), previous: existing?.evidence ?? null, nowMs, observedAtMs: snapshot.observedAtMs })
      : null;

    if (!state) {
      // Nothing approaching now, or no usable image: an open episode keeps its warning and only says when its data went stale.
      if (existing && dataStatus !== 'FRESH' && existing.dataStatus !== dataStatus) {
        existing.dataStatus = dataStatus;
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        await existing.save();
        stats.eventsUpdated += 1;
      }
      continue;
    }

    if (existing) {
      const changed = existing.level !== state.level || existing.dataStatus !== 'FRESH';
      existing.level = state.level;
      existing.evidence = state.evidence;
      existing.validUntil = new Date(state.untilMs);
      existing.observedAt = new Date(snapshot.observedAtMs);
      existing.dataStatus = 'FRESH';
      existing.lastConfirmedAt = now;
      if (changed) {
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        stats.eventsUpdated += 1;
      }
      await existing.save();
      continue;
    }

    // At most one storm warning per area in cooldownHours: a second cell soon after the first is part of the same stormy spell.
    if (cooling.has(pcode)) { stats.blocked += 1; continue; }
    try {
      await HazardEvent.create({
        eventKey: `stm:${pcode}:${new Date(state.startMs).toISOString()}`,
        hazardType: 'STORM_APPROACH',
        origin: 'detected',
        source: { provider: 'himawari', product: 'storm-tracker', referenceId: new Date(snapshot.observedAtMs).toISOString() },
        coverage: { scope: 'upazila', upazilaPcodes: [pcode], districtPcodes: [], marineZone: null, matchMethod: 'representative_point' },
        level: state.level,
        evidence: state.evidence,
        validFrom: new Date(state.startMs),
        validUntil: new Date(state.untilMs),
        observedAt: new Date(snapshot.observedAtMs),
        lifecycle: 'active',
        firstDetectedAt: now,
        lastConfirmedAt: now,
        lastUpdatedAt: now,
        revision: 1,
        dataStatus: 'FRESH',
      });
      stats.eventsCreated += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
}
