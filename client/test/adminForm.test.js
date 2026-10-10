import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addArea, ageLabel, areaCount, areaSummary, areasPayload, automaticMatrix, bdDateTime, buildAreaIndex, buildBody, canSend, canonical, confirmPayload,
  confirmationNeeds, confirmationReady, describeError, describeResult, describeStoredAreas, emptyAreas, hazardLabel, heldStatus, initialForm, isPreviewExpired, isWebUrl,
  minutesSince, newIdempotencyKey, reasonText, recipientBreakdown, removeArea, roleLabel, sameParameters, searchAreas, sendBody, sendableRoles,
  summarisePreview, validateForm,
} from '../src/lib/adminForm.js';

const options = {
  roles: [{ value: 'farmer', label: { en: 'Farmer', bn: 'কৃষক' } }, { value: 'vendor', label: { en: 'Vendor', bn: 'বিক্রেতা' } }],
  hazards: [
    { type: 'HEAVY_RAIN', label: { en: 'Heavy rain' }, minLevel: 1, maxLevel: 3, needsArea: true },
    { type: 'OBSERVED_LIGHTNING', label: { en: 'Lightning' }, minLevel: 2, maxLevel: 3, needsArea: true },
    { type: 'MARINE_WEATHER', label: { en: 'Marine' }, minLevel: 1, maxLevel: 3, needsArea: false },
  ],
  limits: { maxHours: 72, defaultHours: 6, textMax: 600, titleMax: 80, sendsPerHour: 20 },
};

const catalogue = {
  districts: [{ pcode: '3026', name: 'Dhaka', nameBn: 'ঢাকা', division: 'Dhaka' }, { pcode: '1004', name: 'Barguna', nameBn: 'বরগুনা', division: 'Barishal' }],
  locations: [
    { pcode: '302604', name: 'Badda', nameBn: 'বাড্ডা', district: '3026', kind: 'thana' },
    { pcode: '302672', name: 'Savar', nameBn: 'সাভার', district: '3026', kind: 'upazila' },
    { pcode: '100409', name: 'Amtali', nameBn: 'আমতলী', district: '1004', kind: 'upazila' },
  ],
};
const index = buildAreaIndex(catalogue);

const chosen = (...districts) => ({ all: false, districts, upazilas: [] });

// ---------- areas ----------
test('"all of Bangladesh" is null where the server allows it and { all: true } where it requires an area', () => {
  assert.equal(areasPayload(emptyAreas()), null);
  assert.deepEqual(areasPayload(emptyAreas(), { required: true }), { all: true });
  assert.deepEqual(areasPayload({ all: false, districts: ['3026', '1004'], upazilas: ['302672', '100409'] }), { districts: ['1004', '3026'], upazilas: ['100409', '302672'] });
  assert.equal(areasPayload(undefined), null);
});

test('area search finds districts and upazilas in English or Bangla, needs two characters and ranks prefix matches first', () => {
  assert.deepEqual(searchAreas(index, 'b'), []);
  assert.deepEqual(searchAreas(index, 'bad').map((item) => item.code), ['302604']);
  assert.deepEqual(searchAreas(index, 'বাড্ডা').map((item) => item.code), ['302604']);
  assert.deepEqual(searchAreas(index, 'dhaka').map((item) => [item.level, item.code]), [['district', '3026']]);
  assert.deepEqual(searchAreas(index, '3026').map((item) => item.code), ['302604', '302672'].filter((code) => code.startsWith('3026')), 'a code prefix finds upazilas');
  assert.deepEqual(searchAreas(index, 'a', { limit: 1 }), []);
  assert.deepEqual(searchAreas(index, 'ar', { level: 'upazila' }).map((item) => item.code), ['302672']);
  assert.equal(searchAreas(index, 'dhaka')[0].parent, 'Dhaka');
  assert.equal(searchAreas(index, 'badda')[0].kind, 'City thana');
});

