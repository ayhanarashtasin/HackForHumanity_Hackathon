import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ageText, digits, evidenceRows, formatDhaka, number, referenceHref } from '../src/alert/format.js';
import { criticalKey, optimisticRead, withOptimisticRead } from '../src/alert/inboxState.js';
import { STRINGS, t } from '../src/alert/i18n.js';
import {
  ERROR_MESSAGES, STEPS, answersFromProfile, areaLabel, buildAreaIndex, buildPayload, defaultAnswers, defaultsFor, describeAnswers, errorMessage,
  errorStep, fieldDomId, fieldMissing, firstErrorPath, firstErrorStep, isVisible, mapHref, pcodeFromSelection, searchAreas, setField, validateAll,
  validateStep, visibleFields, withOccupation,
} from '../src/lib/alertForm.js';
// The real server schema and validator: the form logic is tested against what the server will actually accept.
import { publicSchema, validateSubscription } from '../../server/src/services/alerts/schema.js';
import { locationByPcode } from '../../server/src/services/geo.js';

const schema = publicSchema();
const def = (occupation) => schema.occupations.find((item) => item.value === occupation);
const catalogue = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
const index = buildAreaIndex(catalogue);
const BADDA = '302604';
const SAVAR = '302672';

test('reading a lightning card does not hide the two allowed later re-notifications, and silent updates keep it read', () => {
  const item = { id: 'episode-card', severity: 'CRITICAL', renotifications: 0, readAt: null };
  const reads = { [item.id]: optimisticRead(item, '2026-10-11T04:00:00Z') };
  assert.ok(withOptimisticRead({ ...item, updatedAt: 'later evidence' }, reads).readAt);
  for (const stage of [1, 2]) {
    const development = { ...item, renotifications: stage };
    assert.equal(withOptimisticRead(development, reads).readAt, null);
    assert.notEqual(criticalKey(development), criticalKey(item));
  }
  assert.equal(withOptimisticRead({ ...item, severity: 'WARNING' }, reads).readAt, null);
});

test('document reference links accept only absolute HTTP or HTTPS URLs', () => {
  assert.equal(referenceHref('https://bmd.gov.bd/notice.pdf'), 'https://bmd.gov.bd/notice.pdf');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', '/relative.pdf', null, 'not a link']) assert.equal(referenceHref(value), null);
});

// Answers a person could plausibly give, built from the schema itself so every occupation is exercised.
function filledAnswers(occupation) {
  let answers = withOccupation({ ...defaultAnswers('en'), homeAreaPcode: BADDA, consent: true }, def(occupation));
  let again = true;
  while (again) {
    again = false;
    for (const field of visibleFields(def(occupation), answers.occupationData)) {
      const value = answers.occupationData[field.key];
      if (field.type === 'select' && value === undefined) { answers = setField(answers, field.key, field.options[0].value); again = true; }
      if (field.type === 'boolean' && typeof value !== 'boolean') { answers = setField(answers, field.key, false); again = true; }
      if (field.type === 'time' && value === undefined) { answers = setField(answers, field.key, field.key.endsWith('End') ? '17:00' : '08:00'); again = true; }
    }
  }
  return answers;
}

// ---------- which fields show, and what they start as ----------
test('a conditional field shows only when its condition holds', () => {
  const fisherman = def('fisherman');
  const keys = (data) => visibleFields(fisherman, data).map((field) => field.key);
  assert.deepEqual(keys({ waterBody: 'river' }), ['waterBody', 'operatingAreaPcodes', 'status']);
  assert.deepEqual(keys({ waterBody: 'marine' }), ['waterBody', 'marineZone', 'status']);
  assert.deepEqual(keys({}), ['waterBody', 'status'], 'nothing chosen yet: only the unconditional questions');
  assert.equal(isVisible({ key: 'x' }, {}), true);
  assert.equal(isVisible({ showIf: { key: 'a', equals: 1 } }, { a: 1 }), true);
  assert.equal(isVisible({ showIf: { key: 'a', equals: 1 } }, { a: 2 }), false);
});

