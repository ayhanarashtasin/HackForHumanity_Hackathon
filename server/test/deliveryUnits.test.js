import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { lintText } from '../src/services/alerts/messages.js';
import { createSmsChannel } from '../src/services/delivery/channels/sms.js';
import { classifyTelegram, createTelegramChannel } from '../src/services/delivery/channels/telegram.js';
import { createWhatsAppChannel, templateText } from '../src/services/delivery/channels/whatsapp.js';
import { renderMessage } from '../src/services/delivery/format.js';
import { maskPhone, normalizeBdMobile, toWhatsAppId } from '../src/services/delivery/phone.js';
import {
  inQuietHours, meetsMinSeverity, quietEndsAt, stageKey,
} from '../src/services/delivery/policy.js';
import { decrypt, encrypt, hmac } from '../src/services/delivery/secretBox.js';

// No database and no network here: adapters run against a recording fetch, everything else is pure.
const NOW = Date.parse('2026-10-11T04:00:00Z'); // 10:00 in Bangladesh
const HOUR = 3_600_000;
const SECRET = 'a-test-channel-secret-0123456789';

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === 'string' ? init.body : (init.body?.toString?.() ?? null) });
    const { status = 200, json = {}, text } = respond(calls.length, String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => text ?? JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

function notification(overrides = {}) {
  return {
    lang: 'en',
    severity: 'CRITICAL',
    title: 'Lightning detected near Badda.',
    message: 'Lightning was detected within 16 km of Badda, Dhaka at 15:42. Stop elevated work and move into a building.',
    recommendedActions: [{ key: 'stop_elevated_work', text: 'Stop elevated work' }, { key: 'move_inside', text: 'Move inside a building' }],
    origin: 'automatic',
    ruleStatus: 'prototype',
    evidence: {},
    sourceReferences: [],
    params: {},
    reasonForSelection: 'You work on a roof or scaffolding at a site in Badda.',
    occupation: 'construction',
    validUntil: new Date(NOW + 2 * HOUR),
    renotifications: 0,
    ...overrides,
  };
}

// ---------- phone numbers and secrets ----------

test('only Bangladeshi mobile numbers are accepted, in any common spelling, and are normalised to +880', () => {
  for (const input of ['01712345678', '+8801712345678', '8801712345678', '01712 345678', '0171-234-5678', '০১৭১২৩৪৫৬৭৮', ' +880 1712-345678 ']) {
    assert.equal(normalizeBdMobile(input), '+8801712345678', input);
  }
  for (const input of ['0171234567', '017123456789', '+14155550100', '02123456789', '01212345678', 'abc', '', null, undefined, 42, `0${'1'.repeat(60)}`]) {
    assert.equal(normalizeBdMobile(input), null, String(input));
  }
  assert.equal(toWhatsAppId('+8801712345678'), '8801712345678');
});

test('a masked number is recognisable to its owner but not reusable', () => {
  const mask = maskPhone('+8801712345678');
  assert.match(mask, /^\+8801•+678$/);
  assert.equal(mask.includes('1712345'), false);
});

test('phone numbers are encrypted at rest and cannot be read with another secret or after tampering', () => {
  env.channels.secret = SECRET;
  const blob = encrypt('+8801712345678');
  assert.equal(blob.includes('8801712345678'), false);
  assert.equal(decrypt(blob), '+8801712345678');
  assert.notEqual(encrypt('+8801712345678'), blob, 'each encryption uses a fresh nonce');
  assert.equal(hmac('x'), hmac('x'));

  const parts = blob.split('.');
  parts[3] = `${parts[3].slice(0, -2)}AA`;
  assert.throws(() => decrypt(parts.join('.')));

  env.channels.secret = 'a-different-secret-0123456789';
  assert.throws(() => decrypt(blob));

  env.channels.secret = '';
  assert.throws(() => encrypt('x'), /CHANNEL_SECRET/);
  env.channels.secret = SECRET;
});

// ---------- message text ----------

test('a channel message carries what a person needs and none of their profile (CTX-03)', () => {
  const sent = notification();
  for (const channel of ['telegram', 'sms', 'whatsapp']) {
    const { text, parts } = renderMessage(channel, sent, { nowMs: NOW, siteUrl: 'https://akashsathi.example' });
    for (const secret of ['construction', 'roof', 'scaffolding', 'Why you', 'You work']) {
      assert.equal(text.includes(secret), false, `${channel} must not mention "${secret}"`);
      assert.equal(parts.join(' ').includes(secret), false);
    }
    assert.match(text, /CRITICAL/);
    assert.match(text, /Badda/);
    assert.match(text, /https:\/\/akashsathi\.example\/alert/);
  }
});

test('Telegram text states the validity and who sent it, and quotes an official notice in its own words', () => {
  const { text } = renderMessage('telegram', notification(), { nowMs: NOW, siteUrl: 'https://x.example' });
  assert.match(text, /Valid until today 12:00 \(Bangladesh time\)/);
  assert.match(text, /Automatic alert \(prototype rules\)/);

  const official = renderMessage('telegram', notification({
    severity: 'WARNING',
    title: 'Official marine notice',
    evidence: { official: { signalText: 'LOCAL CAUTIONARY SIGNAL NO. 3', documentUrl: 'https://www.bmd.gov.bd/file/1.pdf' } },
  }), { nowMs: NOW });
  assert.match(official.text, /Official BMD notice \(quoted\)/);
  assert.match(official.text, /Official BMD wording \(quoted\): "LOCAL CAUTIONARY SIGNAL NO\. 3"/);
  assert.match(official.text, /Original: https:\/\/www\.bmd\.gov\.bd\/file\/1\.pdf/);

  const admin = renderMessage('telegram', notification({ origin: 'admin-message', params: { referenceUrl: 'https://example.org/notice' } }), { nowMs: NOW });
  assert.match(admin.text, /Sent by the administrator/);
  assert.match(admin.text, /Reference: https:\/\/example\.org\/notice/);
  // A link that is not http(s) is never put into a message.
  assert.equal(renderMessage('telegram', notification({ params: { referenceUrl: 'javascript:alert(1)' } }), { nowMs: NOW }).text.includes('javascript'), false);
});

test('an English SMS is one short plain-ASCII line; Bangla stays within three UCS-2 segments', () => {
  const sms = renderMessage('sms', notification({ title: 'Heavy rain — “expected” near Badda…' }), { nowMs: NOW, siteUrl: 'https://akashsathi.example' }).text;
  assert.ok(sms.length <= 320, `${sms.length} characters`);
  assert.match(sms, /^AkashSathi CRITICAL: /);
  assert.equal(/[^\x20-\x7E]/.test(sms), false, 'GSM-friendly: a single curly quote would halve the segment size');
  assert.match(sms, /Stop elevated work/);
  assert.match(sms, /https:\/\/akashsathi\.example\/alert$/);

  const long = renderMessage('sms', notification({ title: 'x'.repeat(600), recommendedActions: [{ key: 'a', text: 'y'.repeat(300) }] }), { nowMs: NOW }).text;
  assert.ok(long.length <= 320);
  assert.match(long, /\/alert$/, 'the link and the validity survive truncation');

  const bn = renderMessage('sms', notification({
    lang: 'bn', severity: 'WARNING', title: 'বাড্ডায় ভারী বৃষ্টির সম্ভাবনা', recommendedActions: [{ key: 'a', text: 'খোলা জায়গা এড়িয়ে চলুন' }],
  }), { nowMs: NOW, siteUrl: 'https://akashsathi.example' }).text;
  assert.ok(bn.length <= 200, `${bn.length} characters`);
  assert.match(bn, /^AkashSathi সতর্কতা: /);
  assert.match(bn, /[০-৯]/, 'Bangla digits are used in Bangla text');
});

test('WhatsApp gets the four template variables, with the sender label inside the message variable', () => {
  const { parts } = renderMessage('whatsapp', notification({ severity: 'WARNING' }), { nowMs: NOW });
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'WARNING');
  assert.equal(parts[1], 'Lightning detected near Badda');
  assert.match(parts[2], /\(Automatic alert \(prototype rules\)\)$/);
  assert.equal(parts[3], 'today 12:00');
});

