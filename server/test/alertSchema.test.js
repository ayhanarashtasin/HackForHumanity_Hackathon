import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OCCUPATIONS } from '../src/config/alertConstants.js';
import {
  OCCUPATION_DEFS, initialActivity, publicSchema, validateActivity, validateSubscription,
} from '../src/services/alerts/schema.js';
import { locationByPcode } from '../src/services/geo.js';
import {
  AMTALI, BADDA, COXS_BAZAR, SAVAR,
} from './support/alertFixtures.js';

const locations = locationByPcode;

const VALID = {
  farmer: { cropType: 'jute', cropStage: 'planting', irrigationAccess: 'none', outdoorHours: 'lt4', workload: 'light' },
  fisherman: { waterBody: 'river', operatingAreaPcodes: [BADDA, SAVAR], status: 'ashore' },
  construction: { activityType: 'ground', workload: 'moderate', ppeHeatBurden: 'none', siteExposure: 'indoor', shiftStart: '08:00', shiftEnd: '17:00' },
  vendor: { outdoorStall: false, shelterAccess: 'full', hoursOutdoor: 'gt8', savedMarketPcodes: [SAVAR] },
  student_public: { outdoorPlay: true },
  rickshaw_labourer: { shiftStart: '22:00', shiftEnd: '06:00', workload: 'heavy', outdoorExposure: 'mixed' },
};

const subscribe = (occupation, overrides = {}) => validateSubscription(
  { occupation, homeAreaPcode: BADDA, occupationData: VALID[occupation], consent: true, ...overrides },
  { locations },
);

test('every occupation accepts a valid profile and derives its areas', () => {
  for (const occupation of OCCUPATIONS) {
    const { value, errors } = subscribe(occupation);
    assert.deepEqual(errors, {}, occupation);
    assert.equal(value.occupation, occupation);
    assert.equal(value.language, 'bn', 'Bangla is the default language');
    assert.ok(value.areas.some((area) => area.role === 'home' && area.upazilaPcode === BADDA));
    assert.ok(value.relevantUpazilas.includes(BADDA));
    assert.ok(value.relevantDistricts.includes('3026'));
  }
});

test('the schema served to the client covers all six occupations with bilingual labels', () => {
  const schema = publicSchema();
  assert.equal(schema.occupations.length, 6);
  for (const occupation of schema.occupations) {
    assert.ok(occupation.label.en && occupation.label.bn);
    for (const field of occupation.fields) {
      assert.ok(field.label.en && field.label.bn, `${occupation.value}.${field.key}`);
      for (const option of field.options ?? []) assert.ok(option.label.en && option.label.bn, `${occupation.value}.${field.key}.${option.value}`);
    }
  }
  assert.ok(schema.consentText.en && schema.consentText.bn);
});

test('required answers, unknown keys and out-of-list options are rejected, and nothing is saved on error', () => {
  const missing = subscribe('farmer', { occupationData: { ...VALID.farmer, cropStage: undefined } });
  assert.equal(missing.value, null);
  assert.equal(missing.errors['occupationData.cropStage'], 'required');

  const outOfList = subscribe('farmer', { occupationData: { ...VALID.farmer, cropStage: 'dancing' } });
  assert.equal(outOfList.errors['occupationData.cropStage'], 'invalid');

  const unknownInner = subscribe('farmer', { occupationData: { ...VALID.farmer, hackerField: 1 } });
  assert.equal(unknownInner.errors['occupationData.hackerField'], 'unknown');

  const unknownTop = validateSubscription({ occupation: 'farmer', homeAreaPcode: BADDA, occupationData: VALID.farmer, consent: true, admin: true }, { locations });
  assert.equal(unknownTop.errors.admin, 'unknown');

  assert.equal(subscribe('astronaut').errors.occupation, 'invalid');
  assert.equal(validateSubscription({}, { locations }).errors.occupation, 'required');
  assert.equal(validateSubscription(null, { locations }).errors.body, 'invalid');
});

test('consent is mandatory, the honeypot rejects bots, and areas must exist', () => {
  assert.equal(subscribe('farmer', { consent: false }).errors.consent, 'consent');
  assert.equal(subscribe('farmer', { consent: undefined }).errors.consent, 'consent');
  assert.equal(subscribe('farmer', { website: 'http://spam.example' }).errors.website, 'bot');
  assert.equal(subscribe('farmer', { homeAreaPcode: '999999' }).errors.homeAreaPcode, 'invalid');
  assert.equal(subscribe('farmer', { homeAreaPcode: 'abc' }).errors.homeAreaPcode, 'invalid');
  assert.equal(subscribe('farmer', { homeAreaPcode: undefined }).errors.homeAreaPcode, 'required');
});

test('conditional fields: a hidden answer is dropped and a visible one is required', () => {
  // A river fisherman never needs a sea area; a stale answer is dropped, not an error.
  const river = subscribe('fisherman', { occupationData: { waterBody: 'river', marineZone: 'north_bay', status: 'ashore' } });
  assert.deepEqual(river.errors, {});
  assert.equal(river.value.occupationData.marineZone, undefined);

  const marine = subscribe('fisherman', { occupationData: { waterBody: 'marine', status: 'ashore' } });
  assert.equal(marine.errors['occupationData.marineZone'], 'required');
  const marineOk = subscribe('fisherman', { occupationData: { waterBody: 'marine', marineZone: 'north_bay', status: 'ashore' } });
  assert.deepEqual(marineOk.errors, {});
});