test('areas are added without duplicates, removed back to "all", counted and summarised', () => {
  let areas = emptyAreas();
  areas = addArea(areas, 'district', '3026');
  areas = addArea(areas, 'upazila', '100409');
  areas = addArea(areas, 'district', '3026');
  assert.deepEqual(areas, { all: false, districts: ['3026'], upazilas: ['100409'] });
  assert.equal(areaCount(areas), 2);
  assert.equal(areaSummary(areas, index), 'Dhaka district, Amtali');
  areas = removeArea(areas, 'district', '3026');
  assert.deepEqual(areas, { all: false, districts: [], upazilas: ['100409'] });
  assert.deepEqual(removeArea(areas, 'upazila', '100409'), emptyAreas(), 'removing the last area means everywhere again');
  assert.equal(areaSummary(emptyAreas(), index), 'All Bangladesh');
  assert.equal(describeStoredAreas('all', index), 'All Bangladesh');
  assert.equal(describeStoredAreas(null, index), 'All Bangladesh');
  assert.equal(describeStoredAreas({ districts: ['3026'], upazilas: ['999999'] }, index), 'Dhaka district, 999999');
  assert.equal(areaCount(emptyAreas()), 0);
});

// ---------- request bodies ----------
test('the weather body carries roles (sorted), the area narrowing and the audience', () => {
  const form = { roles: ['vendor', 'farmer', 'farmer'], areas: emptyAreas(), audience: 'live' };
  assert.deepEqual(buildBody('weather', form), { mode: 'weather', roles: ['farmer', 'vendor'], areas: null, audience: 'live' });
  assert.deepEqual(buildBody('weather', { ...form, areas: chosen('3026'), audience: 'demo' }), { mode: 'weather', roles: ['farmer', 'vendor'], areas: { districts: ['3026'], upazilas: [] }, audience: 'demo' });
});

test('the declare body converts numbers, requires an area, and drops it for marine hazards', () => {
  const form = { hazardType: 'OBSERVED_LIGHTNING', level: '3', hours: '2', roles: ['farmer'], areas: chosen('3026'), audience: 'live' };
  assert.deepEqual(buildBody('declare', form), { mode: 'declare', hazardType: 'OBSERVED_LIGHTNING', level: 3, hours: 2, roles: ['farmer'], audience: 'live', areas: { districts: ['3026'], upazilas: [] } });
  assert.deepEqual(buildBody('declare', { ...form, areas: emptyAreas() }).areas, { all: true });
  assert.equal('areas' in buildBody('declare', { ...form, hazardType: 'MARINE_WEATHER' }), false);
});

test('the message body trims text, omits empty optional parts and keeps actions sorted', () => {
  const form = {
    severity: 'WARNING', roles: ['vendor'], areas: chosen('3026'), audience: 'live', hours: '6', textEn: '  Market closed.  ', textBn: '   ',
    titleEn: '', titleBn: '', actions: ['stay_in', 'check_forecast'], referenceUrl: ' https://example.org/notice ',
  };
  assert.deepEqual(buildBody('message', form), {
    mode: 'message', severity: 'WARNING', roles: ['vendor'], areas: { districts: ['3026'], upazilas: [] }, audience: 'live', hours: 6,
    text: { en: 'Market closed.' }, actions: ['check_forecast', 'stay_in'], referenceUrl: 'https://example.org/notice',
  });
  const withTitles = buildBody('message', { ...form, titleEn: 'Closed', titleBn: 'বন্ধ', textBn: 'বাজার বন্ধ', referenceUrl: '' });
  assert.deepEqual(withTitles.title, { en: 'Closed', bn: 'বন্ধ' });
  assert.deepEqual(withTitles.text, { en: 'Market closed.', bn: 'বাজার বন্ধ' });
  assert.equal('referenceUrl' in withTitles, false);
});

test('fresh forms start empty, live, and with the default validity', () => {
  assert.deepEqual(initialForm('weather', options), { roles: [], areas: emptyAreas(), audience: 'live' });
  assert.equal(initialForm('declare', options).hours, 6);
  assert.equal(initialForm('message', options).severity, 'ADVISORY');
  assert.deepEqual(initialForm('message', options).actions, []);
});

