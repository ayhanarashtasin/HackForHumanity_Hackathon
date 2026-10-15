import { withArrivals } from '../services/stormOutlook.js';
import {
  getStormDemo, getStormDemoImage, getStormImage, getStorms,
} from '../services/stormTracking.js';

// The replay shows each image as the warning system would have seen it: about 15 minutes after it was taken (NOAA's delay).
const REPLAY_LAG_MS = 15 * 60_000;

export function listStorms(req, res) {
  const storms = getStorms();
  res.set('Cache-Control', 'public, max-age=60');
  // Arrivals are counted from the moment of the request: the same "from now" as the alert engine.
  res.json({ data: { ...storms, live: storms.live && withArrivals(storms.live, Date.now()) } });
}

export async function stormDemo(req, res) {
  try {
    const data = await getStormDemo();
    if (!data) return res.status(503).json({ message: 'Storm tracking is off: the ML service is not configured.' });
    res.set('Cache-Control', 'public, max-age=3600');
    const snapshots = data.snapshots.map((snapshot) => withArrivals(snapshot, Date.parse(snapshot.observedAt) + REPLAY_LAG_MS));
    return res.json({ data: { ...data, snapshots } });
  } catch {
    return res.status(503).json({ message: 'Storm tracking is not available: the ML service did not answer.' });
  }
}

export async function stormImage(req, res) {
  const image = await getStormImage(req.params.name).catch(() => null);
  if (!image) return res.status(404).json({ message: 'Satellite frame not found.' });
  // Names carry the frame time, and a frame's picture never changes.
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  return res.type('image/png').send(image);
}

export async function stormDemoImage(req, res) {
  const image = await getStormDemoImage(req.params.name).catch(() => null);
  if (!image) return res.status(404).json({ message: 'Demo frame not found.' });
  // Names carry the frame time and the demo day never changes.
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  return res.type('image/png').send(image);
}
