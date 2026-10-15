import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { StormSnapshot } from '../models/StormSnapshot.js';
import { getSatelliteFrames } from './satellite.js';

// Experimental storm movement from Himawari-9 infrared frames: ml-service (storm/tracker.py) finds the cold thunderstorm tops, how
// they move and which upazilas they may reach in 30-90 minutes. Map information only: it never creates, changes or cancels an alert,
// and it says so. Without the ML service (ML_SERVICE_URL empty or not running) the map simply has no storm layer.
const KEEP_DAYS = 30;
const DEMO_IMAGE = /^\d{4}-\d{2}-\d{2}T\d{6}Z\.png$/;

const state = { live: null, checkedAt: null, error: null };
let demo = null;

const serviceUrl = () => env.alerts.mlServiceUrl;

// Analyses the newest satellite frame once. `frameTime` defaults to the newest Himawari frame the satellite job has listed.
export async function refreshStorms({ fetchImpl = fetch, frameTime = getSatelliteFrames().layers?.ir?.frames?.at(-1), now = Date.now() } = {}) {
  if (!serviceUrl() || !frameTime) return null;
  if (state.live?.observedAt === frameTime) {
    state.checkedAt = new Date(now);
    return state.live;
  }

  try {
    const response = await fetchImpl(`${serviceUrl()}/storms/snapshot?time=${encodeURIComponent(frameTime)}`, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`storm tracker HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot?.cells) || !snapshot.observedAt) throw new Error('storm tracker returned an unexpected response');

    state.live = snapshot;
    state.checkedAt = new Date(now);
    state.error = null;
    await keep(snapshot, now);
    return snapshot;
  } catch (error) {
    // The previous snapshot stays on the map with its own observation time; the error is shown next to it.
    state.checkedAt = new Date(now);
    state.error = String(error?.message ?? error).slice(0, 160);
    throw error;
  }
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

export function getStorms() {
  return {
    enabled: Boolean(serviceUrl()),
    live: state.live,
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

export async function getStormDemoImage(name, { fetchImpl = fetch } = {}) {
  if (!DEMO_IMAGE.test(name) || !serviceUrl()) return null;
  const response = await fetchImpl(`${serviceUrl()}/storms/demo/${name}`, { signal: AbortSignal.timeout(30_000) });
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

export function resetStormsForTests() {
  Object.assign(state, { live: null, checkedAt: null, error: null });
  demo = null;
}
