import {
  ACTIVITIES, MARINE_ZONES, OCCUPATIONS,
} from '../../config/alertConstants.js';
import { parseHm } from '../time.js';

// The single definition of the alert form: the client renders it, the server validates against it (strict whitelists).
// Bangla labels are drafts and still need human review before any public demonstration (plan decision D6).
export const SCHEMA_VERSION = 3;
export const CONSENT_VERSION = 'v4';
export const BN_REVIEWED = false;
export const MAX_AREAS = 5;
export const CHANNELS = ['telegram', 'sms', 'whatsapp', 'push'];

const opt = (value, en, bn) => ({ value, label: { en, bn } });
const text = (en, bn) => ({ en, bn });

const WORKLOAD = [opt('light', 'Light', 'হালকা'), opt('moderate', 'Moderate', 'মাঝারি'), opt('heavy', 'Heavy', 'ভারী')];
const HOURS = [opt('lt4', 'Less than 4', '৪ ঘণ্টার কম'), opt('4to8', '4 to 8', '৪ থেকে ৮ ঘণ্টা'), opt('gt8', 'More than 8', '৮ ঘণ্টার বেশি')];

const workload = {
  key: 'workload', type: 'select', required: true, options: WORKLOAD,
  label: text('How heavy is the work?', 'কাজ কতটা পরিশ্রমের?'),
};
const shiftStart = { key: 'shiftStart', type: 'time', required: true, label: text('Shift starts', 'শিফট শুরু') };
const shiftEnd = { key: 'shiftEnd', type: 'time', required: true, label: text('Shift ends', 'শিফট শেষ') };