test('answers start from the schema defaults and a new occupation starts afresh', () => {
  assert.deepEqual(defaultsFor(def('fisherman')), { status: 'ashore' });
  assert.deepEqual(defaultsFor(def('student_public')), { commuteStart: '07:00', commuteEnd: '09:00' });
  assert.deepEqual(defaultsFor(def('farmer')), {});

  const farmer = setField(withOccupation(defaultAnswers('en'), def('farmer')), 'cropStage', 'harvesting');
  assert.equal(withOccupation(farmer, def('farmer')), farmer, 'choosing the same occupation again keeps the answers');
  const student = withOccupation(farmer, def('student_public'));
  assert.equal(student.occupation, 'student_public');
  assert.deepEqual(student.occupationData, { commuteStart: '07:00', commuteEnd: '09:00' }, 'a farmer\'s answers mean nothing to a student');
  assert.equal(defaultAnswers().language, 'bn', 'Bangla is the default language');
});

// ---------- what is missing ----------
test('required handling: an unanswered required field is missing, an optional one never is, and "no" is an answer', () => {
  assert.equal(fieldMissing({ required: true, type: 'select' }, undefined), true);
  assert.equal(fieldMissing({ required: true, type: 'select' }, ''), true);
  assert.equal(fieldMissing({ required: true, type: 'select' }, 'x'), false);
  assert.equal(fieldMissing({ required: true, type: 'boolean' }, undefined), true);
  assert.equal(fieldMissing({ required: true, type: 'boolean' }, false), false, '"No" is a real answer');
  assert.equal(fieldMissing({ required: false, type: 'area' }, ''), false);
  assert.equal(fieldMissing({ required: true, type: 'areas' }, []), true);
});

test('each step reports what is missing, in the server\'s vocabulary', () => {
  const answers = defaultAnswers('en');
  assert.deepEqual(validateStep('who', answers, null), { occupation: 'required' });
  assert.deepEqual(validateStep('who', answers, def('farmer')), {});
  assert.deepEqual(validateStep('where', answers, null), { homeAreaPcode: 'required' });
  assert.deepEqual(validateStep('where', { ...answers, homeAreaPcode: BADDA }, null), {});

  const farmer = withOccupation(answers, def('farmer'));
  const errors = validateStep('work', farmer, def('farmer'));
  assert.deepEqual(Object.keys(errors).sort(), ['occupationData.cropStage', 'occupationData.cropType', 'occupationData.irrigationAccess', 'occupationData.outdoorHours', 'occupationData.workload']);
  assert.ok(Object.values(errors).every((code) => code === 'required'));
  assert.deepEqual(validateStep('work', filledAnswers('farmer'), def('farmer')), {});

  // A hidden conditional field is never required.
  const river = withOccupation(answers, def('fisherman'));
  assert.deepEqual(validateStep('work', setField(river, 'waterBody', 'river'), def('fisherman')), {});
  assert.deepEqual(validateStep('work', setField(river, 'waterBody', 'marine'), def('fisherman')), { 'occupationData.marineZone': 'required' });
});

test('work-step checks: times, equal shift times and too many areas', () => {
  const construction = filledAnswers('construction');
  assert.deepEqual(validateStep('work', setField(construction, 'shiftEnd', '08:00'), def('construction')), { 'occupationData.shiftEnd': 'invalid' });
  assert.deepEqual(validateStep('work', setField(construction, 'shiftStart', '25:00'), def('construction')), { 'occupationData.shiftStart': 'invalid' });
  assert.deepEqual(validateStep('work', setField(construction, 'shiftStart', ''), def('construction')), { 'occupationData.shiftStart': 'required' });

  const fisherman = setField(setField(filledAnswers('fisherman'), 'waterBody', 'river'), 'operatingAreaPcode', undefined);
  const four = setField(fisherman, 'operatingAreaPcodes', [BADDA, SAVAR, '100409', '202224']);
  assert.deepEqual(validateStep('work', four, def('fisherman')), { 'occupationData.operatingAreaPcodes': 'too_many' });
});