// ---------- validation ----------
const fields = (problems) => problems.map((problem) => problem.field);

test('every mode needs a role; weather needs nothing else', () => {
  assert.deepEqual(fields(validateForm('weather', initialForm('weather', options), options)), ['roles']);
  assert.deepEqual(validateForm('weather', { ...initialForm('weather', options), roles: ['farmer'] }, options), []);
});

test('declare: hazard, level range per hazard, validity, area (except marine)', () => {
  const base = { ...initialForm('declare', options), roles: ['farmer'], hazardType: 'OBSERVED_LIGHTNING', level: 2, areas: chosen('3026') };
  assert.deepEqual(validateForm('declare', base, options), []);
  assert.deepEqual(fields(validateForm('declare', { ...base, hazardType: '' }, options)), ['hazardType']);
  assert.deepEqual(fields(validateForm('declare', { ...base, level: 1 }, options)), ['level'], 'lightning is declared at level 2 or 3');
  assert.deepEqual(fields(validateForm('declare', { ...base, level: 4 }, options)), ['level']);
  assert.deepEqual(fields(validateForm('declare', { ...base, hours: 0 }, options)), ['hours']);
  assert.deepEqual(fields(validateForm('declare', { ...base, hours: 73 }, options)), ['hours']);
  assert.deepEqual(fields(validateForm('declare', { ...base, areas: { all: false, districts: [], upazilas: [] } }, options)), ['areas']);
  assert.deepEqual(validateForm('declare', { ...base, areas: emptyAreas() }, options), [], 'all of Bangladesh is a choice');
  assert.deepEqual(validateForm('declare', { ...base, hazardType: 'MARINE_WEATHER', level: 1, areas: { all: false, districts: [], upazilas: [] } }, options), [], 'a marine declaration needs no area');
});

test('message: severity, English text, lengths, link and area are checked', () => {
  const base = { ...initialForm('message', options), roles: ['vendor'], textEn: 'Hello', areas: chosen('3026') };
  assert.deepEqual(validateForm('message', base, options), []);
  assert.deepEqual(fields(validateForm('message', { ...base, textEn: '   ' }, options)), ['textEn']);
  assert.deepEqual(fields(validateForm('message', { ...base, textEn: 'x'.repeat(601) }, options)), ['textEn']);
  assert.deepEqual(fields(validateForm('message', { ...base, textBn: 'x'.repeat(601) }, options)), ['textBn']);
  assert.deepEqual(fields(validateForm('message', { ...base, titleEn: 'x'.repeat(81) }, options)), ['titleEn']);
  assert.deepEqual(fields(validateForm('message', { ...base, severity: 'PANIC' }, options)), ['severity']);
  assert.deepEqual(fields(validateForm('message', { ...base, referenceUrl: 'javascript:alert(1)' }, options)), ['referenceUrl']);
  assert.deepEqual(fields(validateForm('message', { ...base, referenceUrl: 'ftp://example.org/file' }, options)), ['referenceUrl']);
  assert.deepEqual(fields(validateForm('message', { ...base, referenceUrl: 'not a link' }, options)), ['referenceUrl']);
  assert.deepEqual(validateForm('message', { ...base, referenceUrl: 'https://example.org/a' }, options), []);
  assert.deepEqual(fields(validateForm('message', { ...base, areas: { all: false, districts: [], upazilas: [] } }, options)), ['areas']);
  assert.equal(isWebUrl('http://localhost:5173'), true);
  assert.equal(isWebUrl('mailto:a@b.c'), false);
});

