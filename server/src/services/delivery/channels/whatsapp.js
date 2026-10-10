import { env } from '../../../config/env.js';
import { ChannelError } from '../errors.js';
import { toWhatsAppId } from '../phone.js';
import { secretBoxReady } from '../secretBox.js';

// WhatsApp Business Cloud API (Meta). A business may only START a conversation with an approved message template, so alerts and the
// verification code are both template messages (README: "WhatsApp templates"). Free text is never sent.
const RETRY_CODES = new Set([4, 80007, 130429, 131016, 131056, 133016]);
const BLOCKED_CODES = new Set([131026, 131021, 131009, 131045, 130472]);
const CONFIG_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016, 131008, 131030, 100]);

export function classifyWhatsApp(status, body) {
  const code = Number(body?.error?.code);

  if (status === 401 || code === 190 || code === 0) return new ChannelError('auth', 'WhatsApp rejected the access token.', { code: status });
  if (status === 429 || RETRY_CODES.has(code)) return new ChannelError('retry', 'WhatsApp asked us to slow down.', { retryAfterMs: 60_000, code });
  if (BLOCKED_CODES.has(code)) return new ChannelError('blocked', 'This number cannot receive WhatsApp messages from the app.', { code });
  if (CONFIG_CODES.has(code)) return new ChannelError('config', `WhatsApp rejected the message template or request (code ${code}).`, { code });
  if (status >= 500) return new ChannelError('retry', `WhatsApp is unavailable (HTTP ${status}).`, { code: status });
  return new ChannelError('permanent', `WhatsApp rejected the message (HTTP ${status}${Number.isFinite(code) ? `, code ${code}` : ''}).`, { code: Number.isFinite(code) ? code : status });
}

// Template variables cannot contain line breaks, tabs or runs of spaces, and are limited in length.
export function templateText(value, max = 900) {
  const flat = String(value ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createWhatsAppChannel({ config = env.channels.whatsapp, fetchImpl = fetch, secretReady = secretBoxReady } = {}) {
  const configured = Boolean(config.token && config.phoneNumberId);
  // Without an approved verification template there is no way to prove a number is the person's own, so the channel stays unavailable.
  const available = configured && Boolean(config.alertTemplate) && Boolean(config.otpTemplate) && secretReady();

  async function post(body) {
    if (!configured) throw new ChannelError('auth', 'WhatsApp is not configured.');

    let response;
    try {
      response = await fetchImpl(`${config.apiUrl}/${config.apiVersion}/${config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', type: 'template', ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ChannelError('retry', 'WhatsApp could not be reached.');
    }

    const json = await response.json().catch(() => null);
    if (response.ok && json?.messages?.length) return { providerMessageId: String(json.messages[0].id ?? '') || null };
    throw classifyWhatsApp(response.status, json);
  }

  const language = (lang) => ({ code: config.languages[lang] ?? config.languages.en });

  return {
    name: 'whatsapp',
    configured,
    available,

    // content.parts = [severity label, title, message, valid-until text], the four variables of the alert template.
    send({ to, content, lang = 'en' }) {
      return post({
        to: toWhatsAppId(to),
        template: {
          name: config.alertTemplate,
          language: language(lang),
          components: [{ type: 'body', parameters: content.parts.map((text) => ({ type: 'text', text: templateText(text) })) }],
        },
      });
    },

    // An authentication template: the code is both the body variable and the copy-code button's parameter.
    sendCode({ to, code, lang = 'en' }) {
      return post({
        to: toWhatsAppId(to),
        template: {
          name: config.otpTemplate,
          language: language(lang),
          components: [
            { type: 'body', parameters: [{ type: 'text', text: String(code) }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] },
          ],
        },
      });
    },
  };
}