test('the words a channel adds never use the discouraged phrases (no "safe", "all clear", flooding claims)', () => {
  for (const lang of ['en']) {
    for (const origin of ['automatic', 'admin-declared', 'admin-message']) {
      const { text } = renderMessage('telegram', notification({ lang, origin, params: { referenceUrl: 'https://example.org' } }), { nowMs: NOW });
      assert.deepEqual(lintText(text), [], text);
    }
  }
});

// ---------- policy ----------

test('quiet hours handle a window that crosses midnight, and ending is always in the future', () => {
  const night = { enabled: true, start: '22:00', end: '06:00' };
  const at = (hhmm) => Date.parse(`2026-10-11T${hhmm}:00+06:00`);

  assert.equal(inQuietHours(night, at('23:30')), true);
  assert.equal(inQuietHours(night, at('02:00')), true);
  assert.equal(inQuietHours(night, at('06:00')), false);
  assert.equal(inQuietHours(night, at('12:00')), false);
  assert.equal(inQuietHours({ enabled: false, start: '22:00', end: '06:00' }, at('23:30')), false);
  assert.equal(inQuietHours({ enabled: true, start: '09:00', end: '12:00' }, at('10:00')), true);
  assert.equal(inQuietHours({ enabled: true, start: '09:00', end: '09:00' }, at('09:00')), false, 'an empty window is no window');
  assert.equal(inQuietHours({ enabled: true, start: 'x', end: 'y' }, at('10:00')), false);

  assert.equal(quietEndsAt(night, at('23:30')), at('06:00') + 24 * HOUR);
  assert.equal(quietEndsAt(night, at('02:00')), at('06:00'));
});