export const OCCUPATION_DEFS = {
  farmer: {
    label: text('Farmer', 'কৃষক'),
    description: text('Crops, harvest and fieldwork', 'ফসল, ফসল তোলা ও মাঠের কাজ'),
    fields: [
      {
        key: 'cropType', type: 'select', required: true, label: text('Main crop', 'প্রধান ফসল'),
        options: [
          opt('rice_aman', 'Rice (Aman)', 'ধান (আমন)'), opt('rice_aus', 'Rice (Aus)', 'ধান (আউশ)'), opt('rice_boro', 'Rice (Boro)', 'ধান (বোরো)'),
          opt('jute', 'Jute', 'পাট'), opt('wheat', 'Wheat', 'গম'), opt('maize', 'Maize', 'ভুট্টা'), opt('vegetables', 'Vegetables', 'সবজি'),
          opt('pulses', 'Pulses', 'ডাল'), opt('other', 'Other', 'অন্যান্য'),
        ],
      },
      {
        key: 'cropStage', type: 'select', required: true, label: text('Crop stage now', 'ফসলের বর্তমান অবস্থা'),
        options: [
          opt('planting', 'Planting or sowing', 'রোপণ বা বপন'), opt('growing', 'Growing', 'বেড়ে উঠছে'), opt('harvesting', 'Harvesting', 'ফসল কাটা হচ্ছে'),
          opt('post_harvest', 'After harvest (drying, storing)', 'কাটার পর (শুকানো, মজুত)'),
        ],
      },
      {
        key: 'irrigationAccess', type: 'select', required: true, label: text('Irrigation', 'সেচের ব্যবস্থা'),
        options: [
          opt('none', 'None (rain-fed)', 'নেই (বৃষ্টিনির্ভর)'), opt('pump', 'Pump or tubewell', 'পাম্প বা নলকূপ'),
          opt('canal', 'Canal or surface water', 'খাল বা নদীর পানি'), opt('other', 'Other', 'অন্যান্য'),
        ],
      },
      { key: 'fieldAreaPcode', type: 'area', required: false, role: 'field', defaultHome: true, label: text('Where your field is', 'আপনার জমি কোথায়') },
      { key: 'outdoorHours', type: 'select', required: true, options: HOURS, label: text('Hours outdoors per day', 'দিনে কত ঘণ্টা বাইরে থাকেন') },
      workload,
    ],
  },
  fisherman: {
    label: text('Fisherman', 'জেলে'),
    description: text('Rivers, coast and sea', 'নদী, উপকূল ও সমুদ্র'),
    fields: [
      {
        key: 'waterBody', type: 'select', required: true, label: text('Where do you fish?', 'কোথায় মাছ ধরেন?'),
        options: [opt('river', 'River', 'নদী'), opt('coastal', 'Coastal waters', 'উপকূলীয় জল'), opt('marine', 'Open sea', 'গভীর সমুদ্র')],
      },
      {
        key: 'operatingAreaPcodes', type: 'areas', required: false, role: 'operating', max: 3, defaultHome: true,
        showIf: { key: 'waterBody', in: ['river', 'coastal'] },
        label: text('Upazilas you work from or near (up to 3)', 'যে উপজেলাগুলোর কাছে কাজ করেন (সর্বোচ্চ ৩টি)'),
      },
      {
        key: 'marineZone', type: 'select', required: true, showIf: { key: 'waterBody', in: ['marine'] },
        label: text('Sea area', 'সমুদ্র এলাকা'),
        help: text('Other sea areas are not monitored yet.', 'অন্যান্য সমুদ্র এলাকা এখনো পর্যবেক্ষণে নেই।'),
        options: MARINE_ZONES.map((zone) => ({ value: zone.id, label: zone.name })),
      },
      {
        key: 'status', type: 'select', required: true, default: 'ashore', label: text('Right now you are', 'এখন আপনি'),
        options: [opt('ashore', 'On shore', 'তীরে'), opt('pre_departure', 'About to leave', 'রওনা দেওয়ার আগে'), opt('on_water', 'On the water', 'পানিতে')],
      },
    ],
  },
  construction: {
    label: text('Construction worker', 'নির্মাণ শ্রমিক'),
    description: text('Sites, roofs and scaffolding', 'নির্মাণ স্থান, ছাদ ও ভারা'),
    fields: [
      {
        key: 'activityType', type: 'select', required: true, label: text('Where do you usually work?', 'সাধারণত কোথায় কাজ করেন?'),
        options: [
          opt('ground', 'On the ground', 'মাটিতে'), opt('roof', 'On a roof', 'ছাদে'), opt('scaffolding', 'On scaffolding', 'ভারায় (স্ক্যাফোল্ডিং)'),
          opt('other_elevated', 'Other work at height', 'অন্য উঁচু জায়গায়'),
        ],
      },
      workload,
      {
        key: 'ppeHeatBurden', type: 'select', required: true, label: text('Protective gear you wear', 'যে সুরক্ষা সরঞ্জাম পরেন'),
        options: [
          opt('none', 'None', 'নেই'), opt('light', 'Light (helmet, gloves)', 'হালকা (হেলমেট, গ্লাভস)'), opt('heavy', 'Heavy or a full set', 'ভারী বা পুরো সেট'),
        ],
      },
      { key: 'siteAreaPcode', type: 'area', required: false, role: 'site', defaultHome: true, label: text('Where your site is', 'কাজের স্থান কোথায়') },
      {
        key: 'siteExposure', type: 'select', required: true, label: text('The site is', 'কাজের জায়গা'),
        options: [opt('open', 'Open to the sky', 'খোলা আকাশের নিচে'), opt('partly_covered', 'Partly covered', 'আংশিক ঢাকা'), opt('indoor', 'Indoors', 'ঘরের ভেতরে')],
      },
      shiftStart,
      shiftEnd,
    ],
  },
  vendor: {
    label: text('Vendor', 'বিক্রেতা'),
    description: text('Markets, stalls and street selling', 'বাজার, দোকান ও রাস্তার বিক্রি'),
    fields: [
      { key: 'marketAreaPcode', type: 'area', required: false, role: 'market', defaultHome: true, label: text('Your main market', 'আপনার প্রধান বাজার') },
      {
        key: 'savedMarketPcodes', type: 'areas', required: false, role: 'market', max: 2,
        label: text('Other markets you work at (up to 2)', 'অন্য যেসব বাজারে কাজ করেন (সর্বোচ্চ ২টি)'),
      },
      { key: 'outdoorStall', type: 'boolean', required: true, label: text('Is your stall outdoors?', 'আপনার দোকান কি খোলা জায়গায়?') },
      {
        key: 'shelterAccess', type: 'select', required: true, label: text('Shelter nearby', 'কাছে আশ্রয়'),
        options: [opt('none', 'None', 'নেই'), opt('partial', 'Partial (awning, shed)', 'আংশিক (ছাউনি, চালা)'), opt('full', 'A proper building', 'পাকা ঘর')],
      },
      { key: 'hoursOutdoor', type: 'select', required: true, options: HOURS, label: text('Hours outdoors per day', 'দিনে কত ঘণ্টা বাইরে থাকেন') },
    ],
  },
  student_public: {
    label: text('Student or general public', 'শিক্ষার্থী বা সাধারণ মানুষ'),
    description: text('Commute, school and everyday life', 'যাতায়াত, স্কুল ও দৈনন্দিন জীবন'),
    fields: [
      { key: 'commuteStart', type: 'time', required: false, default: '07:00', label: text('Commute starts', 'যাতায়াত শুরু') },
      { key: 'commuteEnd', type: 'time', required: false, default: '09:00', label: text('Commute ends', 'যাতায়াত শেষ') },
      { key: 'schoolOrWorkAreaPcode', type: 'area', required: false, role: 'work', defaultHome: true, label: text('School or workplace area', 'স্কুল বা কর্মস্থলের এলাকা') },
      { key: 'outdoorPlay', type: 'boolean', required: true, label: text('Do you play or exercise outdoors?', 'আপনি কি বাইরে খেলাধুলা বা ব্যায়াম করেন?') },
      {
        key: 'guardianManaged', type: 'boolean', required: false, top: true,
        label: text('A parent or guardian manages this profile', 'অভিভাবক এই প্রোফাইল দেখাশোনা করেন'),
      },
    ],
  },
  rickshaw_labourer: {
    label: text('Rickshaw puller or day labourer', 'রিকশাচালক বা দিনমজুর'),
    description: text('Roads, shifts and outdoor work', 'রাস্তা, শিফট ও খোলা আকাশের নিচে কাজ'),
    fields: [
      shiftStart,
      shiftEnd,
      workload,
      {
        key: 'outdoorExposure', type: 'select', required: true, label: text('Where do you work?', 'কোথায় কাজ করেন?'),
        options: [opt('on_road', 'On the road', 'রাস্তায়'), opt('open_site', 'An open work site', 'খোলা কাজের জায়গায়'), opt('mixed', 'Both', 'দুটোই')],
      },
      { key: 'workAreaPcode', type: 'area', required: false, role: 'work', defaultHome: true, label: text('Area you work in', 'যে এলাকায় কাজ করেন') },
    ],
  },
};