// ---------- preview invalidation ----------
test('a preview applies only to exactly the same parameters, whatever the order of lists', () => {
  const a = buildBody('weather', { roles: ['vendor', 'farmer'], areas: chosen('3026', '1004'), audience: 'live' });
  const b = buildBody('weather', { roles: ['farmer', 'vendor'], areas: chosen('1004', '3026'), audience: 'live' });
  assert.equal(sameParameters(a, b), true);
  assert.equal(sameParameters(a, { ...b, audience: 'demo' }), false);
  assert.equal(sameParameters(a, { ...b, roles: ['farmer'] }), false);
  assert.equal(sameParameters(a, { ...b, areas: null }), false);
  assert.equal(sameParameters(null, a), false);
  assert.equal(sameParameters({ x: ['c', 'a'] }, { x: ['a', 'c'] }), true);
  assert.deepEqual(canonical({ b: ['z', 'a'], a: 1 }), { a: 1, b: ['a', 'z'] });

  const message = { ...initialForm('message', options), roles: ['vendor'], textEn: 'Hi', areas: chosen('3026') };
  assert.equal(sameParameters(buildBody('message', message), buildBody('message', { ...message, textEn: 'Hi!' })), false);
  assert.equal(sameParameters(buildBody('message', message), buildBody('message', { ...message, actions: ['stay_in'] })), false);
});

// ---------- reading a preview ----------
const group = (overrides) => ({
  occupation: 'farmer', scenarioId: 'FARM-01', hazardType: 'HEAVY_RAIN', level: 2, severity: 'WARNING', affectedArea: { name: 'Badda' },
  recipients: 3, newCount: 0, alreadySent: 0, held: 0, released: 0, ...overrides,
});

test('a preview is split into new, already sent, held and nothing-detected, and never loses a group', () => {
  const preview = {
    groups: [
      group({ newCount: 2, alreadySent: 1 }),
      group({ occupation: 'vendor', scenarioId: 'VEND-01', alreadySent: 4 }),
      group({ occupation: 'construction', scenarioId: 'CONS-03', released: 2 }),
      group({ occupation: 'student_public', scenarioId: 'PUBLIC-01', held: 1 }),
    ],
    nothing: [{ role: 'fisherman', reason: 'no-hazard', subscribers: 3, sources: [] }],
    totals: { newRecipients: 2, released: 2, alreadySent: 5 },
  };
  const summary = summarisePreview(preview);
  assert.deepEqual(summary.fresh.map((row) => [row.scenarioId, row.count]), [['FARM-01', 2]]);
  assert.deepEqual(summary.already.map((row) => [row.scenarioId, row.count]), [['FARM-01', 1], ['VEND-01', 4]]);
  assert.deepEqual(summary.held.map((row) => [row.scenarioId, row.count]), [['CONS-03', 2], ['PUBLIC-01', 1]]);
  assert.equal(summary.nothing[0].role, 'fisherman');
  assert.deepEqual(sendableRoles(preview), ['construction', 'farmer'], 'roles with something new or released');
  assert.deepEqual(summarisePreview(null).fresh, []);
  assert.equal(summarisePreview(null).totals.newRecipients, 0);
});

test('"nothing detected" explains itself and never says all clear', () => {
  for (const reason of ['no-subscribers', 'source-stale', 'source-unavailable', 'something-new']) assert.doesNotMatch(reasonText(reason), /all[- ]clear|\bsafe\b/i);
  // The only place the phrase appears is to deny it.
  assert.match(reasonText('no-hazard'), /not an all-clear/);
  assert.doesNotMatch(reasonText('no-hazard').replace('not an all-clear', ''), /all[- ]clear|\bsafe\b/i);
  assert.match(reasonText('no-subscribers'), /No subscribers/);
  assert.match(reasonText('source-stale'), /stale/);
  assert.match(reasonText('source-unavailable'), /unavailable/);
  assert.equal(reasonText('something-new'), 'Nothing to send.');
});

test('the recipient breakdown counts new and released people by role and by area', () => {
  const preview = { groups: [group({ newCount: 2, released: 1 }), group({ occupation: 'vendor', affectedArea: { name: 'Savar' }, newCount: 5 }), group({ occupation: 'fisherman', alreadySent: 9 })] };
  const breakdown = recipientBreakdown(preview, options);
  assert.deepEqual(breakdown.byRole, [{ key: 'vendor', label: 'Vendor', count: 5 }, { key: 'farmer', label: 'Farmer', count: 3 }]);
  assert.deepEqual(breakdown.byArea, [{ key: 'Savar', label: 'Savar', count: 5 }, { key: 'Badda', label: 'Badda', count: 3 }]);
  assert.deepEqual(recipientBreakdown(null, options), { byRole: [], byArea: [] });
});