test('a stage is the severity plus the re-notification count, so escalations are sent again but refreshes are not', () => {
  assert.equal(stageKey({ severity: 'WARNING' }), 'WARNING:0');
  assert.equal(stageKey({ severity: 'CRITICAL', renotifications: 2 }), 'CRITICAL:2');
  assert.notEqual(stageKey({ severity: 'WARNING' }), stageKey({ severity: 'CRITICAL' }));
});

test('a channel can set the lowest severity it will carry', () => {
  const minimum = { telegram: 'ADVISORY', sms: 'WARNING', whatsapp: 'CRITICAL' };
  assert.equal(meetsMinSeverity('telegram', 'ADVISORY', minimum), true);
  assert.equal(meetsMinSeverity('sms', 'ADVISORY', minimum), false);
  assert.equal(meetsMinSeverity('sms', 'WARNING', minimum), true);
  assert.equal(meetsMinSeverity('whatsapp', 'WARNING', minimum), false);
  assert.equal(meetsMinSeverity('whatsapp', 'CRITICAL', minimum), true);
});

// ---------- Telegram ----------

const TELEGRAM = { token: '123456:SECRET-TOKEN', apiUrl: 'https://telegram.test', webhookUrl: '', webhookSecret: '' };

test('Telegram: a message goes to the chat, and the token never appears in what is stored or thrown', async () => {
  const { calls, fetchImpl } = recorder(() => ({ json: { ok: true, result: { message_id: 77 } } }));
  const telegram = createTelegramChannel({ config: TELEGRAM, fetchImpl });
  assert.equal(telegram.available, true);

  const result = await telegram.send({ to: '555', content: { text: 'hello' } });
  assert.equal(result.providerMessageId, '77');
  assert.equal(calls[0].url, 'https://telegram.test/bot123456:SECRET-TOKEN/sendMessage');
  assert.deepEqual(JSON.parse(calls[0].body), { chat_id: '555', text: 'hello', disable_web_page_preview: true });

  for (const status of [400, 401, 403, 404, 429, 500, 502]) {
    const failing = createTelegramChannel({ config: TELEGRAM, fetchImpl: recorder(() => ({ status, json: { ok: false, description: 'x', parameters: { retry_after: 7 } } })).fetchImpl });
    await assert.rejects(failing.send({ to: '1', content: { text: 'x' } }), (error) => {
      assert.equal(JSON.stringify(error).includes('SECRET-TOKEN'), false);
      assert.equal(String(error.message).includes('SECRET-TOKEN'), false);
      return true;
    });
  }

  const unreachable = createTelegramChannel({ config: TELEGRAM, fetchImpl: async () => { throw new Error('connect ECONNREFUSED https://telegram.test/bot123456:SECRET-TOKEN/x'); } });
  await assert.rejects(unreachable.send({ to: '1', content: { text: 'x' } }), (error) => {
    assert.equal(error.kind, 'retry');
    assert.equal(error.message.includes('SECRET-TOKEN'), false, 'a network error message may contain the URL; ours must not');
    return true;
  });
});

