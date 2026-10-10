import { createLightningService } from '../services/lightningCampaign.js';

const RETRY_AFTER_ERROR_MS = 5 * 60_000;

// Self-rescheduling timer: each wake-up recomputes the next slot from persisted campaign state, so restarts
// and multiple workers are safe (the service claims every slot and location before spending a request).
export function startLightningJob({ service = createLightningService() } = {}) {
  const controller = new AbortController();
  let timer = null;
  let stopped = false;

  const schedule = (ms) => {
    if (stopped || ms === null || ms === undefined) return;
    timer = setTimeout(run, ms);
    timer.unref();
  };

  async function run() {
    try {
      await service.init();
      const { waitMs } = await service.tick({ signal: controller.signal });
      schedule(waitMs);
    } catch (error) {
      console.error(`[lightning] ${service.redact(error?.message)}`);
      schedule(RETRY_AFTER_ERROR_MS);
    }
  }

  schedule(0);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    },
  };
}
