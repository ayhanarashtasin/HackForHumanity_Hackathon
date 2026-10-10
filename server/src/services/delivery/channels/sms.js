import { env } from '../../../config/env.js';
import { ChannelError } from '../errors.js';
import { secretBoxReady } from '../secretBox.js';

// SMS through either Twilio or a generic HTTP gateway (most Bangladeshi bulk-SMS providers are a simple GET or POST).
// Both turn one (number, text) pair into one request, report a provider id when there is one, and classify failures the same way.
const TWILIO_BLOCKED = new Set([21610, 21211, 21614, 21408, 21612, 21617]); // unsubscribed / invalid / not mobile / region blocked

export function classifyTwilio(status, body) {
  const code = Number(body?.code);
  if (status === 401 || status === 403 || code === 20003) return new ChannelError('auth', 'Twilio rejected the credentials.', { code: status });
  if (status === 429 || code === 20429) return new ChannelError('retry', 'Twilio asked us to slow down.', { retryAfterMs: 30_000, code: status });
  if (TWILIO_BLOCKED.has(code)) return new ChannelError('blocked', 'This number cannot receive SMS from the app.', { code });
  if (status >= 500) return new ChannelError('retry', `Twilio is unavailable (HTTP ${status}).`, { code: status });
  return new ChannelError('permanent', `Twilio rejected the message (HTTP ${status}${Number.isFinite(code) ? `, code ${code}` : ''}).`, { code: Number.isFinite(code) ? code : status });
}

function twilioTransport(config, fetchImpl) {
  const ready = Boolean(config.accountSid && config.authToken && (config.from || config.messagingServiceSid));

  return {
    ready,
    async send({ to, text }) {
      const form = new URLSearchParams({ To: to, Body: text });
      if (config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid);
      else form.set('From', config.from);

      let response;
      try {
        response = await fetchImpl(`${config.apiUrl}/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new ChannelError('retry', 'Twilio could not be reached.');
      }

      const body = await response.json().catch(() => null);
      if (response.ok) return { providerMessageId: body?.sid ?? null };
      throw classifyTwilio(response.status, body);
    },
  };
}

// {to} = +8801712345678, {to_digits} = 8801712345678, {to_local} = 01712345678, {text} (alias {message}).
function placeholders(to, text) {
  const digits = to.replace(/^\+/, '');
  return { to, to_digits: digits, to_local: `0${digits.replace(/^880/, '')}`, text, message: text };
}

const replaceAll = (template, values, encode) => String(template).replace(/\{(to|to_digits|to_local|text|message)\}/g, (_, key) => encode(values[key]));

// JSON bodies are substituted value by value, so a quotation mark or line break in the text can never break the JSON.
function substituteJson(node, values) {
  if (typeof node === 'string') return replaceAll(node, values, (value) => value);
  if (Array.isArray(node)) return node.map((item) => substituteJson(item, values));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteJson(value, values)]));
  return node;
}

function httpTransport(config, fetchImpl) {
  const ready = Boolean(config.url) && (config.method === 'GET' || Boolean(config.body));
  let successMatch = null;
  try {
    successMatch = config.successMatch ? new RegExp(config.successMatch, 'i') : null;
  } catch {
    successMatch = null;
  }

  return {
    ready,
    async send({ to, text }) {
      const values = placeholders(to, text);
      const json = /json/i.test(config.contentType);
      const headers = { ...config.headers };
      const url = replaceAll(config.url, values, encodeURIComponent);
      let body;

      if (config.method === 'POST') {
        headers['Content-Type'] = config.contentType;
        if (json) {
          let parsed;
          try {
            parsed = JSON.parse(config.body);
          } catch {
            throw new ChannelError('config', 'SMS_HTTP_BODY is not valid JSON.');
          }
          body = JSON.stringify(substituteJson(parsed, values));
        } else {
          body = replaceAll(config.body, values, encodeURIComponent);
        }
      }

      // The URL may carry an API key, so it never appears in an error message.
      let response;
      try {
        response = await fetchImpl(url, { method: config.method, headers, body, signal: AbortSignal.timeout(15_000) });
      } catch {
        throw new ChannelError('retry', 'The SMS gateway could not be reached.');
      }

      const reply = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) throw new ChannelError('auth', 'The SMS gateway rejected the credentials.', { code: response.status });
      if (response.status === 429 || response.status >= 500) throw new ChannelError('retry', `The SMS gateway is unavailable (HTTP ${response.status}).`, { code: response.status });
      if (!response.ok) throw new ChannelError('permanent', `The SMS gateway rejected the message (HTTP ${response.status}).`, { code: response.status });
      // Many gateways answer 200 even when they refuse the message, so a success pattern can be required.
      if (successMatch && !successMatch.test(reply)) throw new ChannelError('permanent', 'The SMS gateway did not confirm the message.');
      return { providerMessageId: null };
    },
  };
}

export function createSmsChannel({ config = env.channels.sms, fetchImpl = fetch, secretReady = secretBoxReady } = {}) {
  const transport = config.provider === 'twilio'
    ? twilioTransport(config.twilio, fetchImpl)
    : (config.provider === 'http' ? httpTransport(config.http, fetchImpl) : null);
  const configured = Boolean(transport?.ready);

  return {
    name: 'sms',
    configured,
    available: configured && secretReady(),

    // content: { text }; `to` is +8801XXXXXXXXX.
    send({ to, content }) {
      if (!transport) throw new ChannelError('auth', 'SMS is not configured.');
      return transport.send({ to, text: content.text });
    },

    sendCode({ to, code, lang = 'en' }) {
      const text = lang === 'bn'
        ? `আকাশসাথী যাচাইকরণ কোড: ${code}। কোডটি ১০ মিনিট বৈধ। কাউকে জানাবেন না।`
        : `Your AkashSathi code is ${code}. It is valid for 10 minutes. Do not share it.`;
      return this.send({ to, content: { text } });
    },
  };
}