test('Telegram errors are classified: slow down and outages retry, a blocked chat stops, a bad token is a configuration problem', () => {
  assert.deepEqual([classifyTelegram(429, { parameters: { retry_after: 12 } })].map((error) => [error.kind, error.retryAfterMs]), [['retry', 12_000]]);
  assert.equal(classifyTelegram(429, {}).retryAfterMs, 30_000);
  assert.equal(classifyTelegram(403, { description: 'Forbidden: bot was blocked by the user' }).kind, 'blocked');
  assert.equal(classifyTelegram(400, { description: 'Bad Request: chat not found' }).kind, 'blocked');
  assert.equal(classifyTelegram(400, { description: 'Bad Request: message is too long' }).kind, 'permanent');
  assert.equal(classifyTelegram(401, {}).kind, 'auth');
  assert.equal(classifyTelegram(502, {}).kind, 'retry');
});

test('Telegram: the bot name is cached for status views and webhooks carry the secret', async () => {
  const { calls, fetchImpl } = recorder((count, url) => ({ json: { ok: true, result: url.endsWith('getMe') ? { username: 'AkashSathiBot' } : true } }));
  const telegram = createTelegramChannel({ config: TELEGRAM, fetchImpl });
  assert.equal(telegram.peekUsername(), null);
  assert.equal(await telegram.getUsername({ now: 0 }), 'AkashSathiBot');
  assert.equal(await telegram.getUsername({ now: 1000 }), 'AkashSathiBot');
  assert.equal(calls.filter((call) => call.url.endsWith('getMe')).length, 1);
  assert.equal(telegram.peekUsername(), 'AkashSathiBot');

  await telegram.setWebhook('https://akashsathi.example/api/channels/telegram/webhook', 'abcdefghijklmnop');
  assert.equal(JSON.parse(calls.at(-1).body).secret_token, 'abcdefghijklmnop');

  assert.equal(createTelegramChannel({ config: { ...TELEGRAM, token: '' }, fetchImpl }).available, false);
});

// ---------- WhatsApp ----------

const WHATSAPP = {
  token: 'WA-TOKEN', phoneNumberId: '1234567890', apiUrl: 'https://graph.test', apiVersion: 'v21.0',
  alertTemplate: 'akashsathi_alert', otpTemplate: 'akashsathi_code', languages: { en: 'en', bn: 'bn' },
};

test('WhatsApp: alerts and codes are template messages, never free text, to the number without a plus', async () => {
  env.channels.secret = SECRET;
  const { calls, fetchImpl } = recorder(() => ({ json: { messages: [{ id: 'wamid.1' }] } }));
  const whatsapp = createWhatsAppChannel({ config: WHATSAPP, fetchImpl });
  assert.equal(whatsapp.available, true);

  const sent = await whatsapp.send({ to: '+8801712345678', lang: 'bn', content: { parts: ['WARNING', 'Title', 'Line one\nline two   spaced', 'today 12:00'] } });
  assert.equal(sent.providerMessageId, 'wamid.1');
  assert.equal(calls[0].url, 'https://graph.test/v21.0/1234567890/messages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer WA-TOKEN');

  const body = JSON.parse(calls[0].body);
  assert.equal(body.type, 'template');
  assert.equal(body.to, '8801712345678');
  assert.equal(body.template.name, 'akashsathi_alert');
  assert.equal(body.template.language.code, 'bn');
  assert.deepEqual(body.template.components[0].parameters.map((parameter) => parameter.text), ['WARNING', 'Title', 'Line one · line two spaced', 'today 12:00']);
  assert.equal(JSON.stringify(body).includes('"text":"Line one\\n'), false, 'template variables cannot contain line breaks');

  await whatsapp.sendCode({ to: '+8801712345678', code: '123456' });
  const code = JSON.parse(calls[1].body);
  assert.equal(code.template.name, 'akashsathi_code');
  assert.equal(code.template.components[0].parameters[0].text, '123456');
  assert.deepEqual(code.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '123456' }] });
});

test('WhatsApp stays unavailable without a verification template, a token or the encryption secret', () => {
  env.channels.secret = SECRET;
  assert.equal(createWhatsAppChannel({ config: { ...WHATSAPP, otpTemplate: '' } }).available, false);
  assert.equal(createWhatsAppChannel({ config: { ...WHATSAPP, token: '' } }).available, false);
  assert.equal(createWhatsAppChannel({ config: WHATSAPP, secretReady: () => false }).available, false);
  assert.equal(createWhatsAppChannel({ config: WHATSAPP, secretReady: () => true }).available, true);
});

