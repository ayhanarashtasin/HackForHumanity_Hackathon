import { env } from '../config/env.js';
import { acquireLease, recordJob, releaseLease } from '../services/alerts/cycle.js';
import { sharedChannels } from '../services/delivery/channels/index.js';
import { runDeliveryCycle } from '../services/delivery/queue.js';
import { every } from './every.js';

const LEASE_KEY = 'delivery-cycle';

// Sends the stored notifications of people who connected Telegram, WhatsApp or SMS. Every tick it queues what is new and sends what is due;
// a lease keeps a second process from sending the same message. It reads MongoDB only, never a weather provider.
export function startDeliveryJob({ channels = sharedChannels(), log = console } = {}) {
  const names = Object.values(channels).filter((channel) => channel.available).map((channel) => channel.name);
  if (!names.length) return null;
  log.log(`[delivery] channels ready: ${names.join(', ')}`);

  const leaseMs = Math.max(env.channels.tickSeconds * 3, 90) * 1000;
  return every('delivery', env.channels.tickSeconds / 60, async () => {
    if (!await acquireLease(LEASE_KEY, leaseMs)) return;
    try {
      const result = await recordJob('delivery', () => runDeliveryCycle({ channels }));
      if (result?.sent || result?.failed) log.log(`[delivery] ${result.sent} sent, ${result.failed} failed, ${result.retried} to retry`);
    } finally {
      await releaseLease(LEASE_KEY);
    }
  });
}