test('preferences and review: quiet hours must be real times and consent is mandatory', () => {
  const answers = defaultAnswers('en');
  assert.deepEqual(validateStep('prefs', answers, null), {});
  const quiet = (patch) => ({ ...answers, preferences: { ...answers.preferences, quietHours: { ...answers.preferences.quietHours, enabled: true, ...patch } } });
  assert.deepEqual(validateStep('prefs', quiet({}), null), {});
  assert.deepEqual(validateStep('prefs', quiet({ start: '' }), null), { 'preferences.quietHours': 'invalid' });
  assert.deepEqual(validateStep('review', answers, null), { consent: 'consent' });
  assert.deepEqual(validateStep('review', { ...answers, consent: true }, null), {});
  assert.deepEqual(Object.keys(validateAll(answers, null)).sort(), ['consent', 'homeAreaPcode', 'occupation']);
});

// ---------- answers -> request body ----------
test('the payload carries visible answers only, drops empty areas so the server defaults them, and keeps "no"', () => {
  const base = filledAnswers('fisherman');
  const river = setField(setField(base, 'waterBody', 'river'), 'marineZone', 'north_bay');
  const payload = buildPayload(river, def('fisherman'));
  assert.deepEqual(payload.occupationData, { waterBody: 'river', status: 'ashore' }, 'a hidden answer is dropped, an empty area list is omitted');
  assert.equal(payload.occupation, 'fisherman');
  assert.equal(payload.homeAreaPcode, BADDA);
  assert.equal(payload.consent, true);
  assert.equal(payload.website, '');
  assert.equal(payload.locationMethod, 'manual');

  const withAreas = setField(river, 'operatingAreaPcodes', [SAVAR, SAVAR, BADDA]);
  assert.deepEqual(buildPayload(withAreas, def('fisherman')).occupationData.operatingAreaPcodes, [SAVAR, BADDA], 'duplicates removed');

  const vendor = setField(filledAnswers('vendor'), 'outdoorStall', false);
  assert.equal(buildPayload(vendor, def('vendor')).occupationData.outdoorStall, false);
  const gps = { ...filledAnswers('farmer'), locationMethod: 'gps_nearest' };
  assert.equal(buildPayload(gps, def('farmer')).locationMethod, 'gps_nearest');
  assert.equal(buildPayload({ ...gps, locationMethod: 'anything' }, def('farmer')).locationMethod, 'manual');

  const prefs = { ...filledAnswers('farmer'), isHeatSensitive: true, preferences: { quietHours: { enabled: true, start: '21:00', end: '05:30' }, channelInterest: ['sms', 'sms'] } };
  const built = buildPayload(prefs, def('farmer'));
  assert.deepEqual(built.preferences, { quietHours: { enabled: true, start: '21:00', end: '05:30' }, channelInterest: ['sms'] });
  assert.equal(built.isHeatSensitive, true);
});

test('for every occupation the payload the form builds is accepted by the real server validator', () => {
  for (const occupation of schema.occupations.map((item) => item.value)) {
    const answers = filledAnswers(occupation);
    assert.deepEqual(validateStep('work', answers, def(occupation)), {}, occupation);
    const { value, errors } = validateSubscription(buildPayload(answers, def(occupation)), { locations: locationByPcode });
    assert.deepEqual(errors, {}, occupation);
    assert.equal(value.occupation, occupation);
  }

  // The conditional branches too: open sea, river with areas, a student with a commute and play.
  const marine = setField(setField(filledAnswers('fisherman'), 'waterBody', 'marine'), 'marineZone', 'north_bay');
  assert.deepEqual(validateSubscription(buildPayload(marine, def('fisherman')), { locations: locationByPcode }).errors, {});
  const river = setField(setField(filledAnswers('fisherman'), 'waterBody', 'river'), 'operatingAreaPcodes', [SAVAR]);
  const result = validateSubscription(buildPayload(river, def('fisherman')), { locations: locationByPcode });
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value.relevantUpazilas.sort(), [BADDA, SAVAR].sort());
});

test('the server rejects what the client would not send: a missing answer is the same error code on both sides', () => {
  const answers = withOccupation({ ...defaultAnswers('en'), homeAreaPcode: BADDA, consent: true }, def('farmer'));
  const client = validateStep('work', answers, def('farmer'));
  const server = validateSubscription(buildPayload(answers, def('farmer')), { locations: locationByPcode }).errors;
  assert.deepEqual(client, server, 'the page flags exactly the fields the server would');
});

