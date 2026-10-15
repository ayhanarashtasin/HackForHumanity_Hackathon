import { env } from '../../config/env.js';
import { locationByPcode } from '../geo.js';
import { loadGeoData } from '../lightningCampaign.js';
import {
  latestStormSnapshot, stormDataStatus, stormNear, stormReach,
} from '../stormOutlook.js';
import { dhakaParts, haversineKm } from '../time.js';
import { fetchStrikes, fetchThreats, probeCircle } from '../xweatherLightning.js';
import { thunderInForecast } from '../xweatherForecast.js';
import { loadForecastInputs, loadSnapshots } from './snapshots.js';
import { loadSources } from './normalize.js';
import { monitoredAreas } from './engine.js';

// Lightning monitoring is gated and tiered so it fits the Xweather allowance (ALERT_ENGINE_PLAN.md section 14.3):
//   Tier 1  summary probe of the 100 km circle (1 token), every 5 minutes while the gate is open, hourly in the daytime baseline
//   Tier 2  one strikes request per positive circle, at most once per 5 minutes; distances to every monitored upazila are computed locally
//   Tier 3  threat polygons (10 tokens), every 10 minutes while the gate is open
// It is NOT continuous monitoring, and the interface says so.
const MINUTE = 60_000;
const PROBE_EVERY = 5 * MINUTE;
const BASELINE_EVERY = 60 * MINUTE;
const THREAT_EVERY = 10 * MINUTE;
const CONTINUE_FOR = 60 * MINUTE;
const THUNDER_WINDOW = 3 * 60 * MINUTE;
const BASELINE_FROM_HOUR = 10;
const BASELINE_TO_HOUR = 22;

export const circlesCovering = (geo, location) => geo.circles.filter((circle) => haversineKm(location.lat, location.lon, circle.lat, circle.lon) <= geo.apiRadiusKm);

// pcode -> circles, for the monitored areas; and circle id -> the pcodes it serves.
export async function monitoredCircles(nowMs = Date.now()) {
  const pcodes = await monitoredAreas(nowMs);
  const geo = loadGeoData();
  const circles = new Map();
  for (const pcode of pcodes) {
    const location = locationByPcode.get(pcode);
    if (!location) continue;
    for (const circle of circlesCovering(geo, location)) {
      if (!circles.has(circle.id)) circles.set(circle.id, { circle, pcodes: [] });
      circles.get(circle.id).pcodes.push(pcode);
    }
  }
  return { geo, circles };
}

// Thunder potential (Open-Meteo `ts`) in the next three hours for any of these areas.
function thunderPotential(sources, pcodes, nowMs) {
  const data = sources.openMeteo?.data;
  if (!data?.steps) return false;
  return pcodes.some((pcode) => {
    const column = data.locations?.[pcode]?.ts;
    return column && data.steps.some((step, i) => {
      const start = Date.parse(step);
      return start < nowMs + THUNDER_WINDOW && start + 3 * 60 * MINUTE > nowMs && (column[i] ?? 0) >= 1;
    });
  });
}

// Pure decision for one circle: should it be probed now, and under which gate? The gate opens for thunder in the forecast, for a storm
// cell on the satellite image over or heading for one of its areas (stormOutlook.js), and for an hour after lightning was seen.
export function decideProbe({
  nowMs, lastProbeAttemptMs, lastPositiveMs, forecastSignal, stormSignal = false, baselineEnabled, localHour,
}) {
  const continuing = lastPositiveMs !== null && nowMs - lastPositiveMs <= CONTINUE_FOR;
  const open = forecastSignal || stormSignal || continuing;
  const since = lastProbeAttemptMs === null ? Infinity : nowMs - lastProbeAttemptMs;

  if (open) return { gate: 'open', due: since >= PROBE_EVERY, reasons: [forecastSignal ? 'thunder-potential' : null, stormSignal ? 'satellite-storm' : null, continuing ? 'recent-lightning' : null].filter(Boolean) };
  const baselineHours = localHour >= BASELINE_FROM_HOUR && localHour < BASELINE_TO_HOUR;
  if (baselineEnabled && baselineHours) return { gate: 'baseline', due: since >= BASELINE_EVERY, reasons: ['daytime-baseline'] };
  return { gate: 'closed', due: false, reasons: [] };
}

