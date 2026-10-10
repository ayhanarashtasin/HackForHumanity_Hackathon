import { getRadarFrames, getRadarImage } from '../services/bmdRadar.js';
import { getSatelliteFrames } from '../services/satellite.js';
import { statusOf } from '../services/weatherStore.js';

export function listRadarFrames(req, res) {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ data: { ...getRadarFrames(), status: statusOf('radar') } });
}

export async function sendRadarImage(req, res) {
  const { site, file } = req.params;

  if (!/^[a-z]+$/.test(site) || !/^[\w.-]+\.png$/.test(file)) {
    return res.status(400).json({ message: 'Invalid radar image.' });
  }

  const image = await getRadarImage(site, file);
  if (!image) {
    return res.status(404).json({ message: 'Radar image not found.' });
  }

  // File names carry the frame timestamp, so a given URL never changes.
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.type('image/png').send(image);
}

export function listSatelliteFrames(req, res) {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ data: { ...getSatelliteFrames(), status: statusOf('satellite') } });
}