// ---------- profile -> answers (editing) ----------
test('editing starts from the saved profile, including a fisherman\'s live status and top-level flags', () => {
  const profile = {
    occupation: 'student_public',
    language: 'bn',
    occupationData: { commuteStart: '07:30', commuteEnd: '09:00', schoolOrWorkAreaPcode: SAVAR, outdoorPlay: true },
    guardianManaged: true,
    isHeatSensitive: true,
    preferences: { quietHours: { enabled: true, start: '22:00', end: '06:00' }, channelInterest: ['push'] },
    areas: [{ role: 'home', upazilaPcode: BADDA, matchMethod: 'gps_nearest' }, { role: 'work', upazilaPcode: SAVAR, matchMethod: 'manual' }],
    activeActivity: null,
  };
  const answers = answersFromProfile(profile, def('student_public'));
  assert.equal(answers.homeAreaPcode, BADDA);
  assert.equal(answers.locationMethod, 'gps_nearest');
  assert.equal(answers.occupationData.guardianManaged, true, 'stored at the top level by the server, a normal answer in the form');
  assert.equal(answers.consent, true);
  assert.deepEqual(answers.preferences.channelInterest, ['push']);
  const { errors } = validateSubscription(buildPayload(answers, def('student_public')), { locations: locationByPcode });
  assert.deepEqual(errors, {});

  const fisherman = { ...profile, occupation: 'fisherman', occupationData: { waterBody: 'coastal', status: 'ashore' }, activeActivity: { key: 'on_water' } };
  assert.equal(answersFromProfile(fisherman, def('fisherman')).occupationData.status, 'on_water');
  assert.equal(answersFromProfile({ ...fisherman, activeActivity: { key: 'on_road' } }, def('fisherman')).occupationData.status, 'ashore');
});

// ---------- server errors ----------
test('every error code has a message in both languages, and unknown codes fall back to "invalid"', () => {
  for (const code of ['required', 'invalid', 'unknown', 'too_many', 'consent', 'bot']) {
    assert.ok(ERROR_MESSAGES[code].en && ERROR_MESSAGES[code].bn, code);
  }
  assert.match(errorMessage('required', 'bn'), /উত্তর/);
  assert.equal(errorMessage('required', 'en'), 'Please answer this.');
  assert.equal(errorMessage('something-new', 'en'), ERROR_MESSAGES.invalid.en);
});

test('an error path maps to its wizard step, and the first step with an error is the one to show', () => {
  assert.equal(errorStep('occupation'), 'who');
  assert.equal(errorStep('language'), 'who');
  assert.equal(errorStep('homeAreaPcode'), 'where');
  assert.equal(errorStep('occupationData.cropStage'), 'work');
  assert.equal(errorStep('preferences.quietHours'), 'prefs');
  assert.equal(errorStep('isHeatSensitive'), 'prefs');
  assert.equal(errorStep('consent'), 'review');
  assert.equal(errorStep('website'), 'review');
  assert.equal(errorStep('areas'), 'review');
  assert.equal(firstErrorStep({ consent: 'consent', 'occupationData.x': 'required' }), 'work');
  assert.equal(firstErrorStep({}), null);
  assert.deepEqual(STEPS, ['who', 'where', 'work', 'prefs', 'review']);
});

test('focus goes to the first field on the page that has an error, and field ids are valid DOM ids', () => {
  const farmer = withOccupation(defaultAnswers('en'), def('farmer'));
  const errors = { 'occupationData.workload': 'required', 'occupationData.cropStage': 'required', consent: 'consent' };
  assert.equal(firstErrorPath(errors, 'work', def('farmer'), farmer), 'occupationData.cropStage', 'schema order, not error order');
  assert.equal(firstErrorPath(errors, 'review', def('farmer'), farmer), 'consent');
  assert.equal(firstErrorPath({}, 'work', def('farmer'), farmer), null);
  assert.equal(fieldDomId('occupationData.cropStage'), 'field-occupationData-cropStage');
  assert.equal(fieldDomId('preferences.quietHours'), 'field-preferences-quietHours');
});