// ---------- confirmation ----------
test('confirmation needs: critical sends need a second confirmation, unsupported declarations a typed SEND, and empty sends are blocked', () => {
  const plain = confirmationNeeds({ totals: { newRecipients: 4, released: 1 }, requires: { critical: false, typed: null } });
  assert.deepEqual(plain, { recipients: 5, critical: false, typed: null, updatesExisting: false });
  assert.equal(confirmationReady(plain, {}), true);
  assert.equal(confirmPayload(plain, {}), undefined);

  const critical = confirmationNeeds({ totals: { newRecipients: 2, released: 0 }, requires: { critical: true, typed: null } });
  assert.equal(confirmationReady(critical, {}), false);
  assert.equal(confirmationReady(critical, { critical: false }), false);
  assert.equal(confirmationReady(critical, { critical: true }), true);
  assert.deepEqual(confirmPayload(critical, { critical: true }), { critical: true });

  const typed = confirmationNeeds({ totals: { newRecipients: 2, released: 0 }, requires: { critical: true, typed: 'SEND' } });
  assert.equal(confirmationReady(typed, { critical: true, typed: 'send' }), false, 'case matters');
  assert.equal(confirmationReady(typed, { critical: true, typed: 'SEND ' }), false);
  assert.equal(confirmationReady(typed, { critical: true, typed: 'SEND' }), true);
  assert.equal(confirmationReady(typed, { critical: false, typed: 'SEND' }), false);
  assert.deepEqual(confirmPayload(typed, { critical: true, typed: 'SEND' }), { typed: 'SEND', critical: true });

  const nothing = confirmationNeeds({ totals: { newRecipients: 0, released: 0 }, requires: {} });
  assert.equal(canSend(nothing), false);
  assert.equal(confirmationReady(nothing, {}), false);
  assert.equal(canSend(confirmationNeeds({ totals: { newRecipients: 0, released: 0 }, updatesExisting: true, requires: {} })), true);
});

test('the send body adds the preview token, a key and (only when needed) the confirmation', () => {
  const body = { mode: 'weather', roles: ['farmer'], areas: null, audience: 'live' };
  assert.deepEqual(sendBody(body, { previewToken: 'tok' }, 'adm-key-1'), { ...body, previewToken: 'tok', idempotencyKey: 'adm-key-1' });
  assert.deepEqual(sendBody(body, { previewToken: 'tok' }, 'adm-key-1', { critical: true }).confirm, { critical: true });
});

