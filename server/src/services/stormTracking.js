import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { StormSnapshot } from '../models/StormSnapshot.js';
import { getSatelliteFrames } from './satellite.js';

// Experimental storm movement from Himawari-9 infrared frames: ml-service (storm/tracker.py) finds the cold thunderstorm tops, how
// they move and which upazilas they may reach in 30-90 minutes. The map shows it; the alert engine reads the stored snapshots for
// storm-approach warnings (stormOutlook.js, alerts/stormEpisodes.js). Without the ML service (ML_SERVICE_URL empty or not running)
// the map simply has no storm layer and no storm warning is made.
const KEEP_DAYS = 30;
const DEMO_IMAGE = /^\d{4}-\d{2}-\d{2}T\d{6}Z\.png$/;
const FRAME_MS = 10 * 60_000;
const CATCH_UP = 6; // frames analysed in one run at most, when the job has fallen behind

// `next` is the frame time (ms) to ask for next.
const state = { live: null, checkedAt: null, error: null, next: null };
let demo = null;

const serviceUrl = () => env.alerts.mlServiceUrl;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

// Analyses every new satellite frame. Himawari takes a frame every 10 minutes; the ML service reads it from NOAA's raw data about
// 15 minutes later (or, with STORM_SOURCE=gibs, from NASA GIBS 45-60 minutes later), while the map's satellite list is only
// refreshed every SATELLITE_MINUTES (30 by default). So the job asks for the frame after the last one it analysed, and a frame is
// picked up within STORM_MINUTES of being published. It starts at the newest listed frame (or 30 minutes ago without a list), and
// jumps to the listed frame when the list is ahead (after an outage).
export async function refreshStorms({ fetchImpl = fetch, frameTime = getSatelliteFrames().layers?.ir?.frames?.at(-1), now = Date.now() } = {}) {
  if (!serviceUrl()) return null;
  const listed = frameTime ? Date.parse(frameTime) : NaN;
  let next = state.next ?? (Number.isFinite(listed) ? listed : Math.floor(now / FRAME_MS) * FRAME_MS - 3 * FRAME_MS);
  if (listed > next) next = listed;

  try {
    // A frame that is not published yet is asked for again on the next run; one more frame ahead is tried too, so a frame the
    // satellite skipped does not stop the job until the list moves on.
    let analysed = 0;
    let misses = 0;
    while (analysed < CATCH_UP && misses < 2 && next <= now) {
      const snapshot = await analyse(fetchImpl, iso(next));
      if (snapshot) {
        analysed += 1;
        misses = 0;
        state.live = snapshot;
        state.next = next + FRAME_MS;
        await keep(snapshot, now);
      } else {
        misses += 1;
      }
      next += FRAME_MS;
    }
    state.checkedAt = new Date(now);
    state.error = null;
    return state.live;
  } catch (error) {
    // The previous snapshot stays on the map with its own observation time; the error is shown next to it. The job runs every few
    // minutes, so only a new error is thrown (and logged); a repeat stays visible in GET /api/storms.
    const message = String(error?.message ?? error).slice(0, 160);
    const repeated = state.error === message;
    state.checkedAt = new Date(now);
    state.error = message;
    if (repeated) return state.live;
    throw error;
  }
}

// One frame's snapshot, or null while its source has not published it (the ML service answers 404).
async function analyse(fetchImpl, frameTime) {
  const response = await fetchImpl(`${serviceUrl()}/storms/snapshot?time=${encodeURIComponent(frameTime)}`, { signal: AbortSignal.timeout(90_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storm tracker HTTP ${response.status}`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot?.cells) || !snapshot.observedAt) throw new Error('storm tracker returned an unexpected response');
  // An older ML service answers a missing frame with the frame before it: that is not this frame.
  return snapshot.observedAt === frameTime ? snapshot : null;
}

async function keep(snapshot, now) {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await StormSnapshot.updateOne(
      { observedAt: new Date(snapshot.observedAt) },
      { $set: {
        frames: snapshot.frames ?? [], motionMinutes: snapshot.motionMinutes ?? 0, cells: snapshot.cells, assumptions: snapshot.assumptions ?? null,
        fetchedAt: new Date(now), expiresAt: new Date(now + KEEP_DAYS * 86_400_000),
      } },
      { upsert: true },
    );
  } catch (error) {
    console.error(`[storms] could not keep the snapshot: ${String(error?.message ?? error).slice(0, 160)}`);
  }
}

// The live snapshot's picture (ml-service draws it from the frame) is served through this API, like the replay's.
function withImageUrl(snapshot) {
  if (!snapshot) return null;
  const { image, ...rest } = snapshot;
  return { ...rest, image: DEMO_IMAGE.test(image?.name ?? '') ? { url: `/api/storms/image/${image.name}`, bounds: image.bounds } : null };
}

export function getStorms() {
  return {
    enabled: Boolean(serviceUrl()),
    live: withImageUrl(state.live),
    checkedAt: state.checkedAt ? state.checkedAt.toISOString() : null,
    error: state.error,
  };
}

// The saved storm day (2026-09-22) as a replay: one snapshot per 10-minute frame, each with the satellite image the map shows under it.
export async function getStormDemo({ fetchImpl = fetch } = {}) {
  if (demo) return demo;
  if (!serviceUrl()) return null;
  const response = await fetchImpl(`${serviceUrl()}/storms/demo`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`storm tracker HTTP ${response.status}`);
  const data = await response.json();
  demo = {
    ...data,
    snapshots: (data.snapshots ?? []).map((snapshot) => ({
      ...snapshot,
      image: DEMO_IMAGE.test(snapshot.image ?? '') ? `/api/storms/demo/image/${snapshot.image}` : null,
    })),
  };
  return demo;
}

// The picture of an analysed live frame (only frames the ML service has cached; names carry the frame time).
export async function getStormImage(name, { fetchImpl = fetch } = {}) {
  if (!DEMO_IMAGE.test(name) || !serviceUrl()) return null;
  const response = await fetchImpl(`${serviceUrl()}/storms/image/${name}`, { signal: AbortSignal.timeout(30_000) });
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

export async function getStormDemoImage(name, { fetchImpl = fetch } = {}) {
  if (!DEMO_IMAGE.test(name) || !serviceUrl()) return null;
  const response = await fetchImpl(`${serviceUrl()}/storms/demo/${name}`, { signal: AbortSignal.timeout(30_000) });
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

export function resetStormsForTests() {
  Object.assign(state, { live: null, checkedAt: null, error: null, next: null });
  demo = null;
}
