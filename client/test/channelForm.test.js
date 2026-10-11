import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STRINGS, t } from '../src/alert/i18n.js';
import {
  channelErrorKey, codeFormProblem, latinDigits, normalizeBdMobile, phoneFormProblem, receivesKey,
} from '../src/lib/channelForm.js';

test('a Bangladeshi mobile number is recognised in any common spelling, and nothing else is', () => {
  for (const input of ['01712345678', '+8801712345678', '8801712345678', '0171 234 5678', '০১৭১২৩৪৫৬৭৮', ' +880 1712-345678 ']) {
    assert.equal(normalizeBdMobile(input), '+8801712345678', input);
  }
  for (const input of ['', 'abc', '0171234567', '+14155550100', '01212345678', null, undefined, 1712345678]) {
    assert.equal(normalizeBdMobile(input), null, String(input));
  }
});

test('the phone form needs a valid number and the consent tick, and says which is missing first', () => {
  assert.equal(phoneFormProblem({ phone: '', consent: true }), 'ch.err.phone');
  assert.equal(phoneFormProblem({ phone: '01712345678', consent: false }), 'ch.err.consent');
  assert.equal(phoneFormProblem({ phone: '01712345678', consent: undefined }), 'ch.err.consent');
  assert.equal(phoneFormProblem({ phone: '01712345678', consent: true }), null);
  assert.equal(codeFormProblem('12345'), 'ch.err.code');
  assert.equal(codeFormProblem('12345a'), 'ch.err.code');
  assert.equal(codeFormProblem(' 123456 '), null);
  assert.equal(codeFormProblem(' ১২৩৪৫৬ '), null);
  assert.equal(codeFormProblem('১২৩৪৫ক'), 'ch.err.code');
  assert.equal(latinDigits('১২৩৪৫৬'), '123456');
});

test('the server\'s English answers are shown as the page\'s own wording in the person\'s language', () => {
  assert.equal(channelErrorKey({ status: 400, details: { consent: 'required' } }), 'ch.err.consent');
  assert.equal(channelErrorKey({ status: 400, details: { phone: 'invalid' } }), 'ch.err.phone');
  assert.equal(channelErrorKey({ status: 400, details: { code: 'wrong' } }), 'ch.err.wrong');
  assert.equal(channelErrorKey({ status: 400, details: { code: 'expired' } }), 'ch.err.expired');
  assert.equal(channelErrorKey({ status: 400, details: { code: 'invalid' } }), 'ch.err.code');
  assert.equal(channelErrorKey({ status: 429 }), 'ch.err.rate');
  assert.equal(channelErrorKey({ status: 503 }), 'ch.err.send');
  assert.equal(channelErrorKey({ status: 502 }), 'ch.err.send');
  assert.equal(channelErrorKey({ status: 400, message: 'That number cannot receive messages from AkashSathi.' }), 'ch.err.blocked');
  assert.equal(channelErrorKey({ status: 500 }), 'ch.err.generic');
  assert.equal(channelErrorKey(null), 'ch.err.generic');

  // every key the page can ask for exists in both languages
  for (const key of ['ch.err.consent', 'ch.err.phone', 'ch.err.code', 'ch.err.wrong', 'ch.err.expired', 'ch.err.rate', 'ch.err.send', 'ch.err.blocked', 'ch.err.generic']) {
    assert.ok(STRINGS.en[key] && STRINGS.bn[key], key);
  }
});

test('each severity floor has a plain description in both languages', () => {
  for (const level of ['ADVISORY', 'WARNING', 'CRITICAL']) {
    const key = receivesKey(level);
    assert.ok(STRINGS.en[key] && STRINGS.bn[key], key);
  }
  assert.equal(receivesKey('nonsense'), 'ch.sev.ADVISORY');
  assert.equal(t('en', 'ch.receives', { what: t('en', receivesKey('WARNING')) }), 'Receives Warning and Critical alerts.');
});

test('the page no longer says a phone number is never involved, and no longer promises "later" channels', () => {
  for (const lang of ['en', 'bn']) {
    assert.doesNotMatch(STRINGS[lang]['page.point1'], /no phone number|ফোন নম্বর লাগে না/i);
    assert.equal('review.channels' in STRINGS[lang], false);
  }
  assert.match(STRINGS.en['ch.privacy'], /never your job or your answers/);
});

test('the wording the channels panel adds never claims safety or an all-clear', () => {
  const banned = /\ball[- ]clear\b|\b(?:is|are|will be)\s+safe\b|\bguarantee/i;
  for (const [key, text] of Object.entries(STRINGS.en)) if (key.startsWith('ch.')) assert.doesNotMatch(text, banned, key);
});
