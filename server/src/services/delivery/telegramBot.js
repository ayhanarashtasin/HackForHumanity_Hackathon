import { env } from '../../config/env.js';
import { JobState } from '../../models/JobState.js';
import { sharedChannels } from './channels/index.js';
import { consumeTelegramLink, telegramLanguage, unlinkTelegramChat } from './linking.js';

// The bot's side of the conversation. It answers four things and nothing else: /start <code> (connect this chat to an alert profile),
// /stop (disconnect), /help, and anything else gets the help text. It never asks for or stores a name, number or location.
const WEB = () => `${env.channels.publicUrl}/alert`;

const REPLIES = {
  en: {
    linked: () => 'Connected. AkashSathi alerts for your work and area will arrive in this chat. These are prototype alerts, not an official warning service. Send /stop to stop them. Alerts also stay in the app inbox.',
    invalid: () => `This link has expired or was already used. Open ${WEB()}, choose "Connect Telegram", and try again.`,
    stopped: () => 'Stopped. You will no longer receive AkashSathi alerts in this chat. Your alerts are still available at the AkashSathi website.',
    nothing: () => 'No AkashSathi alert profile was connected to this chat.',
    help: () => `AkashSathi sends weather alerts for your work and area. To connect this chat, open ${WEB()}, set up your alerts, and choose "Connect Telegram". Commands: /stop to stop alerts here.`,
  },
  bn: {
    linked: () => 'সংযুক্ত হয়েছে। আপনার কাজ ও এলাকার জন্য আকাশসাথীর সতর্কবার্তা এই চ্যাটে আসবে। এগুলো পরীক্ষামূলক সতর্কবার্তা, সরকারি সতর্কীকরণ সেবা নয়। বন্ধ করতে /stop পাঠান। অ্যাপের ইনবক্সেও সতর্কবার্তা থাকবে।',
    invalid: () => `এই লিংকের মেয়াদ শেষ অথবা এটি আগেই ব্যবহার হয়েছে। ${WEB()} খুলে "টেলিগ্রাম সংযুক্ত করুন" বেছে আবার চেষ্টা করুন।`,
    stopped: () => 'বন্ধ করা হয়েছে। এই চ্যাটে আর আকাশসাথীর সতর্কবার্তা আসবে না। আপনার সতর্কবার্তা আকাশসাথীর ওয়েবসাইটে দেখা যাবে।',
    nothing: () => 'এই চ্যাটে আকাশসাথীর কোনো সতর্কবার্তা প্রোফাইল সংযুক্ত ছিল না।',
    help: () => `আকাশসাথী আপনার কাজ ও এলাকার জন্য আবহাওয়ার সতর্কবার্তা পাঠায়। এই চ্যাট সংযুক্ত করতে ${WEB()} খুলে সতর্কবার্তা চালু করুন এবং "টেলিগ্রাম সংযুক্ত করুন" বেছে নিন। এখানে সতর্কবার্তা বন্ধ করতে /stop পাঠান।`,
  },
};

// Before a chat is linked there is no stored language, so the reply carries both.
const both = (key) => `${REPLIES.en[key]()}\n\n${REPLIES.bn[key]()}`;
const say = (key, lang) => (lang === 'bn' || lang === 'en' ? REPLIES[lang][key]() : both(key));

const recent = new Set();
function seen(updateId) {
  if (updateId === undefined) return false;
  if (recent.has(updateId)) return true;
  recent.add(updateId);
  if (recent.size > 500) recent.delete(recent.values().next().value);
  return false;
}

export function resetBotForTests() {
  recent.clear();
}

export async function handleTelegramUpdate(update, { channels = sharedChannels(), now = new Date() } = {}) {
  const message = update?.message;
  // Groups and channels are ignored: alerts go to one person's private chat only.
  if (!message || message.chat?.type !== 'private' || typeof message.text !== 'string') return { handled: false };
  if (seen(update.update_id)) return { handled: false, duplicate: true };

  const chatId = String(message.chat.id);
  const [first = '', ...rest] = message.text.trim().split(/\s+/);
  const command = first.split('@')[0].toLowerCase();
  const reply = async (text) => {
    try {
      await channels.telegram.send({ to: chatId, content: { text } });
    } catch {
      // The person may already have blocked the bot; nothing more to do.
    }
  };

  if (command === '/start' && rest[0]) {
    const result = await consumeTelegramLink(rest[0], chatId, now);
    await reply(result.ok ? say('linked', result.language) : say('invalid', null));
    return { handled: true, action: result.ok ? 'linked' : 'invalid' };
  }

  if (command === '/stop') {
    const result = await unlinkTelegramChat(chatId);
    await reply(result.count ? say('stopped', result.language) : say('nothing', null));
    return { handled: true, action: 'stopped' };
  }

  await reply(say('help', await telegramLanguage(chatId)));
  return { handled: true, action: 'help' };
}

// ---------- receiving updates ----------

const OFFSET_KEY = 'telegram-bot';
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function loadOffset() {
  const row = await JobState.findOne({ key: OFFSET_KEY }).lean();
  return Number(row?.detail?.offset) || 0;
}

const saveOffset = (offset) => JobState.updateOne({ key: OFFSET_KEY }, { $set: { detail: { offset }, lastCompletedAt: new Date(), lastStatus: 'ok' } }, { upsert: true });

// Starts receiving updates: by webhook when TELEGRAM_WEBHOOK_URL (and a valid secret) are set, otherwise by long polling, which needs no
// public address and is what local development uses. Returns { stop() }, or null when Telegram is not configured.
export function startTelegramBot({ channels = sharedChannels(), log = console } = {}) {
  const telegram = channels.telegram;
  if (!telegram.available) return null;

  const controller = new AbortController();
  const webhook = env.channels.telegram.webhookUrl && env.channels.telegram.webhookSecret;
  if (env.channels.telegram.webhookUrl && !env.channels.telegram.webhookSecret) {
    log.error('[telegram] TELEGRAM_WEBHOOK_URL is set but TELEGRAM_WEBHOOK_SECRET is missing or invalid (16-256 characters of A-Z a-z 0-9 _ -). Falling back to polling.');
  }

  async function run() {
    try {
      await telegram.getUsername();
      if (webhook) {
        await telegram.setWebhook(env.channels.telegram.webhookUrl, env.channels.telegram.webhookSecret);
        log.log('[telegram] webhook registered');
        return;
      }
      await telegram.deleteWebhook();
    } catch (error) {
      log.error(`[telegram] setup failed: ${error.message}`);
      if (webhook) return;
    }

    log.log('[telegram] polling for updates');
    let offset = await loadOffset().catch(() => 0);
    while (!controller.signal.aborted) {
      try {
        const updates = await telegram.getUpdates(offset, 25, controller.signal);
        for (const update of updates) {
          try {
            await handleTelegramUpdate(update, { channels });
          } catch (error) {
            log.error(`[telegram] could not handle an update: ${error.message}`);
          }
          offset = Math.max(offset, update.update_id + 1);
        }
        if (updates.length) await saveOffset(offset).catch(() => {});
      } catch (error) {
        if (controller.signal.aborted) return;
        log.error(`[telegram] ${error.message}`);
        await sleep(error.kind === 'auth' ? 5 * 60_000 : 10_000, controller.signal);
      }
    }
  }

  run().catch((error) => log.error(`[telegram] ${error.message}`));
  return { stop: () => controller.abort() };
}
