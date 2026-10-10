import { createSmsChannel } from './sms.js';
import { createTelegramChannel } from './telegram.js';
import { createWhatsAppChannel } from './whatsapp.js';

// The three external channels, keyed by name. Tests pass their own `fetchImpl`; the app builds one set from the environment.
export function createChannels(options = {}) {
  return {
    telegram: createTelegramChannel(options.telegram ?? {}),
    whatsapp: createWhatsAppChannel(options.whatsapp ?? {}),
    sms: createSmsChannel(options.sms ?? {}),
  };
}

let shared = null;
export function sharedChannels() {
  shared ??= createChannels();
  return shared;
}

export function resetSharedChannels() {
  shared = null;
}

// Tests swap in channels built on a mocked fetch.
export function setSharedChannels(channels) {
  shared = channels;
}
