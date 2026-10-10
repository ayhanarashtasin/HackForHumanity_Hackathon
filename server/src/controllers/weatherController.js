import { getDailyJson, getSnapshotJson } from '../services/weatherStore.js';
import { isDistrictCode, listRuns } from '../services/weatherHistory.js';

// The JSON is built once per data change and shared by every visitor; requests never trigger upstream fetches.
function sendCached(res, json) {
  res.set('Cache-Control', 'public, max-age=60');
  res.type('application/json').send(json);
}

export function getSnapshot(req, res) {
  sendCached(res, getSnapshotJson());
}

export function getDaily(req, res) {
  sendCached(res, getDailyJson());
}

const SOURCES = ['bmd', 'openMeteo'];

// Earlier forecast runs, summarised per district, straight from MongoDB (never from a provider).
export async function getHistory(req, res) {
  const source = req.query.source ?? 'bmd';
  const district = req.query.district ?? null;
  const days = Number(req.query.days ?? 7);

  if (!SOURCES.includes(source)) return res.status(400).json({ message: `source must be one of: ${SOURCES.join(', ')}.` });
  if (district !== null && !isDistrictCode(district)) return res.status(400).json({ message: 'Unknown district code.' });
  if (!Number.isInteger(days) || days < 1 || days > 60) return res.status(400).json({ message: 'days must be a whole number from 1 to 60.' });

  const runs = await listRuns({ source, district, days });
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ data: { source, district, days, count: runs.length, runs } });
}