// ---------- areas ----------
test('the area index finds places by English name, Bangla name or code, and labels them in either language', () => {
  assert.equal(index.divisions.length, 8);
  assert.equal([...index.districtsByDivision.values()].reduce((sum, list) => sum + list.length, 0), 64);
  assert.equal(index.locationByPcode.size, 544);
  assert.ok(index.locationsByDistrict.get('3026').some((location) => location.pcode === BADDA));

  assert.equal(searchAreas(index, 'badd')[0].pcode, BADDA);
  assert.equal(searchAreas(index, 'BADDA')[0].pcode, BADDA, 'case-insensitive');
  assert.equal(searchAreas(index, 'বাড্ডা')[0].pcode, BADDA, 'Bangla names work too');
  assert.equal(searchAreas(index, '3026')[0].pcode.startsWith('3026'), true, 'by code');
  assert.deepEqual(searchAreas(index, 'b'), [], 'one letter is too little');
  assert.deepEqual(searchAreas(index, 'zzzzqq'), []);
  assert.ok(searchAreas(index, 'a', 1).length === 0 && searchAreas(index, 'sa', 3).length <= 3);

  assert.equal(areaLabel(index, BADDA, 'en'), 'Badda, Dhaka');
  assert.equal(areaLabel(index, BADDA, 'bn'), 'বাড্ডা, ঢাকা');
  assert.equal(areaLabel(index, '999999', 'en'), '999999', 'an unknown code is shown as it is');
});

test('a location match becomes a BMD location: an upazila as it is, a polygon through its nearest forecast point', () => {
  assert.equal(pcodeFromSelection({ level: 'upazila', id: BADDA }, catalogue), BADDA);
  assert.equal(pcodeFromSelection({ level: 'upazila', id: '000000' }, catalogue), null, 'not a selectable location');
  const [pid, polygon] = Object.entries(catalogue.polygons).find(([, value]) => value.approx);
  assert.equal(pcodeFromSelection({ level: 'polygon', id: pid }, catalogue), polygon.src[0]);
  assert.ok(index.locationByPcode.has(polygon.src[0]), 'and that is a location the server knows');
  assert.equal(pcodeFromSelection({ level: 'polygon', id: 'nope' }, catalogue), null);
  assert.equal(pcodeFromSelection(null, catalogue), null);
});

