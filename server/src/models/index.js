import { AdminAction } from './AdminAction.js';
import { AdminSession } from './AdminSession.js';
import { Area } from './Area.js';
import { Delivery } from './Delivery.js';
import { EngineSettings } from './EngineSettings.js';
import { HazardEvent } from './HazardEvent.js';
import { JobState } from './JobState.js';
import { MorningDigest } from './MorningDigest.js';
import { Notification } from './Notification.js';
import { RuleSetting } from './RuleSetting.js';
import { StormSnapshot } from './StormSnapshot.js';
import { Subscriber } from './Subscriber.js';
import { WeatherRun } from './WeatherRun.js';
import { WeatherSnapshot } from './WeatherSnapshot.js';

// The alert engine's models. Their unique indexes ARE the guarantees (one notification per subscriber, event and rule; one token per
// subscriber; one send per idempotency key), so they are built before the API accepts a request, not lazily on first use.
export const alertModels = [
  AdminAction, AdminSession, Area, Delivery, EngineSettings, HazardEvent, JobState, MorningDigest, Notification, RuleSetting, Subscriber, WeatherSnapshot,
];

export async function initAlertModels() {
  await Promise.all(alertModels.map((model) => model.init()));
}

// Forecast history (compact per-run summaries): the TTL and the one-row-per-run index exist before the first collector writes.
export async function initDataModels() {
  await Promise.all([WeatherRun.init(), StormSnapshot.init()]);
}
