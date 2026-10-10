import { env } from '../config/env.js';
import { initAlertModels } from '../models/index.js';
import { acquireLease, releaseLease, runAlertCycle } from '../services/alerts/cycle.js';
import { seedAreas, seedRules } from '../services/alerts/rules.js';
import { createXweatherBudget } from '../services/xweatherBudget.js';
import { createXweatherClient } from '../services/xweather.js';
import { every } from './every.js';

const LEASE_KEY = 'alert-cycle';

// The alert engine's background job: every few minutes, refresh what is due from Xweather (through the token governor) and run the
// engine on the cached data. It never overlaps itself, and a lease keeps a second process from running the same cycle.
export function startAlertJob({ client = createXweatherClient(), budget = createXweatherBudget() } = {}) {
  let ready = null;

  const prepare = async () => {
    await initAlertModels();
    // Reference data: idempotent, and never allowed to stop the engine.
    await Promise.allSettled([seedRules(), seedAreas()]);
  };

  return every('alert-engine', env.alerts.tickMinutes, async () => {
    ready ??= prepare();
    await ready;

    const leaseMs = Math.max(env.alerts.tickMinutes, 5) * 60_000;
    if (!await acquireLease(LEASE_KEY, leaseMs)) return;
    try {
      const { engine } = await runAlertCycle({ client, budget });
      const stats = engine?.stats;
      if (stats && (stats.eventsCreated || stats.notificationsCreated)) {
        console.log(`[alerts] ${stats.eventsCreated} event(s), ${stats.notificationsCreated} notification(s) created, ${stats.areas} area(s) monitored`);
      }
    } finally {
      await releaseLease(LEASE_KEY);
    }
  });
}
