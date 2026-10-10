// Pure logic behind the alert form: which fields show, what is missing, how answers become the request body, and what a server error means.
// The form itself is rendered from the schema the server serves (GET /api/alerts/schema); nothing here knows an occupation by name.
export const STEPS = ['who', 'where', 'work', 'prefs', 'review'];
export const DEFAULT_LANGUAGE = 'bn';
export const DEFAULT_QUIET_HOURS = { enabled: false, start: '22:00', end: '06:00' };

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (value) => typeof value === 'string' && HM.test(value);
const isEmpty = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

export function pick(text, lang) {
  return text && typeof text === 'object' ? (text[lang] ?? text.en ?? '') : (text ?? '');
}

// ---------- which fields show ----------
export function isVisible(field, data) {
  if (!field.showIf) return true;
  const current = data?.[field.showIf.key];
  return field.showIf.in ? field.showIf.in.includes(current) : current === field.showIf.equals;
}

export function visibleFields(def, data) {
  return (def?.fields ?? []).filter((field) => isVisible(field, data));
}

// Answers a field starts with: only the fields the schema gives a default (a select such as "right now: on shore", or a commute time).
export function defaultsFor(def) {
  const data = {};
  for (const field of def?.fields ?? []) if (field.default !== undefined) data[field.key] = field.default;
  return data;
}

export function defaultAnswers(language = DEFAULT_LANGUAGE) {
  return {
    occupation: '',
    language,
    homeAreaPcode: '',
    locationMethod: 'manual',
    occupationData: {},
    isHeatSensitive: false,
    preferences: { quietHours: { ...DEFAULT_QUIET_HOURS }, channelInterest: [] },
    consent: false,
    website: '',
  };
}

// Changing the occupation starts that occupation's questions afresh (an answer to one role's question means nothing to another).
export function withOccupation(answers, def) {
  if (answers.occupation === def.value) return answers;
  return { ...answers, occupation: def.value, occupationData: defaultsFor(def) };
}

export function setField(answers, key, value) {
  return { ...answers, occupationData: { ...answers.occupationData, [key]: value } };
}

export function setPreferences(answers, patch) {
  return { ...answers, preferences: { ...answers.preferences, ...patch } };
}

// ---------- what is missing ----------
export function fieldMissing(field, value) {
  if (!field.required) return false;
  if (field.type === 'boolean') return typeof value !== 'boolean';
  return isEmpty(value);
}

// A map of field path -> error code, in the same vocabulary the server uses (required | invalid | too_many | consent).
export function validateStep(step, answers, def) {
  const errors = {};

  if (step === 'who') {
    if (!def) errors.occupation = 'required';
  } else if (step === 'where') {
    if (!answers.homeAreaPcode) errors.homeAreaPcode = 'required';
  } else if (step === 'work' && def) {
    const data = answers.occupationData;
    for (const field of visibleFields(def, data)) {
      const path = `occupationData.${field.key}`;
      const value = data[field.key];
      if (fieldMissing(field, value)) errors[path] = 'required';
      else if (field.type === 'time' && !isEmpty(value) && !isTime(value)) errors[path] = 'invalid';
      else if (field.type === 'areas' && Array.isArray(value) && value.length > field.max) errors[path] = 'too_many';
    }
    if (data.shiftStart && data.shiftEnd && data.shiftStart === data.shiftEnd && !errors['occupationData.shiftEnd']) errors['occupationData.shiftEnd'] = 'invalid';
  } else if (step === 'prefs') {
    const quiet = answers.preferences.quietHours;
    if (quiet.enabled && (!isTime(quiet.start) || !isTime(quiet.end))) errors['preferences.quietHours'] = 'invalid';
  } else if (step === 'review') {
    if (answers.consent !== true) errors.consent = 'consent';
  }
  return errors;
}

export function validateAll(answers, def) {
  return STEPS.reduce((errors, step) => ({ ...errors, ...validateStep(step, answers, def) }), {});
}

// The step a server error belongs to, so the wizard can jump back to the right place.
export function errorStep(path) {
  if (path === 'occupation') return 'who';
  if (path === 'homeAreaPcode' || path === 'locationMethod') return 'where';
  if (path.startsWith('occupationData')) return 'work';
  if (path === 'language') return 'who';
  if (path.startsWith('preferences') || path === 'isHeatSensitive') return 'prefs';
  return 'review'; // consent, website, areas, body
}