// One pass: probe the circles that are due, fetch strikes for positive circles, fetch threats for open ones.
export async function refreshLightning({
  client, budget, nowMs = Date.now(), now = () => new Date(nowMs), log = console,
}) {
  const { geo, circles } = await monitoredCircles(nowMs);
  const summary = { circles: circles.size, probed: 0, strikesFetched: 0, threatsFetched: 0, refused: 0, stoppedBy: null, detail: [] };
  if (!circles.size) return summary;

  const keys = [...circles.keys()].map((id) => `c:${id}`);
  const [probes, strikes, threats] = await Promise.all([
    loadSnapshots('xweather', 'lightning-summary', keys),
    loadSnapshots('xweather', 'lightning-strikes', keys),
    loadSnapshots('xweather', 'lightning-threats', keys),
  ]);
  const sources = loadSources(nowMs);
  const allPcodes = [...new Set([...circles.values()].flatMap((entry) => entry.pcodes))];
  const forecasts = await loadForecastInputs(allPcodes, nowMs);
  const storm = await latestStormSnapshot();
  const stormHits = stormDataStatus(storm, nowMs) === 'FRESH' ? stormReach(storm, allPcodes, nowMs) : new Map();
  const localHour = dhakaParts(new Date(nowMs)).hh;

  // Circles whose gate is already open go first, so a tight budget is spent where lightning is most likely.
  const plans = [...circles.values()].map((entry) => {
    const key = `c:${entry.circle.id}`;
    const probe = probes.get(key);
    const forecastSignal = thunderPotential(sources, entry.pcodes, nowMs)
      || entry.pcodes.some((pcode) => forecasts.get(pcode)?.status === 'FRESH' && thunderInForecast(forecasts.get(pcode).hourly, nowMs, nowMs + THUNDER_WINDOW));
    const positive = probe?.scope?.lastPositiveAt ? Date.parse(probe.scope.lastPositiveAt) : null;
    const decision = decideProbe({
      nowMs,
      lastProbeAttemptMs: probe ? +new Date(probe.attemptedAt ?? probe.fetchedAt) : null,
      lastPositiveMs: positive,
      forecastSignal,
      stormSignal: entry.pcodes.some((pcode) => stormNear(stormHits.get(pcode))),
      baselineEnabled: env.alerts.lightningBaseline,
      localHour,
    });
    return { entry, key, decision, probe };
  }).sort((a, b) => (b.decision.gate === 'open') - (a.decision.gate === 'open'));

  for (const plan of plans) {
    const { entry, key, decision } = plan;
    const line = { circle: entry.circle.id, gate: decision.gate, reasons: decision.reasons, probe: null, strikes: null, threats: null };
    summary.detail.push(line);
    if (summary.stoppedBy) break;

    let positive = false;
    if (decision.due) {
      const probe = await probeCircle({ client, budget, circle: entry.circle, radiusKm: geo.apiRadiusKm, gate: decision.gate, previous: plan.probe, now });
      if (probe.refused) { summary.refused += 1; line.probe = `refused:${probe.refused}`; continue; }
      summary.probed += 1;
      line.probe = probe.status;
      if (probe.stopped) { summary.stoppedBy = probe.stopped; log.error?.(`[alerts] Xweather lightning probe stopped: ${probe.stopped}`); break; }
      positive = probe.positive;
    }

    // Tier 2: only when this very probe saw something, or a positive circle has not had its strikes looked at in the last five minutes.
    const lastStrikes = strikes.get(key);
    const strikesStale = !lastStrikes || nowMs - +new Date(lastStrikes.attemptedAt ?? lastStrikes.fetchedAt) >= PROBE_EVERY;
    if (positive && strikesStale) {
      const fetched = await fetchStrikes({ client, budget, circle: entry.circle, radiusKm: geo.apiRadiusKm, now });
      if (fetched.refused) { summary.refused += 1; line.strikes = `refused:${fetched.refused}`; } else {
        summary.strikesFetched += 1;
        line.strikes = fetched.status;
        if (fetched.stopped) { summary.stoppedBy = fetched.stopped; break; }
      }
    }

    // Tier 3: threat polygons while the gate is open.
    const lastThreats = threats.get(key);
    const threatsDue = !lastThreats || nowMs - +new Date(lastThreats.attemptedAt ?? lastThreats.fetchedAt) >= THREAT_EVERY;
    if (decision.gate === 'open' && threatsDue) {
      const fetched = await fetchThreats({ client, budget, circle: entry.circle, radiusKm: geo.apiRadiusKm, now });
      if (fetched.refused) { summary.refused += 1; line.threats = `refused:${fetched.refused}`; } else {
        summary.threatsFetched += 1;
        line.threats = fetched.status;
        if (fetched.stopped) { summary.stoppedBy = fetched.stopped; break; }
      }
    }
  }
  return summary;
}
