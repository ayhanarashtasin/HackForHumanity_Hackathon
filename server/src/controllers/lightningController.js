import { buildStatus, buildSummaries, buildUpazilaSummaries } from '../services/lightningCampaign.js';

// Every handler reads cached campaign data from MongoDB. None of them can trigger an Xweather request.
export async function getLightningStatus(req, res) {
  res.json({ data: await buildStatus() });
}

export async function getLightningSummaries(req, res) {
  res.json({ data: await buildSummaries() });
}

export async function getLightningForUpazila(req, res) {
  const data = await buildUpazilaSummaries(req.params.pcode);

  if (!data) {
    return res.status(404).json({ message: 'Location not found.' });
  }

  res.json({ data });
}