export const ACTIVITY_LABELS = {
  on_water: text('On the water', 'পানিতে'),
  pre_departure: text('About to leave for the water', 'পানিতে যাওয়ার আগে'),
  on_road: text('On the road', 'রাস্তায়'),
  roof_work: text('Working on a roof', 'ছাদে কাজ করছি'),
  scaffolding: text('Working on scaffolding', 'ভারায় কাজ করছি'),
  elevated_work: text('Working at height', 'উঁচু জায়গায় কাজ করছি'),
  stall_outdoor: text('At my outdoor stall', 'খোলা জায়গার দোকানে'),
  outdoor_play: text('Playing or exercising outdoors', 'বাইরে খেলছি বা ব্যায়াম করছি'),
  in_field: text('In the field', 'মাঠে'),
};

export const CONSENT_TEXT = text(
  'AkashSathi keeps your occupation, the answers above and your area codes in an alert profile saved for this browser, so alerts can be matched to you. '
  + 'It keeps no name, e-mail address or exact location, and no phone number unless you later choose WhatsApp or SMS alerts and verify that number (a separate step with its own consent). Alerts come from prototype rules and are not an official warning service. '
  + 'You can delete your profile at any time.',
  'আকাশসাথী আপনার পেশা, উপরের উত্তর এবং এলাকার কোড এই ব্রাউজারের জন্য একটি সতর্কবার্তা প্রোফাইলে রাখে, যাতে আপনার জন্য প্রযোজ্য সতর্কবার্তা পাঠানো যায়। '
  + 'নাম, ইমেইল বা সঠিক অবস্থান রাখা হয় না; পরে আপনি হোয়াটসঅ্যাপ বা এসএমএস সতর্কবার্তা বেছে নিয়ে নম্বর যাচাই না করলে ফোন নম্বরও রাখা হয় না (সেটি আলাদা ধাপ, আলাদা সম্মতিসহ)। সতর্কবার্তাগুলো পরীক্ষামূলক নিয়মে তৈরি; এটি সরকারি সতর্কতা সেবা নয়। '
  + 'আপনি যেকোনো সময় আপনার প্রোফাইল মুছে ফেলতে পারেন।',
);

