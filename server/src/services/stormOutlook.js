import mongoose from 'mongoose';
import { hazardRules } from '../config/alertRules.js';
import { StormSnapshot } from '../models/StormSnapshot.js';
import { getStorms } from './stormTracking.js';

// What the storm tracker's newest satellite image means for some upazilas, counted from NOW. The image is minutes old (about 15 from
// NOAA, 45-60 from GIBS), so a cell that "reaches X in 30 minutes" on the image may reach it 15 minutes from now, or already have.
// Used by the alert engine (storm-approach warnings, the lightning gate) and the Telegram bot (/thunderstorm). Never an all-clear:
// a place no cell is heading for is only "nothing tracked on this image".
const MINUTE = 60_000;

// The newest snapshot: the stored one (any process may have analysed it) or this process's own, whichever is newer. null without either.
export async function latestStormSnapshot() {
  let stored = null;
  if (mongoose.connection.readyState === 1) {
    stored = await StormSnapshot.findOne({}, { observedAt: 1, cells: 1 }).sort({ observedAt: -1 }).lean().catch(() => null);
  }
  const live = getStorms().live;
  const liveMs = live?.observedAt ? Date.parse(live.observedAt) : -Infinity;
  const storedMs = stored ? +new Date(stored.observedAt) : -Infinity;
  if (live && liveMs >= storedMs) return { observedAtMs: liveMs, cells: live.cells ?? [] };
  return stored ? { observedAtMs: storedMs, cells: stored.cells ?? [] } : null;
}

// FRESH while the image is recent enough to warn from, STALE after that, UNAVAILABLE without an image.
export function stormDataStatus(snapshot, nowMs, maxAgeMinutes = hazardRules.STORM_APPROACH.maxImageAgeMinutes) {
  if (!snapshot || !Number.isFinite(snapshot.observedAtMs)) return 'UNAVAILABLE';
  return nowMs - snapshot.observedAtMs <= maxAgeMinutes * MINUTE ? 'FRESH' : 'STALE';
}

// For each pcode, the cell (passing `accept`) that reaches it soonest: Map(pcode -> { cell, etaMin, arrivalMs, minutesFromNow, over }).
// `over` = the cell already covered the place on the image (etaMin 0); otherwise arrivalMs is the image time plus the cell's travel time.
export function stormReach(snapshot, pcodes, nowMs, accept = () => true) {
  const wanted = new Set(pcodes);
  const out = new Map();
  if (!snapshot) return out;
  for (const cell of snapshot.cells ?? []) {
    if (!accept(cell)) continue;
    for (const place of cell.reaches ?? []) {
      if (!wanted.has(place.pcode)) continue;
      const arrivalMs = snapshot.observedAtMs + place.etaMin * MINUTE;
      const before = out.get(place.pcode);
      if (before && before.arrivalMs <= arrivalMs) continue;
      out.set(place.pcode, {
        cell, etaMin: place.etaMin, arrivalMs, minutesFromNow: Math.round((arrivalMs - nowMs) / MINUTE), over: place.etaMin === 0,
      });
    }
  }
  return out;
}

// The rule's cells: cold enough, not weakening, and moving (a cell without measured motion only ever reports the places under it).
export function warnableCell(cell, rules = hazardRules.STORM_APPROACH) {
  return (cell.intensity ?? 0) >= rules.minIntensity && cell.trend !== 'weakening' && Boolean(cell.motion);
}

// The rule's window: a cell that was NOT over the place on the image and arrives between `lateMinutes` ago and `horizonMinutes` from now.
export function approaching(hit, rules = hazardRules.STORM_APPROACH) {
  return Boolean(hit) && !hit.over && hit.minutesFromNow >= -rules.lateMinutes && hit.minutesFromNow <= rules.horizonMinutes;
}

// The places the storm-approach rule would warn at `nowMs`, for the map's arrival shading: [{ pcode, arrivalAt, minutesFromNow, soon }],
// soonest first. The same cells, window and "counted from now" as the alert stage, so the map shades exactly who would be warned.
export function stormArrivals(snapshot, nowMs, rules = hazardRules.STORM_APPROACH) {
  if (stormDataStatus(snapshot, nowMs) !== 'FRESH') return [];
  const pcodes = new Set((snapshot.cells ?? []).flatMap((cell) => (cell.reaches ?? []).map((place) => place.pcode)));
  return [...stormReach(snapshot, pcodes, nowMs, warnableCell)]
    .filter(([, hit]) => approaching(hit, rules))
    .map(([pcode, hit]) => ({
      pcode, arrivalAt: new Date(hit.arrivalMs).toISOString(), minutesFromNow: hit.minutesFromNow, soon: hit.minutesFromNow <= rules.soonMinutes,
    }))
    .sort((a, b) => a.minutesFromNow - b.minutesFromNow);
}

// A snapshot as the API sends it ({ observedAt: ISO, cells }) with its arrivals at `nowMs` and that reference time.
export function withArrivals(snapshot, nowMs) {
  if (!snapshot?.observedAt) return snapshot;
  const arrivals = stormArrivals({ observedAtMs: Date.parse(snapshot.observedAt), cells: snapshot.cells }, nowMs);
  return { ...snapshot, arrivalsAt: new Date(nowMs).toISOString(), arrivals };
}

// Any tracked cell over the place or heading there within the horizon: enough to look for real lightning (the lightning gate).
export function stormNear(hit, rules = hazardRules.STORM_APPROACH) {
  return Boolean(hit) && (hit.over || hit.minutesFromNow <= rules.horizonMinutes);
}
