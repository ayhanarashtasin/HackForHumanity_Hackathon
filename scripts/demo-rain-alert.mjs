// Local demo of the rain forecast confidence line, for when no real rain alert is active.
//   npm run demo:rain                 a Level 2 (heavy rain) alert for the newest alert profile
//   npm run demo:rain -- --level 1    a Level 1 (moderate rain) alert
//   npm run demo:rain -- --remove     delete every demo rain alert again
// Only the forecast numbers are made up: the real rule, the real ML service (npm run ml) and the real message code build the alert.
// It is marked isDemo, so Telegram / WhatsApp / SMS never send it (inbox only), and its key starts with "demo:ml:" so the engine
// never withdraws it as "forecast changed". It expires on its own after the rain window.
import mongoose from 'mongoose';
import { env } from '../server/src/config/env.js';
import { HazardEvent } from '../server/src/models/HazardEvent.js';
import { Notification } from '../server/src/models/Notification.js';
import { Subscriber } from '../server/src/models/Subscriber.js';
import { attachForecastConfidence } from '../server/src/services/alerts/forecastConfidence.js';
import { detectHeavyRain } from '../server/src/services/alerts/hazards.js';
import { applyEvent } from '../server/src/services/alerts/notify.js';
import { getSettings } from '../server/src/services/alerts/settings.js';
import { locationByPcode } from '../server/src/services/geo.js';

const HOUR = 3_600_000;
const args = process.argv.slice(2);

await mongoose.connect(env.mongoUri);
try {
  if (args.includes('--remove')) {
    const events = await HazardEvent.find({ eventKey: /^demo:ml:/ }).select('_id').lean();
    const ids = events.map((event) => event._id);
    const notes = await Notification.deleteMany({ hazardEventId: { $in: ids } });
    await HazardEvent.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${ids.length} demo rain alert(s) and ${notes.deletedCount} notification(s).`);
  } else {
    await createDemo(args[args.indexOf('--level') + 1] === '1' ? 1 : 2);
  }
} finally {
  await mongoose.disconnect();
}

async function createDemo(level) {
  const nowMs = Date.now();
  const subscriber = await Subscriber.findOne({ status: 'active', isDemo: { $ne: true }, expiresAt: { $gt: new Date(nowMs) } }).sort({ createdAt: -1 }).lean();
  if (!subscriber) {
    console.log('No alert profile yet. Create one at http://localhost:5173/alert (for example a farmer at the harvest stage), then run this again.');
    process.exitCode = 1;
    return;
  }
  if (!env.alerts.mlServiceUrl) console.log('Note: ML_SERVICE_URL is empty in server/.env, so this alert will have no confidence line.');

  const pcode = subscriber.areas.find((area) => area.role === 'home')?.upazilaPcode ?? subscriber.relevantUpazilas[0];
  const location = locationByPcode.get(pcode);

  // Made-up forecast: 3-hour blocks from now (mm), with humidity and CAPE for the same blocks.
  const rain = level === 1 ? [3, 9, 5, 2, 1, 0, 0, 0] : [10, 30, 15, 8, 4, 2, 0, 0];
  const area = {
    pcode, name: location.name, lat: location.lat, lon: location.lon,
    rain: [{ provider: 'open-meteo', product: 'forecast-3h', status: 'FRESH', unitVerified: true,
      periods: rain.map((mm, i) => ({ startMs: nowMs + i * 3 * HOUR, endMs: nowMs + (i + 1) * 3 * HOUR, mm, pop: 80 })) }],
  };
  const steps = rain.map((_, i) => new Date(nowMs + i * 3 * HOUR).toISOString());
  const sources = { openMeteo: { data: { steps, locations: { [pcode]: { rh: steps.map(() => 90), cape: steps.map(() => 2200) } } } } };

  const detection = detectHeavyRain(area, nowMs);
  await attachForecastConfidence([{ area, detections: [detection] }], { sources, nowMs });
  const confidence = detection.evidence.forecastConfidence;
  if (!confidence && env.alerts.mlServiceUrl) console.log(`Note: the ML service did not answer at ${env.alerts.mlServiceUrl}. Start it with "npm run ml".`);

  const now = new Date(nowMs);
  const event = await HazardEvent.create({
    eventKey: `demo:ml:${pcode}:L${detection.level}:${now.toISOString()}`,
    hazardType: 'HEAVY_RAIN',
    origin: 'detected',
    source: { ...detection.source, referenceId: null },
    coverage: { scope: 'upazila', upazilaPcodes: [pcode], districtPcodes: [], marineZone: null, matchMethod: 'representative_point' },
    level: detection.level,
    evidence: detection.evidence,
    validFrom: new Date(detection.window.fromMs),
    validUntil: new Date(detection.window.untilMs),
    forecastIssuedAt: now,
    lifecycle: 'active',
    firstDetectedAt: now,
    lastConfirmedAt: now,
    lastUpdatedAt: now,
    revision: 1,
    dataStatus: 'FRESH',
    isDemo: true,
  });

  await applyEvent(event, { nowMs, settings: await getSettings({ force: true, now: nowMs }), subscriberIds: [subscriber._id], publishNow: true, bypassCap: true });
  const notification = await Notification.findOne({ hazardEventId: event._id, subscriberId: subscriber._id }).lean();

  console.log(`Profile: ${subscriber.occupation} (${subscriber.language}) in ${location.name}`);
  console.log(`Rule: Level ${detection.level} | ML (${confidence?.target ?? '-'} model): ${confidence?.band ?? 'no answer'}`);
  if (notification) console.log(`\n${notification.title}\n${notification.message}\n\nRefresh http://localhost:5173/alert to see it.`);
  else console.log('\nNo notification was created: this profile\'s occupation has no rain advice. Try a farmer at the harvest stage.');
}
