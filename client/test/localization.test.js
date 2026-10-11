import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { errorText, translate } from '../src/i18n/index.js';
import { COMMON } from '../src/i18n/common.js';
import { LANDING } from '../src/i18n/landing.js';
import { MAP } from '../src/i18n/map.js';
import { ADMIN } from '../src/i18n/admin.js';
import { LANGUAGE_KEY, getLanguage, readLanguage, subscribeLanguage, writeLanguage } from '../src/i18n/language.js';
import { formatBst, formatClock, formatDay, formatRange, relativeLabel } from '../src/lib/time.js';
import { buildAreaIndex, areaSummary, bdDateTime, hazardLabel, roleLabel, validateForm } from '../src/lib/adminForm.js';
import { resolveSelection } from '../src/lib/series.js';
import { SIGN_LAYERS, WMO_LABELS } from '../src/lib/scales.js';
import { ruleCatalogue } from '../../server/src/config/alertRules.js';

test('all shared and page messages have nonempty Bangla copy and identical named parameters', () => {
  const params = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const messages of [COMMON, LANDING, MAP, ADMIN]) {
    for (const [en, bn] of Object.entries(messages)) {
      assert.ok(bn.trim(), en);
      assert.match(bn, /[\u0980-\u09ff]/u, en);
      assert.deepEqual(params(en), params(bn), en);
    }
  }
});

test('Bengali typography is self-hosted and editorial heading sizes cannot leak into alert panels', () => {
  const css = readFileSync(new URL('../src/landing.css', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/LandingPage.jsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const font = readFileSync(new URL('../public/fonts/noto-sans-bengali.woff2', import.meta.url));
  assert.match(page, /className="landing landing-home"/);
  assert.match(css, /\.landing-home h2\s*\{/);
  assert.doesNotMatch(css, /\.landing h[23](?:\s|,|\{)/);
  assert.match(styles, /font-weight: 100 900/);
  assert.match(styles, /url\('\/fonts\/noto-sans-bengali\.woff2'\)/);
  assert.equal(font.toString('ascii', 0, 4), 'wOF2');
  assert.ok(font.length < 150_000, 'Only the Bengali variable-font subset is shipped');
});

test('whole-sentence translation supports Bangla order, numbers, identifiers, and missing values', () => {
  assert.equal(translate('bn', '{n} scenarios', { n: 4 }, LANDING), '৪টি পরিস্থিতি');
  assert.equal(translate('en', '{n} scenarios', { n: 4 }, LANDING), '4 scenarios');
  assert.equal(translate('bn', 'Mode {mode}', { mode: 'B' }, MAP), 'পদ্ধতি B');
  assert.equal(translate('bn', 'Batch {id}. You can withdraw it from History; a withdrawal is never an all-clear.', { id: 'batch-123' }, ADMIN).includes('batch-123'), true);
  assert.ok(translate('bn', 'Weather for {name}', {}, MAP).includes('{name}'));
  assert.equal(translate('bn', 'toString'), 'toString');
  assert.equal(translate('bn', null), null);
});

test('weather signs and descriptions are translated, while unknown diagnostics fail clearly in either language', () => {
  for (const text of [...Object.values(WMO_LABELS), ...Object.values(SIGN_LAYERS).flatMap((layer) => [layer.label, layer.note])]) {
    assert.notEqual(translate('bn', text, {}, MAP), text, text);
  }
  assert.equal(errorText('Provider timed out', 'bn'), COMMON['Something went wrong. Please try again.']);
  assert.equal(errorText('Provider timed out', 'en'), 'Provider timed out');
  assert.equal(errorText('Cannot reach the API. Check that the backend is running.', 'bn'), COMMON['Cannot reach the API. Check that the backend is running.']);
  assert.equal(errorText('পূর্বরূপের মেয়াদ শেষ।', 'bn'), 'পূর্বরূপের মেয়াদ শেষ।');
});

test('all real map areas, including city corporations and newer upazilas, have a Bengali display name', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url)));
  for (const id of Object.keys(data.polygons)) {
    const resolved = resolveSelection({ level: 'polygon', id }, null, data, 'bn');
    assert.match(resolved.name, /[\u0980-\u09ff]/u, id);
    assert.match(resolved.parent, /[\u0980-\u09ff]/u, id);
  }
});