// One line per catalogue rule, shown on the review step so people know which alerts they can receive.
export const RULE_SUMMARIES = {
  'FARM-01': text('Rain forecast while your crop is at harvest or drying', 'ফসল কাটা বা শুকানোর সময় বৃষ্টির পূর্বাভাস'),
  'FARM-02': text('Rain forecast while you plant or your crop grows', 'রোপণ বা বেড়ে ওঠার সময় বৃষ্টির পূর্বাভাস'),
  'FARM-03': text('A long dry spell in the forecast, as a prompt to check your field', 'দীর্ঘ শুষ্ক আবহাওয়ার পূর্বাভাস, জমি দেখে নেওয়ার অনুস্মারক'),
  'FARM-04': text('Lightning near your field', 'আপনার জমির কাছে বজ্রপাত'),
  'FARM-05': text('Heat that makes fieldwork risky', 'মাঠের কাজ ঝুঁকিপূর্ণ করে তোলে এমন গরম'),
  'FISH-02': text('Lightning near you while you are on the water', 'পানিতে থাকাকালীন কাছাকাছি বজ্রপাত'),
  'FISH-04': text('Strong wind or rough water: postpone departure, or head back if you are on the water', 'প্রবল বাতাস বা উত্তাল পানি: রওনা পিছিয়ে দিন, অথবা পানিতে থাকলে ফিরুন'),
  'CONS-01': text('Lightning while you work on a roof or scaffolding', 'ছাদ বা ভারায় কাজের সময় বজ্রপাত'),
  'CONS-02': text('Heat during heavy work in protective gear', 'সুরক্ষা সরঞ্জাম পরে ভারী কাজের সময় গরম'),
  'CONS-03': text('Strong gusts while you work at height', 'উঁচু জায়গায় কাজের সময় প্রবল দমকা হাওয়া'),
  'VEND-01': text('Strong wind around an outdoor stall', 'খোলা জায়গার দোকানের কাছে প্রবল বাতাস'),
  'CONS-04': text('Rain at your site, as a prompt to check for slippery surfaces', 'আপনার কাজের জায়গায় বৃষ্টি, পিচ্ছিল জায়গা পরীক্ষার অনুস্মারক'),
  'VEND-02': text('Heat in an open-air market', 'খোলা বাজারে গরম'),
  'VEND-03': text('Rain at any of your markets, once per rain', 'আপনার যেকোনো বাজারে বৃষ্টি, প্রতি বৃষ্টিতে একবার'),
  'PUBLIC-01': text('Rain during your usual travel time', 'আপনার নিয়মিত যাতায়াতের সময় বৃষ্টি'),
  'PUBLIC-02': text('Lightning while you play or exercise outdoors', 'বাইরে খেলাধুলা বা ব্যায়ামের সময় বজ্রপাত'),
  'PUBLIC-03': text('Extra heat guidance if you chose it', 'আপনি চাইলে গরম সম্পর্কে বাড়তি নির্দেশনা'),
  'PUBLIC-06': text('A thunderstorm cloud on the satellite image heading for your area within the hour', 'স্যাটেলাইট ছবিতে এক ঘণ্টার মধ্যে আপনার এলাকার দিকে আসা বজ্রঝড়ের মেঘ'),
  'WORK-01': text('Heat building toward midday during your shift', 'আপনার শিফটে দুপুরের দিকে বাড়তে থাকা গরম'),
  'WORK-03': text('Lightning while you work on the road', 'রাস্তায় কাজের সময় বজ্রপাত'),
  'WORK-04': text('Rain during your working hours', 'আপনার কাজের সময়ে বৃষ্টি'),
};

export const OCCUPATION_RULES = {
  farmer: ['FARM-01', 'FARM-02', 'FARM-03', 'FARM-04', 'FARM-05', 'PUBLIC-06'],
  fisherman: ['FISH-02', 'FISH-04', 'PUBLIC-03', 'PUBLIC-06'],
  construction: ['CONS-01', 'CONS-02', 'CONS-03', 'CONS-04', 'PUBLIC-06'],
  vendor: ['VEND-01', 'VEND-02', 'VEND-03', 'PUBLIC-06'],
  student_public: ['PUBLIC-01', 'PUBLIC-02', 'PUBLIC-03', 'PUBLIC-06'],
  rickshaw_labourer: ['WORK-01', 'WORK-03', 'WORK-04', 'PUBLIC-06'],
};