test('WhatsApp errors map to retry, blocked, configuration or authentication problems', async () => {
  const kindFor = async (status, code) => {
    const channel = createWhatsAppChannel({ config: WHATSAPP, secretReady: () => true, fetchImpl: recorder(() => ({ status, json: { error: { code } } })).fetchImpl });
    try {
      await channel.send({ to: '+8801712345678', content: { parts: ['a', 'b', 'c', 'd'] } });
    } catch (error) {
      return error.kind;
    }
    return 'sent';
  };
  assert.equal(await kindFor(401, 190), 'auth');
  assert.equal(await kindFor(429, 130429), 'retry');
  assert.equal(await kindFor(400, 131026), 'blocked');
  assert.equal(await kindFor(400, 132001), 'config');
  assert.equal(await kindFor(503, undefined), 'retry');
  assert.equal(await kindFor(400, 999999), 'permanent');

  assert.equal(templateText('a\n\nb\tc  d'), 'a · b · c d');
  assert.equal(templateText('x'.repeat(2000)).length, 900);
});

// ---------- SMS ----------

test('SMS via Twilio: form-encoded request with basic auth, and Twilio error codes are understood', async () => {
  const config = { provider: 'twilio', twilio: { accountSid: 'AC123', authToken: 'TOKEN', from: '+15005550006', messagingServiceSid: '', apiUrl: 'https://twilio.test' }, http: {} };
  const { calls, fetchImpl } = recorder(() => ({ status: 201, json: { sid: 'SM1' } }));
  const sms = createSmsChannel({ config, fetchImpl, secretReady: () => true });
  assert.equal(sms.available, true);

  assert.equal((await sms.send({ to: '+8801712345678', content: { text: 'hi there' } })).providerMessageId, 'SM1');
  assert.equal(calls[0].url, 'https://twilio.test/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('AC123:TOKEN').toString('base64')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { To: '+8801712345678', Body: 'hi there', From: '+15005550006' });

  // A messaging service takes the place of a From number.
  const service = createSmsChannel({ config: { ...config, twilio: { ...config.twilio, from: '', messagingServiceSid: 'MG1' } }, fetchImpl, secretReady: () => true });
  await service.send({ to: '+8801712345678', content: { text: 'x' } });
  assert.equal(new URLSearchParams(calls[1].body).get('MessagingServiceSid'), 'MG1');
  assert.equal(new URLSearchParams(calls[1].body).has('From'), false);

  const kindFor = async (status, code) => {
    const channel = createSmsChannel({ config, secretReady: () => true, fetchImpl: recorder(() => ({ status, json: { code } })).fetchImpl });
    try {
      await channel.send({ to: '+8801712345678', content: { text: 'x' } });
    } catch (error) {
      return error.kind;
    }
    return 'sent';
  };
  assert.equal(await kindFor(401, 20003), 'auth');
  assert.equal(await kindFor(429, 20429), 'retry');
  assert.equal(await kindFor(400, 21610), 'blocked');
  assert.equal(await kindFor(400, 21211), 'blocked');
  assert.equal(await kindFor(500), 'retry');
  assert.equal(await kindFor(400, 21602), 'permanent');

  assert.equal(createSmsChannel({ config: { ...config, twilio: { ...config.twilio, from: '' } }, secretReady: () => true }).available, false, 'needs a From number or a messaging service');
  assert.equal(createSmsChannel({ config: { provider: '', twilio: config.twilio, http: {} }, secretReady: () => true }).available, false);
  assert.equal(createSmsChannel({ config, secretReady: () => false }).available, false, 'needs the encryption secret');
});

test('SMS via a generic HTTP gateway: placeholders are encoded for GET, substituted value by value for JSON', async () => {
  const get = { provider: 'http', twilio: {}, http: { url: 'https://gw.test/send?key=KEY&to={to_digits}&msg={text}', method: 'GET', contentType: '', body: '', headers: {}, successMatch: '' } };
  const first = recorder(() => ({ text: 'OK' }));
  await createSmsChannel({ config: get, fetchImpl: first.fetchImpl, secretReady: () => true }).send({ to: '+8801712345678', content: { text: 'a&b=c d "q" আ' } });
  assert.equal(first.calls[0].url, `https://gw.test/send?key=KEY&to=8801712345678&msg=${encodeURIComponent('a&b=c d "q" আ')}`);
  assert.equal(first.calls[0].init.method, 'GET');
  assert.equal(first.calls[0].init.body, undefined);

  const post = { provider: 'http', twilio: {}, http: { url: 'https://gw.test/api', method: 'POST', contentType: 'application/json', body: '{"to":"{to_local}","sms":{"text":"{text}"},"id":"{to}"}', headers: { 'X-Api-Key': 'K' }, successMatch: '' } };
  const second = recorder(() => ({ text: '{"status":"sent"}' }));
  await createSmsChannel({ config: post, fetchImpl: second.fetchImpl, secretReady: () => true }).send({ to: '+8801712345678', content: { text: 'say "hi"\nnow' } });
  assert.deepEqual(JSON.parse(second.calls[0].body), { to: '01712345678', sms: { text: 'say "hi"\nnow' }, id: '+8801712345678' });
  assert.equal(second.calls[0].init.headers['X-Api-Key'], 'K');
  assert.equal(second.calls[0].init.headers['Content-Type'], 'application/json');

  const form = { provider: 'http', twilio: {}, http: { url: 'https://gw.test/api', method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'number={to_digits}&message={message}', headers: {}, successMatch: '' } };
  const third = recorder(() => ({ text: 'ok' }));
  await createSmsChannel({ config: form, fetchImpl: third.fetchImpl, secretReady: () => true }).send({ to: '+8801712345678', content: { text: 'x y&z' } });
  assert.equal(third.calls[0].body, 'number=8801712345678&message=x%20y%26z');
});

test('SMS gateway replies: a success pattern is enforced, outages retry, and the URL (which holds the API key) is never in an error', async () => {
  const base = { url: 'https://gw.test/send?api_key=VERY-SECRET&to={to}', method: 'GET', contentType: '', body: '', headers: {}, successMatch: '"response_code":\\s*202' };
  const make = (respond) => createSmsChannel({ config: { provider: 'http', twilio: {}, http: base }, fetchImpl: recorder(respond).fetchImpl, secretReady: () => true });
  const attempt = async (channel) => {
    try {
      await channel.send({ to: '+8801712345678', content: { text: 'x' } });
      return null;
    } catch (error) {
      assert.equal(JSON.stringify(error).includes('VERY-SECRET'), false);
      assert.equal(error.message.includes('VERY-SECRET'), false);
      return error.kind;
    }
  };

  assert.equal(await attempt(make(() => ({ text: '{"response_code": 202}' }))), null);
  assert.equal(await attempt(make(() => ({ text: '{"response_code": 1007}' }))), 'permanent', 'many gateways answer 200 for a refused message');
  assert.equal(await attempt(make(() => ({ status: 503, text: '' }))), 'retry');
  assert.equal(await attempt(make(() => ({ status: 403, text: '' }))), 'auth');
  assert.equal(await attempt(make(() => ({ status: 400, text: '' }))), 'permanent');

  const down = createSmsChannel({ config: { provider: 'http', twilio: {}, http: base }, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND gw.test?api_key=VERY-SECRET'); }, secretReady: () => true });
  assert.equal(await attempt(down), 'retry');

  const badJson = createSmsChannel({ config: { provider: 'http', twilio: {}, http: { ...base, method: 'POST', contentType: 'application/json', body: '{not json', successMatch: '' } }, fetchImpl: recorder(() => ({})).fetchImpl, secretReady: () => true });
  assert.equal(await attempt(badJson), 'config');
});

test('the SMS verification code text is short and in the person\'s language', async () => {
  const { calls, fetchImpl } = recorder(() => ({ text: 'OK' }));
  const sms = createSmsChannel({ config: { provider: 'http', twilio: {}, http: { url: 'https://gw.test/?m={text}', method: 'GET', contentType: '', body: '', headers: {}, successMatch: '' } }, fetchImpl, secretReady: () => true });
  await sms.sendCode({ to: '+8801712345678', code: '042917', lang: 'en' });
  await sms.sendCode({ to: '+8801712345678', code: '042917', lang: 'bn' });
  assert.match(decodeURIComponent(calls[0].url), /Your AkashSathi code is 042917/);
  assert.match(decodeURIComponent(calls[1].url), /আকাশসাথী যাচাইকরণ কোড: 042917/);
});
