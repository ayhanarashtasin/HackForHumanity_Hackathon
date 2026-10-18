import { env } from '../../../config/env.js';
import { ChannelError } from '../errors.js';

// Telegram Bot API. The bot token is part of every request URL, so no error text, log line or stored value may ever contain the URL.
// Telegram is the one channel that needs no phone number: a person opens a one-time link, the bot learns the chat id, nothing else is kept.
const BLOCKED_TEXT = /chat not found|user is deactivated|bot was blocked|bot was kicked|have no rights|PEER_ID_INVALID/i;

export function classifyTelegram(status, body) {
  const description = String(body?.description ?? '');
  const retryAfter = Number(body?.parameters?.retry_after);
  const retryAfterMs = retryAfter > 0 ? Math.min(retryAfter, 3600) * 1000 : null;

  if (status === 429) return new ChannelError('retry', 'Telegram asked us to slow down.', { retryAfterMs: retryAfterMs ?? 30_000, code: 429 });
  if (status === 401 || status === 404) return new ChannelError('auth', 'Telegram rejected the bot token.', { code: status });
  if (status === 403 || (status === 400 && BLOCKED_TEXT.test(description))) return new ChannelError('blocked', 'This chat cannot receive messages from the bot.', { code: status });
  if (status >= 500) return new ChannelError('retry', `Telegram is unavailable (HTTP ${status}).`, { code: status });
  return new ChannelError('permanent', `Telegram rejected the message (HTTP ${status}).`, { code: status });
}

export function createTelegramChannel({ config = env.channels.telegram, fetchImpl = fetch } = {}) {
  const configured = Boolean(config.token);
  let username = null;
  let usernameAt = 0;

  // One Bot API call. Returns `result`, or throws a ChannelError.
  async function call(method, payload = {}, { timeoutMs = 15_000, signal = null } = {}) {
    if (!configured) throw new ChannelError('auth', 'Telegram is not configured.');

    let response;
    try {
      response = await fetchImpl(`${config.apiUrl}/bot${config.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ChannelError('retry', 'Telegram could not be reached.');
    }

    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok) return body.result;
    throw classifyTelegram(response.status, body);
  }

  return {
    name: 'telegram',
    configured,
    available: configured,
    call,

    // content: { text, parseMode?, buttons? }; `to` is the stored chat id. Alerts are plain text; the weather replies are HTML with
    // optional inline buttons (rows of { text, data }).
    async send({ to, content }) {
      const payload = { chat_id: String(to), text: content.text, disable_web_page_preview: true };
      if (content.parseMode) payload.parse_mode = content.parseMode;
      if (content.buttons?.length) payload.reply_markup = { inline_keyboard: content.buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
      else if (content.requestLocation) payload.reply_markup = { keyboard: [[{ text: content.locationLabel ?? '📍 Share location', request_location: true }]], resize_keyboard: true, one_time_keyboard: true };
      else if (content.removeKeyboard) payload.reply_markup = { remove_keyboard: true };
      const result = await call('sendMessage', payload);
      return { providerMessageId: result?.message_id === undefined ? null : String(result.message_id) };
    },

    // The bot's @username builds the one-time deep link. Cached, because it does not change.
    async getUsername({ now = Date.now() } = {}) {
      if (username && now - usernameAt < 3_600_000) return username;
      const me = await call('getMe');
      username = me?.username ?? null;
      usernameAt = now;
      return username;
    },

    // Reads what is already cached: used by status views, which must never wait on the network.
    peekUsername: () => username,

    getUpdates: (offset, timeoutSeconds = 25, signal = null) => call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'edited_message', 'callback_query'] },
      { timeoutMs: (timeoutSeconds + 10) * 1000, signal },
    ),
    setWebhook: (url, secretToken) => call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'edited_message', 'callback_query'], drop_pending_updates: false }),
    deleteWebhook: () => call('deleteWebhook', { drop_pending_updates: false }),

    // Stops the spinner on a pressed inline button. Best effort: the reply message is what matters.
    answerCallbackQuery: (callbackQueryId) => call('answerCallbackQuery', { callback_query_id: String(callbackQueryId) }),

    // "typing…" in the chat for a few seconds while a slow reply (a road route) is prepared. Best effort.
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: String(chatId), action }, { timeoutMs: 5_000 }),

    // The "/" menu. `languageCode` makes a list for people whose Telegram is set to that language; without it, the default list.
    setCommands: (commands, languageCode = null) => call('setMyCommands', { commands, ...(languageCode ? { language_code: languageCode } : {}) }),
  };
}
