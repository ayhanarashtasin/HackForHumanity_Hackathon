import { env } from '../config/env.js';
import { fetchForecast, probeUpdatedAt } from '../services/bmdForecast.js';
import { refreshRadar } from '../services/bmdRadar.js';
import { fetchOpenMeteo } from '../services/openMeteo.js';
import { refreshSatellite } from '../services/satellite.js';
import { recordRun } from '../services/weatherHistory.js';
import {
  getSourceData, recordAttempt, recordCheck, recordFailure, restoreSnapshots, setSnapshot,
} from '../services/weatherStore.js';
import { startAlertJob } from './alertJob.js';
import { startDeliveryJob } from './deliveryJob.js';
import { every } from './every.js';
import { startLightningJob } from './lightningJob.js';
import { startMorningDigestJob } from './morningDigestJob.js';
import { startTelegramBot } from '../services/delivery/telegramBot.js';

let running = [];

// BMD publishes new model runs a few times a day: a one-location probe reads `updated_at`, and the full 544-location pull happens only when it changes.
async function refreshBmd() {
  recordAttempt('bmd');
  try {
    const updatedAt = await probeUpdatedAt();
    const current = getSourceData('bmd');

    if (current && current.sourceUpdatedAt === updatedAt) {
      recordCheck('bmd', { dataTime: updatedAt });
      return;
    }

    const forecast = await fetchForecast();
    await setSnapshot('bmd', forecast, { dataTime: forecast.sourceUpdatedAt });
    await recordRun('bmd', forecast);
    console.log(`[bmd] forecast updated (${forecast.sourceUpdatedAt}), ${Object.keys(forecast.locations).length} locations`);
  } catch (error) {
    recordFailure('bmd', error);
    throw error;
  }
}

async function refreshOpenMeteo() {
  recordAttempt('openMeteo');
  try {
    const forecast = await fetchOpenMeteo();
    await setSnapshot('openMeteo', forecast, { dataTime: new Date().toISOString() });
    await recordRun('openMeteo', forecast);
    console.log(`[open-meteo] updated, ${Object.keys(forecast.locations).length} locations${forecast.missing.length ? `, ${forecast.missing.length} missing` : ''}`);
  } catch (error) {
    recordFailure('openMeteo', error);
    throw error;
  }
}

// Starts every background collector once. Called only from server.js after MongoDB is connected (tests import the app, not this).
export async function startJobs() {
  if (running.length) return;

  if (env.weather.jobsEnabled) {
    try {
      await restoreSnapshots();
    } catch (error) {
      console.error(`[weather] could not restore saved snapshots: ${error.message}`);
    }

    running.push(
      every('bmd', env.weather.bmdCheckMinutes, refreshBmd),
      every('open-meteo', env.weather.openMeteoMinutes, refreshOpenMeteo),
      every('radar', env.weather.radarMinutes, () => refreshRadar()),
      every('satellite', env.weather.satelliteMinutes, () => refreshSatellite()),
    );
  }

  if (env.lightning.enabled) running.push(startLightningJob());

  // The alert engine reads cached data (and fetches what it needs through its own budget), so it runs whether or not the map collectors do.
  if (env.alerts.engineEnabled) running.push(startAlertJob());

  // External delivery runs on its own: administrators can send alerts even when the engine is off. Each channel stays idle until configured.
  if (env.channels.deliveryEnabled) {
    for (const job of [startDeliveryJob(), startTelegramBot(), startMorningDigestJob()]) if (job) running.push(job);
  }
}

export function stopJobs() {
  for (const job of running) job.stop();
  running = [];
}
