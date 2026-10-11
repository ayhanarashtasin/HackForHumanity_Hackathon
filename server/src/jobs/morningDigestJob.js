import { env } from '../config/env.js';
import { acquireLease, releaseLease } from '../services/alerts/cycle.js';
import { sharedChannels } from '../services/delivery/channels/index.js';
import { digestWindow, runMorningDigest } from '../services/delivery/morningDigest.js';
import { every } from './every.js';

const LEASE_KEY = 'morning-digest';
const LEASE_MS = 5 * 60_000;

const WAITING = {
  'no-forecast': 'no forecast is stored yet',
  'stale-forecast': 'the stored forecast is not current',
};

// The morning weather message (services/delivery/morningDigest.js). Every minute it checks whether today's send window is open, which costs
// nothing outside it; inside it, one tick finds the chats still waiting for today's message and sends it. A lease keeps a second server from
// working at the same time, and the per-person daily row keeps it from ever sending the same morning twice.
export function startMorningDigestJob({ channels = sharedChannels(), log = console } = {}) {
  const config = env.channels.morningDigest;
  if (!config.enabled || !channels.telegram?.available) return null;
  log.log(`[morning-digest] weather message to connected Telegram chats at ${config.time} (Asia/Dhaka)`);

  let lastStatus = null;
  return every('morning-digest', 1, async () => {
    if (!digestWindow(Date.now()).open) {
      lastStatus = null;
      return;
    }
    if (!await acquireLease(LEASE_KEY, LEASE_MS)) return;
    try {
      const result = await runMorningDigest({ channels, log });
      if (result.sent || result.failed) {
        log.log(`[morning-digest] ${result.sent} sent, ${result.failed} failed, ${result.retried} to retry, ${result.skipped} skipped`);
      }
      // Said once per change, not once a minute.
      if (WAITING[result.status] && result.status !== lastStatus) log.log(`[morning-digest] waiting: ${WAITING[result.status]}`);
      lastStatus = result.status;
    } finally {
      await releaseLease(LEASE_KEY);
    }
  });
}