test('language survives storage, reaches every subscriber and synchronizes other tabs, including blocked storage', () => {
  const previous = globalThis.window;
  const storage = new Map([[LANGUAGE_KEY, 'bn']]);
  const events = new Set();
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener: (type, listener) => events.add(listener), removeEventListener: (type, listener) => events.delete(listener),
  };
  let notifications = 0;
  const unsubscribe = subscribeLanguage(() => notifications++);
  try {
    assert.equal(readLanguage(), 'bn');
    assert.equal(getLanguage(), 'bn');
    writeLanguage('en');
    assert.equal(storage.get(LANGUAGE_KEY), 'en');
    assert.equal(getLanguage(), 'en');
    writeLanguage('invalid');
    assert.equal(notifications, 1);
    storage.set(LANGUAGE_KEY, 'bn');
    for (const listener of events) listener({ key: LANGUAGE_KEY });
    assert.equal(getLanguage(), 'bn');
    window.localStorage.setItem = () => { throw new Error('storage blocked'); };
    writeLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(notifications, 3);
  } finally {
    unsubscribe();
    assert.equal(events.size, 0);
    globalThis.window = previous;
    writeLanguage('en');
  }
});

test('map and admin dates use Bangladesh time with readable Bangla days and numerals', () => {
  const ms = Date.parse('2026-10-10T22:30:00Z');
  assert.match(formatBst(ms, 'bn'), /১১ অক্টোবর, ০৪:৩০ বাংলাদেশ সময়/);
  assert.equal(formatClock(ms, 'bn'), '০৪:৩০');
  assert.match(formatDay(ms, 'bn'), /১১/);
  assert.match(formatRange(ms, ms + 10800000, 'bn'), /০৪:৩০ – ০৭:৩০/);
  assert.equal(relativeLabel(ms + 1800000, ms, 'bn'), '৩০ মিনিট পরে');
  assert.equal(relativeLabel(ms - 7200000, ms, 'bn'), '২ ঘণ্টা আগে');
  assert.match(bdDateTime(ms, 'bn'), /১১ অক্টোবর/);
  assert.match(formatBst(ms, 'en'), /BST$/);
});

const catalogue = {
  districts: [{ pcode: '3026', name: 'Dhaka', nameBn: 'ঢাকা', division: 'Dhaka' }],
  locations: [{ pcode: '302604', name: 'Badda', nameBn: 'বাড্ডা', district: '3026', kind: 'thana' }],
};

test('areas, occupation labels and validation switch language without changing request values', () => {
  try {
    writeLanguage('bn');
    assert.equal(roleLabel(null, 'farmer'), 'কৃষক');
    assert.equal(hazardLabel('OBSERVED_LIGHTNING'), 'বজ্রপাত (পর্যবেক্ষিত)');
    assert.equal(areaSummary({ all: false, districts: ['3026'], upazilas: [] }, buildAreaIndex(catalogue)), 'ঢাকা জেলা');
    assert.equal(resolveSelection({ level: 'upazila', id: '302604' }, null, catalogue, 'bn').name, 'বাড্ডা');
    assert.equal(resolveSelection({ level: 'upazila', id: '302604' }, null, catalogue, 'bn').parent, 'ঢাকা জেলা');
    assert.equal(validateForm('weather', { roles: [], audience: 'live' }, {}).find((problem) => problem.field === 'roles').message, 'অন্তত একটি পেশা বেছে নিন।');
  } finally { writeLanguage('en'); }
});

test('every administrative threshold has a Bangla explanation generated from the same live rule configuration', () => {
  for (const row of ruleCatalogue()) {
    assert.match(row.ruleBn, /[\u0980-\u09ff]/u, row.id);
    const numbers = (text) => [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]).sort();
    // Bangla labels use native digits; all interpolated configuration numbers remain in Latin until display formatting.
    const bn = row.ruleBn.replace(/একটি/g, '১টি').replace(/[০-৯]/g, (digit) => String('০১২৩৪৫৬৭৮৯'.indexOf(digit)));
    assert.deepEqual(numbers(row.rule), numbers(bn), row.id);
  }
});