test('"View on map" links to a hash the map page accepts, or nothing when the place is unknown', () => {
  const upazila = mapHref({ scope: 'upazila', upazilaPcode: BADDA }, index);
  const [lat, lon] = /view=([\d.]+),([\d.]+),9z$/.exec(upazila).slice(1).map(Number);
  assert.ok(upazila.startsWith('/map#view='));
  assert.ok(lat >= 15 && lat <= 32 && lon >= 82 && lon <= 100, 'inside the range the map accepts');
  assert.match(mapHref({ scope: 'district', districtPcode: '3026' }, index, 8), /^\/map#view=[\d.]+,[\d.]+,8z$/);
  assert.equal(mapHref({ scope: 'upazila', upazilaPcode: '999999' }, index), null);
  assert.equal(mapHref({ scope: 'marine', text: 'Bay of Bengal' }, index), null);
  assert.equal(mapHref(null, index), null);
});

test('the numbers behind an alert become labelled rows, in the page language', () => {
  const tr = (key) => t('en', key);
  const rows = evidenceRows({ metrics: { rain3hMm: 62.5, popPercent: 80, indicator: 'heat-index', dryDays: 9, ignored: 'text' }, statusAgeHours: 2 }, tr, 'en');
  assert.deepEqual(rows.map((row) => row.key), ['rain3hMm', 'popPercent', 'dryDays', 'indicator', 'statusAgeHours']);
  assert.match(rows[0].value, /^62\.5 /);
  assert.equal(rows[2].value, '9', 'a unitless count is just the number');
  assert.ok(rows.every((row) => row.label && !row.label.startsWith('ev.') && !row.value.includes('unit.')), 'no raw key leaks into the page');
  assert.match(evidenceRows({ metrics: { rain3hMm: 62.5 } }, (key) => t('bn', key), 'bn')[0].value, /^৬২\.৫ /);
  assert.deepEqual(evidenceRows(null, tr, 'en'), []);
  assert.deepEqual(evidenceRows({ metrics: {} }, tr, 'en'), []);
});

test('answers are described in plain words for the review step', () => {
  const answers = setField(filledAnswers('farmer'), 'cropStage', 'harvesting');
  const rows = describeAnswers(answers, def('farmer'), index, 'en');
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.equal(byKey.cropStage.value, 'Harvesting');
  assert.equal(byKey.cropStage.label, 'Crop stage now');
  assert.equal(byKey.fieldAreaPcode.value, 'Same as my home area', 'an unset area says what will happen');
  const bn = describeAnswers(setField(answers, 'fieldAreaPcode', BADDA), def('farmer'), index, 'bn');
  assert.equal(bn.find((row) => row.key === 'fieldAreaPcode').value, 'বাড্ডা, ঢাকা');
  assert.equal(describeAnswers(setField(filledAnswers('vendor'), 'outdoorStall', true), def('vendor'), index, 'en').find((row) => row.key === 'outdoorStall').value, 'Yes');
});

// ---------- time, numbers and strings ----------
test('times are Bangladesh time on a 24-hour clock, with Bengali digits in Bangla', () => {
  assert.equal(formatDhaka('2026-10-10T09:42:00Z', 'en'), '10 Oct, 15:42');
  assert.equal(formatDhaka('2026-10-10T09:42:00Z', 'bn'), '১০ অক্টোবর, ১৫:৪২');
  assert.equal(formatDhaka('2026-10-10T20:30:00Z', 'en'), '11 Oct, 02:30', 'past midnight in Bangladesh');
  assert.equal(formatDhaka('2026-10-10T09:42:00Z', 'en', { withDate: false }), '15:42');
  assert.equal(formatDhaka('nonsense', 'en'), '');
  assert.equal(formatDhaka(undefined, 'en'), '');
  assert.equal(digits('12:30 and 7.5', 'bn'), '১২:৩০ and ৭.৫');
  assert.equal(digits('12:30', 'en'), '12:30');
  assert.equal(number(12, 'bn'), '১২');
  assert.equal(number(7.46, 'en'), '7.5');
});

test('last-checked ages never go negative and read naturally in both languages', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(ageText('2026-10-10T11:59:40Z', 'en', now), 'just now');
  assert.equal(ageText('2026-10-10T11:55:00Z', 'en', now), '5 min ago');
  assert.equal(ageText('2026-10-10T11:55:00Z', 'bn', now), '৫ মিনিট আগে');
  assert.equal(ageText('2026-10-10T09:00:00Z', 'en', now), '3 h ago');
  assert.equal(ageText('2026-10-07T12:00:00Z', 'en', now), '3 d ago');
  assert.equal(ageText('2026-10-10T12:05:00Z', 'en', now), 'just now', 'a time slightly in the future is "just now"');
  assert.equal(ageText(null, 'en', now), '');
});

test('English and Bangla have exactly the same strings, with the same placeholders, and none is empty', () => {
  const english = Object.keys(STRINGS.en).sort();
  const bangla = Object.keys(STRINGS.bn).sort();
  assert.deepEqual(bangla.filter((key) => !english.includes(key)), [], 'a Bangla string with no English twin');
  assert.deepEqual(english.filter((key) => !bangla.includes(key)), [], 'an English string with no Bangla twin');
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of english) {
    assert.ok(STRINGS.en[key].trim() && STRINGS.bn[key].trim(), key);
    assert.equal(placeholders(STRINGS.bn[key]), placeholders(STRINGS.en[key]), `placeholders of ${key}`);
  }
});

test('translating fills placeholders, localises digits only where it should, and shows a missing parameter', () => {
  assert.equal(t('en', 'wizard.progress', { n: 2, total: 5 }), 'Step 2 of 5');
  assert.equal(t('bn', 'wizard.progress', { n: 2, total: 5 }), 'ধাপ ২ / ৫');
  assert.equal(t('bn', 'area.selected', { name: 'Badda 01' }), 'বাছাই করা: Badda 01', 'a name is text, so its digits are left alone');
  assert.equal(t('bn', 'card.valid', { time: '১৫:৪২' }), '১৫:৪২ পর্যন্ত বলবৎ');
  assert.equal(t('en', 'card.valid', { time: '15:42' }), 'Valid until 15:42');
  assert.equal(t('en', 'wizard.progress', { n: 2 }), 'Step 2 of {total}', 'a bug stays visible');
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
  assert.equal(t('bn', 'saved.monitoring.areas', { n: 12 }), 'সবার জন্য পর্যবেক্ষণে থাকা এলাকা: ১২টি।');
});