export function firstErrorStep(errors) {
  const steps = new Set(Object.keys(errors).map(errorStep));
  return STEPS.find((step) => steps.has(step)) ?? null;
}

// Fields in the order the page shows them, so focus goes to the first one a person has to fix.
export function firstErrorPath(errors, step, def, answers) {
  const paths = Object.keys(errors).filter((path) => errorStep(path) === step);
  if (!paths.length) return null;
  if (step === 'work' && def) {
    const order = visibleFields(def, answers?.occupationData ?? {}).map((field) => `occupationData.${field.key}`);
    return order.find((path) => paths.includes(path)) ?? paths[0];
  }
  return paths[0];
}

export const fieldDomId = (path) => `field-${String(path).replace(/[^a-z0-9]+/gi, '-')}`;

export const ERROR_MESSAGES = {
  required: { en: 'Please answer this.', bn: 'অনুগ্রহ করে এটির উত্তর দিন।' },
  invalid: { en: 'This answer is not valid. Please check it.', bn: 'এই উত্তরটি সঠিক নয়। অনুগ্রহ করে দেখে নিন।' },
  unknown: { en: 'This answer is not recognised.', bn: 'এই উত্তরটি চেনা যায়নি।' },
  too_many: { en: 'Too many choices. Remove one.', bn: 'অনেক বেশি বাছাই করা হয়েছে। একটি বাদ দিন।' },
  consent: { en: 'Please tick the box to agree before you start.', bn: 'শুরু করার আগে সম্মতির ঘরে টিক দিন।' },
  bot: { en: 'This form could not be saved. Please reload the page and try again.', bn: 'ফর্মটি সংরক্ষণ করা যায়নি। পাতাটি রিলোড করে আবার চেষ্টা করুন।' },
};

export function errorMessage(code, lang = 'en') {
  const entry = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.invalid;
  return entry[lang] ?? entry.en;
}

// ---------- answers -> request body ----------
export function buildPayload(answers, def) {
  const data = {};
  for (const field of visibleFields(def, answers.occupationData)) {
    const value = answers.occupationData[field.key];
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') data[field.key] = value;
    } else if (field.type === 'areas') {
      // An empty list means "not chosen": omitted, so the server can apply the default (the home area).
      if (Array.isArray(value) && value.length) data[field.key] = [...new Set(value)];
    } else if (!isEmpty(value)) {
      data[field.key] = value;
    }
  }

  const quiet = answers.preferences.quietHours;
  return {
    occupation: answers.occupation,
    language: answers.language,
    homeAreaPcode: answers.homeAreaPcode,
    locationMethod: answers.locationMethod === 'gps_nearest' ? 'gps_nearest' : 'manual',
    occupationData: data,
    isHeatSensitive: answers.isHeatSensitive === true,
    preferences: {
      quietHours: { enabled: quiet.enabled === true, start: quiet.start, end: quiet.end },
      channelInterest: [...new Set(answers.preferences.channelInterest)],
    },
    consent: answers.consent === true,
    website: answers.website ?? '',
  };
}

// ---------- profile -> answers (editing) ----------
const WATER_STATUSES = ['on_water', 'pre_departure'];

export function answersFromProfile(profile, def) {
  const home = profile.areas.find((area) => area.role === 'home') ?? profile.areas[0];
  const data = { ...profile.occupationData };
  for (const field of def?.fields ?? []) {
    // Fields the server keeps at the top level of the profile.
    if (field.top && typeof profile[field.key] === 'boolean') data[field.key] = profile[field.key];
  }
  // A fisherman's "right now" answer is the live status, not the answer given at sign-up.
  if (profile.occupation === 'fisherman') data.status = WATER_STATUSES.includes(profile.activeActivity?.key) ? profile.activeActivity.key : 'ashore';

  return {
    occupation: profile.occupation,
    language: profile.language,
    homeAreaPcode: home?.upazilaPcode ?? '',
    locationMethod: home?.matchMethod === 'gps_nearest' ? 'gps_nearest' : 'manual',
    occupationData: data,
    isHeatSensitive: profile.isHeatSensitive === true,
    preferences: {
      quietHours: { ...DEFAULT_QUIET_HOURS, ...(profile.preferences?.quietHours ?? {}) },
      channelInterest: [...(profile.preferences?.channelInterest ?? [])],
    },
    consent: true, // already given when the profile was created
    website: '',
  };
}