// ---------- what the client receives ----------
export function publicSchema() {
  return {
    schemaVersion: SCHEMA_VERSION,
    consentVersion: CONSENT_VERSION,
    bnReviewed: BN_REVIEWED,
    maxAreas: MAX_AREAS,
    consentText: CONSENT_TEXT,
    channels: CHANNELS,
    marineZones: MARINE_ZONES,
    activities: ACTIVITIES.map((key) => ({ key, label: ACTIVITY_LABELS[key] })),
    occupations: OCCUPATIONS.map((value) => ({
      value,
      label: OCCUPATION_DEFS[value].label,
      description: OCCUPATION_DEFS[value].description,
      fields: OCCUPATION_DEFS[value].fields,
      rules: OCCUPATION_RULES[value].map((id) => ({ id, summary: RULE_SUMMARIES[id] })),
    })),
  };
}

// ---------- validation ----------
const TOP_LEVEL_KEYS = new Set([
  'occupation', 'language', 'homeAreaPcode', 'locationMethod', 'occupationData', 'isHeatSensitive', 'preferences', 'consent', 'website',
]);

export function isVisible(field, data) {
  if (!field.showIf) return true;
  const current = data?.[field.showIf.key];
  if (field.showIf.in) return field.showIf.in.includes(current);
  return current === field.showIf.equals;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const POSTAL = /^\d{6}$/;

// Validates a subscription (or a profile edit). `locations` is the catalogue's Map of pcode -> location.
// Returns { value, errors }: errors maps a field path to a code (required | invalid | unknown | too_many | consent | bot); value is null when any error exists.
export function validateSubscription(input, { locations }) {
  const errors = {};
  if (!isPlainObject(input)) return { value: null, errors: { body: 'invalid' } };

  for (const key of Object.keys(input)) if (!TOP_LEVEL_KEYS.has(key)) errors[key] = 'unknown';
  if (input.website) errors.website = 'bot';
  if (input.consent !== true) errors.consent = 'consent';

  const occupation = input.occupation;
  const def = OCCUPATION_DEFS[occupation];
  if (!def) errors.occupation = occupation === undefined ? 'required' : 'invalid';

  const language = input.language === undefined ? 'bn' : input.language;
  if (!['bn', 'en'].includes(language)) errors.language = 'invalid';

  if (input.isHeatSensitive !== undefined && typeof input.isHeatSensitive !== 'boolean') errors.isHeatSensitive = 'invalid';
  const locationMethod = input.locationMethod === undefined ? 'manual' : input.locationMethod;
  if (!['manual', 'gps_nearest'].includes(locationMethod)) errors.locationMethod = 'invalid';

  const home = input.homeAreaPcode;
  if (home === undefined || home === '') errors.homeAreaPcode = 'required';
  else if (typeof home !== 'string' || !POSTAL.test(home) || !locations.has(home)) errors.homeAreaPcode = 'invalid';

  const preferences = { quietHours: { enabled: false, start: '22:00', end: '06:00' }, channelInterest: [] };
  if (input.preferences !== undefined) {
    if (!isPlainObject(input.preferences)) errors.preferences = 'invalid';
    else {
      for (const key of Object.keys(input.preferences)) if (!['quietHours', 'channelInterest'].includes(key)) errors[`preferences.${key}`] = 'unknown';
      const quiet = input.preferences.quietHours;
      if (quiet !== undefined) {
        if (!isPlainObject(quiet)
          || Object.keys(quiet).some((key) => !['enabled', 'start', 'end'].includes(key))
          || (quiet.enabled !== undefined && typeof quiet.enabled !== 'boolean')
          || (quiet.start !== undefined && parseHm(quiet.start) === null)
          || (quiet.end !== undefined && parseHm(quiet.end) === null)) {
          errors['preferences.quietHours'] = 'invalid';
        } else {
          preferences.quietHours = { ...preferences.quietHours, ...quiet };
        }
      }
      const channels = input.preferences.channelInterest;
      if (channels !== undefined) {
        if (!Array.isArray(channels) || channels.some((channel) => !CHANNELS.includes(channel))) errors['preferences.channelInterest'] = 'invalid';
        else preferences.channelInterest = [...new Set(channels)];
      }
    }
  }

  const data = {};
  const areas = [];
  const top = {};
  const rawData = input.occupationData === undefined ? {} : input.occupationData;
  if (!isPlainObject(rawData)) errors.occupationData = 'invalid';

  if (def && isPlainObject(rawData)) {
    const known = new Set(def.fields.map((field) => field.key));
    for (const key of Object.keys(rawData)) if (!known.has(key)) errors[`occupationData.${key}`] = 'unknown';

    const addArea = (role, pcode, method = 'manual') => {
      const location = locations.get(pcode);
      if (!areas.some((area) => area.role === role && area.upazilaPcode === pcode)) {
        areas.push({ role, upazilaPcode: pcode, districtPcode: location.district, matchMethod: method });
      }
    };
    if (!errors.homeAreaPcode) addArea('home', home, locationMethod);

    for (const field of def.fields) {
      const path = `occupationData.${field.key}`;
      const raw = rawData[field.key];
      // A conditional field that is hidden is dropped, not an error: the form may still hold a stale answer.
      if (!isVisible(field, rawData)) continue;
      const missing = raw === undefined || raw === null || raw === '';

      if (field.type === 'select') {
        const value = missing ? field.default : raw;
        if (value === undefined) { if (field.required) errors[path] = 'required'; continue; }
        if (!field.options.some((option) => option.value === value)) errors[path] = 'invalid';
        else data[field.key] = value;
      } else if (field.type === 'boolean') {
        if (missing) { if (field.required) errors[path] = 'required'; else if (field.top) top[field.key] = false; continue; }
        if (typeof raw !== 'boolean') errors[path] = 'invalid';
        else if (field.top) top[field.key] = raw;
        else data[field.key] = raw;
      } else if (field.type === 'time') {
        const value = missing ? field.default : raw;
        if (value === undefined) { if (field.required) errors[path] = 'required'; continue; }
        if (parseHm(value) === null) errors[path] = 'invalid';
        else data[field.key] = value;
      } else if (field.type === 'area') {
        const value = missing && field.defaultHome && !errors.homeAreaPcode ? home : raw;
        if (value === undefined || value === null || value === '') { if (field.required) errors[path] = 'required'; continue; }
        if (typeof value !== 'string' || !POSTAL.test(value) || !locations.has(value)) errors[path] = 'invalid';
        else { data[field.key] = value; addArea(field.role, value); }
      } else if (field.type === 'areas') {
        let list = missing ? (field.defaultHome && !errors.homeAreaPcode ? [home] : []) : raw;
        if (!Array.isArray(list)) { errors[path] = 'invalid'; continue; }
        list = [...new Set(list)];
        if (list.length > field.max) { errors[path] = 'too_many'; continue; }
        if (list.some((value) => typeof value !== 'string' || !POSTAL.test(value) || !locations.has(value))) { errors[path] = 'invalid'; continue; }
        if (field.required && !list.length) { errors[path] = 'required'; continue; }
        data[field.key] = list;
        for (const pcode of list) addArea(field.role, pcode);
      }
    }
    if (areas.length > MAX_AREAS) errors.areas = 'too_many';
    // A shift that starts and ends at the same minute has no length.
    if (data.shiftStart && data.shiftEnd && data.shiftStart === data.shiftEnd) errors['occupationData.shiftEnd'] = 'invalid';
  }

  if (Object.keys(errors).length) return { value: null, errors };

  return {
    errors: {},
    value: {
      occupation,
      language,
      occupationData: data,
      areas,
      relevantUpazilas: [...new Set(areas.map((area) => area.upazilaPcode))],
      relevantDistricts: [...new Set(areas.map((area) => area.districtPcode))],
      isHeatSensitive: input.isHeatSensitive === true,
      guardianManaged: top.guardianManaged === true,
      preferences,
    },
  };
}

// The activity a profile starts with: only a fisherman's "right now" answer maps to one.
export function initialActivity(value, now, ttlHours) {
  const key = value.occupation === 'fisherman' ? value.occupationData.status : null;
  if (!key || key === 'ashore') return null;
  return { key, since: now, expiresAt: new Date(now.getTime() + ttlHours * 3_600_000) };
}

// A quick-status change: { key: ACTIVITY | null, hours? }.
export function validateActivity(input, ttlHours) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !['key', 'hours'].includes(key))) return { error: 'invalid' };
  if (input.key === null) return { key: null };
  if (!ACTIVITIES.includes(input.key)) return { error: 'invalid' };
  const hours = input.hours === undefined ? ttlHours : input.hours;
  if (!Number.isFinite(hours) || hours < 1 || hours > ttlHours) return { error: 'invalid' };
  return { key: input.key, hours };
}