test('area fields default to the home area and add one area per role', () => {
  const { value } = subscribe('farmer', { homeAreaPcode: AMTALI });
  const field = value.areas.find((area) => area.role === 'field');
  assert.equal(field.upazilaPcode, AMTALI, 'the field defaults to home');
  assert.equal(value.occupationData.fieldAreaPcode, AMTALI);

  const elsewhere = subscribe('farmer', { occupationData: { ...VALID.farmer, fieldAreaPcode: SAVAR } });
  assert.deepEqual(elsewhere.value.relevantUpazilas.sort(), [BADDA, SAVAR].sort());
  assert.deepEqual(elsewhere.value.relevantDistricts, ['3026']);

  const gps = subscribe('farmer', { locationMethod: 'gps_nearest' });
  assert.equal(gps.value.areas.find((area) => area.role === 'home').matchMethod, 'gps_nearest');
  assert.equal(subscribe('farmer', { locationMethod: 'telepathy' }).errors.locationMethod, 'invalid');
});

test('lists of areas are capped and the whole profile never exceeds five areas', () => {
  assert.equal(subscribe('fisherman', { occupationData: { waterBody: 'river', status: 'ashore', operatingAreaPcodes: [BADDA, SAVAR, AMTALI, COXS_BAZAR] } }).errors['occupationData.operatingAreaPcodes'], 'too_many');
  const full = subscribe('vendor', { occupationData: { ...VALID.vendor, marketAreaPcode: SAVAR, savedMarketPcodes: [AMTALI, COXS_BAZAR] } });
  assert.deepEqual(full.errors, {});
  assert.equal(full.value.areas.length, 4, 'home + main market + two saved markets');
});

test('times, quiet hours and channels are validated', () => {
  assert.equal(subscribe('construction', { occupationData: { ...VALID.construction, shiftStart: '25:00' } }).errors['occupationData.shiftStart'], 'invalid');
  assert.equal(subscribe('construction', { occupationData: { ...VALID.construction, shiftEnd: '08:00' } }).errors['occupationData.shiftEnd'], 'invalid', 'a shift with no length');
  assert.equal(subscribe('construction', { occupationData: { ...VALID.construction, shiftStart: undefined } }).errors['occupationData.shiftStart'], 'required');

  const night = subscribe('rickshaw_labourer');
  assert.deepEqual(night.errors, {}, 'an overnight shift is allowed');

  const quiet = subscribe('farmer', { preferences: { quietHours: { enabled: true, start: '22:00', end: '06:00' }, channelInterest: ['sms', 'sms', 'push'] } });
  assert.deepEqual(quiet.value.preferences, { quietHours: { enabled: true, start: '22:00', end: '06:00' }, channelInterest: ['sms', 'push'] });
  assert.equal(subscribe('farmer', { preferences: { quietHours: { enabled: 'yes' } } }).errors['preferences.quietHours'], 'invalid');
  assert.equal(subscribe('farmer', { preferences: { channelInterest: ['pigeon'] } }).errors['preferences.channelInterest'], 'invalid');
  assert.equal(subscribe('farmer', { preferences: { colour: 'green' } }).errors['preferences.colour'], 'unknown');
});

test('commute times default for students and guardian management is stored at the top level', () => {
  const student = subscribe('student_public', { occupationData: { outdoorPlay: false, guardianManaged: true } });
  assert.equal(student.value.occupationData.commuteStart, '07:00');
  assert.equal(student.value.occupationData.commuteEnd, '09:00');
  assert.equal(student.value.guardianManaged, true);
  assert.equal(student.value.occupationData.guardianManaged, undefined);
  assert.equal(subscribe('farmer', { isHeatSensitive: 'sometimes' }).errors.isHeatSensitive, 'invalid');
  assert.equal(subscribe('farmer', { isHeatSensitive: true }).value.isHeatSensitive, true);
});

test('only a fisherman who is not on shore starts with an activity, and it expires', () => {
  const now = new Date('2026-10-11T04:00:00Z');
  const onWater = subscribe('fisherman', { occupationData: { waterBody: 'river', status: 'on_water' } }).value;
  const activity = initialActivity(onWater, now, 12);
  assert.equal(activity.key, 'on_water');
  assert.equal(+activity.expiresAt - +activity.since, 12 * 3_600_000);

  const ashore = subscribe('fisherman', { occupationData: { waterBody: 'river', status: 'ashore' } }).value;
  assert.equal(initialActivity(ashore, now, 12), null);
  assert.equal(initialActivity(subscribe('farmer').value, now, 12), null);
});

test('a quick status accepts known activities, clears with null, and respects the maximum duration', () => {
  assert.deepEqual(validateActivity({ key: 'on_road' }, 12), { key: 'on_road', hours: 12 });
  assert.deepEqual(validateActivity({ key: 'on_road', hours: 3 }, 12), { key: 'on_road', hours: 3 });
  assert.deepEqual(validateActivity({ key: null }, 12), { key: null });
  assert.equal(validateActivity({ key: 'flying' }, 12).error, 'invalid');
  assert.equal(validateActivity({ key: 'on_road', hours: 99 }, 12).error, 'invalid');
  assert.equal(validateActivity({ key: 'on_road', hours: 0 }, 12).error, 'invalid');
  assert.equal(validateActivity({ key: 'on_road', extra: 1 }, 12).error, 'invalid');
  assert.equal(validateActivity('on_road', 12).error, 'invalid');
});

test('the occupation definitions match the fields the scenarios read', () => {
  const keys = (occupation) => OCCUPATION_DEFS[occupation].fields.map((field) => field.key);
  assert.ok(keys('farmer').includes('cropStage'));
  assert.ok(keys('construction').includes('ppeHeatBurden'));
  assert.ok(keys('vendor').includes('shelterAccess'));
  assert.ok(keys('rickshaw_labourer').includes('outdoorExposure'));
  assert.ok(keys('student_public').includes('commuteStart'));
  assert.ok(keys('fisherman').includes('waterBody'));
});