// ---------- areas ----------
export function buildAreaIndex(catalogue) {
  const districts = catalogue?.districts ?? [];
  const locations = catalogue?.locations ?? [];
  const byName = (a, b) => a.name.localeCompare(b.name);
  const districtsByDivision = new Map();
  for (const district of districts) {
    if (!districtsByDivision.has(district.division)) districtsByDivision.set(district.division, []);
    districtsByDivision.get(district.division).push(district);
  }
  for (const list of districtsByDivision.values()) list.sort(byName);

  const locationsByDistrict = new Map();
  for (const location of locations) {
    if (!locationsByDistrict.has(location.district)) locationsByDistrict.set(location.district, []);
    locationsByDistrict.get(location.district).push(location);
  }
  for (const list of locationsByDistrict.values()) list.sort(byName);

  return {
    divisions: catalogue?.divisions ?? [...districtsByDivision.keys()].sort(),
    districtsByDivision,
    locationsByDistrict,
    locationByPcode: new Map(locations.map((location) => [location.pcode, location])),
    districtByPcode: new Map(districts.map((district) => [district.pcode, district])),
    searchable: locations.map((location) => ({ location, haystack: `${location.name} ${location.nameBn ?? ''}`.toLowerCase() })),
  };
}

// "Badda, Dhaka" in English or Bangla (district is omitted when it is the same name).
export function areaLabel(index, pcode, lang = 'en') {
  const location = index.locationByPcode.get(pcode);
  if (!location) return pcode ?? '';
  const district = index.districtByPcode.get(location.district);
  const name = lang === 'bn' ? (location.nameBn ?? location.name) : location.name;
  const parent = lang === 'bn' ? (district?.nameBn ?? district?.name) : district?.name;
  return parent && parent !== name ? `${name}, ${parent}` : name;
}

// Locations whose English or Bangla name contains the text (names that start with it first), or whose code starts with it.
export function searchAreas(index, query, limit = 8) {
  const text = String(query ?? '').trim().toLowerCase();
  if (text.length < 2) return [];
  return index.searchable
    .filter((entry) => entry.haystack.includes(text) || entry.location.pcode.startsWith(text))
    .sort((a, b) => (b.haystack.startsWith(text) - a.haystack.startsWith(text)) || a.location.name.localeCompare(b.location.name))
    .slice(0, limit)
    .map((entry) => entry.location);
}

// The BMD location for what locateUpazila found. A polygon that has no forecast of its own (a newer upazila) uses its nearest BMD location.
export function pcodeFromSelection(selection, catalogue) {
  if (!selection) return null;
  if (selection.level === 'upazila') return catalogue.locations.some((location) => location.pcode === selection.id) ? selection.id : null;
  if (selection.level === 'polygon') return catalogue.polygons?.[selection.id]?.src?.[0] ?? null;
  return null;
}

// A map link for the area an alert is about: /map#view=lat,lon,zoom (the same hash the map writes when it is shared).
export function mapHref(affectedArea, index, zoom = 9) {
  if (!affectedArea) return null;
  const point = affectedArea.upazilaPcode
    ? index.locationByPcode.get(affectedArea.upazilaPcode)
    : (affectedArea.districtPcode ? index.districtByPcode.get(affectedArea.districtPcode) : null);
  return point ? `/map#view=${point.lat},${point.lon},${zoom}z` : null;
}

// ---------- answers for display (review step and profile) ----------
export const YES_NO = { true: { en: 'Yes', bn: 'হ্যাঁ' }, false: { en: 'No', bn: 'না' } };

// One readable line per answer the person gave: [{ key, label, value }].
export function describeAnswers(answers, def, index, lang) {
  const rows = [];
  for (const field of visibleFields(def, answers.occupationData)) {
    const value = answers.occupationData[field.key];
    if (isEmpty(value) && field.type !== 'boolean') {
      if (field.type === 'area' || field.type === 'areas') rows.push({ key: field.key, label: pick(field.label, lang), value: pick({ en: 'Same as my home area', bn: 'বাসস্থানের এলাকার মতোই' }, lang) });
      continue;
    }
    let text;
    if (field.type === 'select') text = pick(field.options.find((option) => option.value === value)?.label, lang) || String(value);
    else if (field.type === 'boolean') text = typeof value === 'boolean' ? pick(YES_NO[String(value)], lang) : '';
    else if (field.type === 'area') text = areaLabel(index, value, lang);
    else if (field.type === 'areas') text = value.map((pcode) => areaLabel(index, pcode, lang)).join('; ');
    else text = String(value);
    if (text) rows.push({ key: field.key, label: pick(field.label, lang), value: text });
  }
  return rows;
}