test('idempotency keys are unique, 8 to 80 characters, and work without crypto.randomUUID', () => {
  const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
  assert.equal(keys.size, 50);
  for (const key of keys) assert.ok(key.length >= 8 && key.length <= 80, key);
  assert.match(newIdempotencyKey(null), /^adm-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(newIdempotencyKey(() => 'x'.repeat(200)).length, 80);
});

test('errors are mapped to readable text, and an expired preview is recognised', () => {
  assert.equal(isPreviewExpired({ status: 409, message: 'Preview this send first (the preview expires after 10 minutes).' }), true);
  assert.equal(isPreviewExpired({ status: 409, message: 'The send no longer matches the preview. Preview it again.' }), true);
  assert.equal(isPreviewExpired({ status: 409, message: 'This sends a CRITICAL alert to 2 people. Confirm once more to send it.' }), false);
  assert.equal(isPreviewExpired({ status: 400, message: 'Preview' }), false);
  assert.equal(describeError({ message: 'At most 20 sends an hour.' }), 'At most 20 sends an hour.');
  assert.equal(describeError(null), 'Something went wrong. Please try again.');
  assert.equal(describeResult('weather', { result: { sent: 3, released: 1, alreadySent: 2 } }), '3 sent · 1 released · 2 already sent');
  assert.equal(describeResult('declare', { result: { sent: 2, updated: 1, alreadySent: 0 } }), '2 sent · 1 updated · 0 already sent');
  assert.equal(describeResult('message', { result: { sent: 1 } }), '1 sent · 0 already sent');
});

// ---------- time and held alerts ----------
test('times are shown in Bangladesh time', () => {
  assert.equal(bdDateTime('2026-10-11T04:00:00Z'), '11 Oct, 10:00 BST');
  assert.equal(bdDateTime('2026-10-11T10:00:00+06:00'), '11 Oct, 10:00 BST');
  assert.equal(bdDateTime('2026-10-10T18:30:00Z'), '11 Oct, 00:30 BST');
  assert.equal(bdDateTime(null), '—');
  assert.equal(bdDateTime('nonsense'), '—');
});

test('ages are readable and a held CRITICAL alert is flagged after ten minutes', () => {
  const now = Date.parse('2026-10-11T04:30:00Z');
  assert.equal(minutesSince('2026-10-11T04:00:00Z', now), 30);
  assert.equal(minutesSince(null, now), null);
  assert.equal(minutesSince('2026-10-11T05:00:00Z', now), 0, 'never negative');
  assert.deepEqual([ageLabel(0), ageLabel(5), ageLabel(60), ageLabel(65)], ['under a minute', '5 min', '1 h', '1 h 5 min']);
  assert.equal(ageLabel(null), '—');

  const quiet = heldStatus({ total: 0 }, now);
  assert.deepEqual(quiet, { total: 0, oldestMinutes: null, criticalMinutes: null, criticalOverdue: false });
  assert.equal(heldStatus({ total: 1, criticalOldestAt: '2026-10-11T04:21:00Z' }, now).criticalOverdue, false, '9 minutes');
  assert.equal(heldStatus({ total: 1, criticalOldestAt: '2026-10-11T04:20:00Z' }, now).criticalOverdue, false, 'exactly ten is not yet overdue');
  assert.equal(heldStatus({ total: 1, criticalOldestAt: '2026-10-11T04:19:00Z' }, now).criticalOverdue, true);
  assert.equal(heldStatus({ total: 2, oldestAt: '2026-10-11T04:00:00Z' }, now).oldestMinutes, 30);
});

test('automatic sends are tabulated by role and severity, and names fall back sensibly', () => {
  const rows = [
    { occupation: 'farmer', severity: 'WARNING', count: 3 }, { occupation: 'farmer', severity: 'CRITICAL', count: 1 },
    { occupation: 'vendor', severity: 'ADVISORY', count: 2 },
  ];
  assert.deepEqual(automaticMatrix(rows, options), [
    { role: 'farmer', label: 'Farmer', ADVISORY: 0, WARNING: 3, CRITICAL: 1 },
    { role: 'vendor', label: 'Vendor', ADVISORY: 2, WARNING: 0, CRITICAL: 0 },
  ]);
  assert.deepEqual(automaticMatrix([], options), []);
  assert.equal(roleLabel(options, 'fisherman'), 'Fisherman', 'a role the options do not list still has a name');
  assert.equal(roleLabel(null, 'unknown_role'), 'unknown_role');
});

test('hazard names are capitalised and observed lightning is told apart from a lightning threat', () => {
  assert.equal(hazardLabel('HEAVY_RAIN', options), 'Heavy rain');
  assert.equal(hazardLabel('OBSERVED_LIGHTNING', options), 'Lightning (observed)');
  assert.equal(hazardLabel('LIGHTNING_THREAT', options), 'Lightning (threat)');
  assert.equal(hazardLabel('SOMETHING_NEW', { hazards: [{ type: 'SOMETHING_NEW', label: { en: 'a new thing' } }] }), 'A new thing');
  assert.equal(hazardLabel('UNKNOWN_TYPE', null), 'UNKNOWN_TYPE');
});
