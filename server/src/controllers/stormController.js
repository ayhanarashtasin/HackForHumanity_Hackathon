import { getStormDemo, getStormDemoImage, getStorms } from '../services/stormTracking.js';

export function listStorms(req, res) {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ data: getStorms() });
}

export async function stormDemo(req, res) {
  try {
    const data = await getStormDemo();
    if (!data) return res.status(503).json({ message: 'Storm tracking is off: the ML service is not configured.' });
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({ data });
  } catch {
    return res.status(503).json({ message: 'Storm tracking is not available: the ML service did not answer.' });
  }
}

export async function stormDemoImage(req, res) {
  const image = await getStormDemoImage(req.params.name).catch(() => null);
  if (!image) return res.status(404).json({ message: 'Demo frame not found.' });
  // Names carry the frame time and the demo day never changes.
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  return res.type('image/png').send(image);
}
