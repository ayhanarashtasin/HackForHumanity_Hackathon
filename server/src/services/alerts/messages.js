import { ACTIVITY_LABELS, OCCUPATION_DEFS } from './schema.js';
import { DHAKA_OFFSET_MS, dhakaDate, formatHm } from '../time.js';

// Alert wording in English and Bangla. The Bangla text is a draft that still needs human review (schema.js: BN_REVIEWED).
// Style rules, enforced by test/alertMessages.test.js: never say an area or a trip is safe, never say "all clear", never claim
// flooding or waterlogging; rain wording carries uncertainty; heat wording never diagnoses; observed lightning and lightning threats
// are described differently; a forecast is never described as a measurement.
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
export const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
export const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pick = (value, lang) => (value && typeof value === 'object' ? value[lang] ?? value.en : value);

export function localizeDigits(text, lang) {
  return lang === 'bn' ? String(text).replace(/\d/g, (digit) => BN_DIGITS[Number(digit)]) : String(text);
}

// "{name}" placeholders. A missing parameter is a bug, so it is left visible rather than silently dropped.
export function fill(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined || params[key] === null ? match : String(params[key])));
}

// Phrases an alert should not use. Generated text must pass them (tested); administrator text only gets a warning.
export const DISCOURAGED_PHRASES = [
  { pattern: /\ball[- ]clear\b/i, warning: 'Avoid "all clear": the absence of an alert is not proof of safety.' },
  { pattern: /\b(is|are|will be|was|were)\s+safe\b|\bsafe to\b|\byou(?:'re| are) safe\b/i, warning: 'Avoid saying that a place or an action is safe.' },
  { pattern: /\bguarantee/i, warning: 'Avoid promises or guarantees.' },
  { pattern: /\bflood|\bwaterlog/i, warning: 'Avoid claiming flooding or waterlogging unless it is confirmed.' },
  { pattern: /\bno (?:risk|danger)\b/i, warning: 'Avoid saying there is no risk or danger.' },
];

export function lintText(text) {
  return DISCOURAGED_PHRASES.filter(({ pattern }) => pattern.test(String(text ?? ''))).map(({ warning }) => warning);
}

// ---------- time ----------
export function dayWord(ms, nowMs, lang) {
  const diff = (Date.parse(`${dhakaDate(new Date(ms))}T00:00:00Z`) - Date.parse(`${dhakaDate(new Date(nowMs))}T00:00:00Z`)) / 86_400_000;
  if (diff === 0) return lang === 'bn' ? 'আজ' : 'today';
  if (diff === 1) return lang === 'bn' ? 'আগামীকাল' : 'tomorrow';
  if (diff === -1) return lang === 'bn' ? 'গতকাল' : 'yesterday';
  const shifted = new Date(ms + DHAKA_OFFSET_MS);
  return lang === 'bn' ? `${shifted.getUTCDate()} ${BN_MONTHS[shifted.getUTCMonth()]}` : `${shifted.getUTCDate()} ${EN_MONTHS[shifted.getUTCMonth()]}`;
}

export function whenText(ms, nowMs, lang) {
  return `${dayWord(ms, nowMs, lang)} ${formatHm(new Date(ms))}`;
}

export function windowText(fromMs, untilMs, nowMs, lang) {
  const from = fromMs <= nowMs ? (lang === 'bn' ? 'এখন' : 'now') : whenText(fromMs, nowMs, lang);
  const until = whenText(untilMs, nowMs, lang);
  return lang === 'bn' ? `${from} থেকে ${until} পর্যন্ত` : `from ${from} until ${until}`;
}

// ---------- vocabulary ----------
export const PROVIDER_LABELS = {
  bmd: { en: 'BMD forecast', bn: 'বিএমডি (আবহাওয়া অধিদপ্তর) পূর্বাভাস' },
  'open-meteo': { en: 'Open-Meteo forecast', bn: 'Open-Meteo পূর্বাভাস' },
  xweather: { en: 'Xweather', bn: 'Xweather' },
  himawari: { en: 'Himawari-9 satellite (JMA)', bn: 'হিমাওয়ারি-৯ স্যাটেলাইট (JMA)' },
  admin: { en: 'Administrator', bn: 'প্রশাসক' },
};

export const SENDER_LABELS = {
  automatic: { en: 'Automatic alert (prototype rules)', bn: 'স্বয়ংক্রিয় সতর্কবার্তা (পরীক্ষামূলক নিয়ম)' },
  'automatic-validated': { en: 'Automatic alert', bn: 'স্বয়ংক্রিয় সতর্কবার্তা' },
  administrator: { en: 'Sent by the administrator', bn: 'প্রশাসকের পাঠানো' },
};

export const AREA_ROLE_WORDS = {
  current: { en: 'your current area', bn: 'আপনার বর্তমান এলাকা' },
  home: { en: 'your home area', bn: 'আপনার বাসস্থানের এলাকা' },
  work: { en: 'your work area', bn: 'আপনার কর্মএলাকা' },
  field: { en: 'your field', bn: 'আপনার জমি' },
  site: { en: 'your work site', bn: 'আপনার কাজের স্থান' },
  market: { en: 'your market', bn: 'আপনার বাজার' },
  operating: { en: 'your fishing area', bn: 'আপনার মাছ ধরার এলাকা' },
};

export const HAZARD_LABELS = {
  HEAVY_RAIN: { en: 'heavy rain', bn: 'ভারী বৃষ্টি' },
  HEAT_STRESS: { en: 'heat stress', bn: 'গরমজনিত ঝুঁকি' },
  STRONG_WIND: { en: 'strong wind', bn: 'প্রবল বাতাস' },
  OBSERVED_LIGHTNING: { en: 'lightning', bn: 'বজ্রপাত' },
  LIGHTNING_THREAT: { en: 'lightning', bn: 'বজ্রপাত' },
  STORM_APPROACH: { en: 'an approaching storm', bn: 'এগিয়ে আসা ঝড়' },
  MARINE_WEATHER: { en: 'rough marine weather', bn: 'উত্তাল সমুদ্র' },
  DRY_SPELL: { en: 'a dry spell', bn: 'দীর্ঘ শুষ্ক আবহাওয়া' },
  OFFICIAL_NOTICE: { en: 'an official notice', bn: 'একটি সরকারি বিজ্ঞপ্তি' },
  ADMIN_NOTICE: { en: 'a notice', bn: 'একটি বিজ্ঞপ্তি' },
};

const unit = {
  mm: { en: 'mm', bn: 'মিমি' },
  kph: { en: 'km/h', bn: 'কিমি/ঘণ্টা' },
  km: { en: 'km', bn: 'কিমি' },
  c: { en: '°C', bn: '°সে.' },
  m: { en: 'm', bn: 'মি.' },
};
export const withUnit = (value, key, lang) => `${value} ${unit[key][lang]}`;

export const activityLabelFor = (key, lang) => pick(ACTIVITY_LABELS[key], lang) ?? key;

export function occupationLabel(occupation, lang) {
  return pick(OCCUPATION_DEFS[occupation]?.label, lang) ?? occupation;
}

export function optionLabel(occupation, fieldKey, value, lang) {
  const field = OCCUPATION_DEFS[occupation]?.fields.find((item) => item.key === fieldKey);
  const option = field?.options?.find((item) => item.value === value);
  return pick(option?.label, lang) ?? String(value);
}

// ---------- titles ----------
const TITLES = {
  HEAVY_RAIN: [
    null,
    { en: 'Rain expected in {area}', bn: '{area}-এ বৃষ্টির সম্ভাবনা' },
    { en: 'Heavy rain expected in {area}', bn: '{area}-এ ভারী বৃষ্টির সম্ভাবনা' },
    { en: 'Very heavy rain expected in {area}', bn: '{area}-এ অতি ভারী বৃষ্টির সম্ভাবনা' },
  ],
  HEAT_STRESS: [
    null,
    { en: 'Heat expected in {area}', bn: '{area}-এ প্রচণ্ড গরমের সম্ভাবনা' },
    { en: 'High heat stress expected in {area}', bn: '{area}-এ গরমজনিত উচ্চ ঝুঁকির সম্ভাবনা' },
    { en: 'Extreme heat stress expected in {area}', bn: '{area}-এ গরমজনিত চরম ঝুঁকির সম্ভাবনা' },
  ],
  STRONG_WIND: [
    null,
    { en: 'Strong gusts expected in {area}', bn: '{area}-এ প্রবল দমকা হাওয়ার সম্ভাবনা' },
    { en: 'Very strong gusts expected in {area}', bn: '{area}-এ অতি প্রবল দমকা হাওয়ার সম্ভাবনা' },
    { en: 'Severe gusts expected in {area}', bn: '{area}-এ তীব্র দমকা হাওয়ার সম্ভাবনা' },
  ],
  MARINE_WEATHER: [
    null,
    { en: 'Rough waters expected near {area}', bn: '{area}-এর কাছে উত্তাল সমুদ্রের সম্ভাবনা' },
    { en: 'Very rough waters expected near {area}', bn: '{area}-এর কাছে অতি উত্তাল সমুদ্রের সম্ভাবনা' },
    { en: 'Dangerous waters expected near {area}', bn: '{area}-এর কাছে বিপজ্জনক সমুদ্রের সম্ভাবনা' },
  ],
  DRY_SPELL: [null, { en: 'A dry spell is forecast for {area}', bn: '{area}-এ দীর্ঘ শুষ্ক আবহাওয়ার পূর্বাভাস' }],
};

export function titleFor(event, areaName, lang) {
  if (event.origin === 'admin-declared') {
    return fill(lang === 'bn' ? 'প্রশাসকের সতর্কবার্তা: {area}-এ {hazard}' : 'Administrator alert: {hazard} in {area}', { area: areaName, hazard: pick(HAZARD_LABELS[event.hazardType], lang) });
  }
  if (event.hazardType === 'OBSERVED_LIGHTNING') return fill(lang === 'bn' ? '{area}-এর কাছে বজ্রপাত শনাক্ত হয়েছে' : 'Lightning detected near {area}', { area: areaName });
  if (event.hazardType === 'LIGHTNING_THREAT') {
    return fill(event.level >= 3
      ? (lang === 'bn' ? '{area}-এর কাছে শিগগিরই বজ্রপাতের আশঙ্কা' : 'Lightning expected near {area} soon')
      : (lang === 'bn' ? '{area}-এর কাছে এক ঘণ্টার মধ্যে বজ্রপাতের সম্ভাবনা' : 'Lightning possible near {area} within the hour'), { area: areaName });
  }
  if (event.hazardType === 'STORM_APPROACH') {
    return fill(event.level >= 3
      ? (lang === 'bn' ? '{area}-এ ৩০ মিনিটের মধ্যে ঝড় পৌঁছাতে পারে' : 'Storm may reach {area} within 30 minutes')
      : (lang === 'bn' ? '{area}-এ এক ঘণ্টার মধ্যে ঝড় পৌঁছাতে পারে' : 'Storm may reach {area} within the hour'), { area: areaName });
  }
  if (event.hazardType === 'OFFICIAL_NOTICE') {
    return fill(event.evidence?.kind === 'withdrawal'
      ? (lang === 'bn' ? 'বিএমডির সতর্কতা প্রত্যাহার: {area}, তবু সতর্ক থাকুন' : 'BMD warning withdrawn for {area}: stay cautious')
      : (lang === 'bn' ? 'বিএমডির সরকারি সতর্কবার্তা: {area}' : 'Official BMD warning for {area}'), { area: areaName });
  }
  const set = TITLES[event.hazardType];
  const entry = set?.[Math.min(event.level, set.length - 1)];
  return entry ? fill(pick(entry, lang), { area: areaName }) : fill(lang === 'bn' ? '{area}-এর জন্য বিজ্ঞপ্তি' : 'Notice for {area}', { area: areaName });
}

// ---------- what is happening ----------
const INDICATOR_TEXT = {
  wbgt: { en: 'estimated wet-bulb globe temperature (WBGT, a provider estimate)', bn: 'আনুমানিক ওয়েট-বাল্ব গ্লোব তাপমাত্রা (WBGT, সরবরাহকারীর অনুমান)' },
  heat_index: { en: 'heat index (computed from forecast temperature and humidity)', bn: 'হিট ইনডেক্স (পূর্বাভাসের তাপমাত্রা ও আর্দ্রতা থেকে হিসাব করা)' },
};

const ZONE_NAMES = { north_bay: { en: 'the North Bay', bn: 'উত্তর বঙ্গোপসাগর' } };

// Where a storm cell is heading (the tracker's eight compass points).
export const COMPASS_WORDS = {
  N: { en: 'north', bn: 'উত্তর' },
  NE: { en: 'north-east', bn: 'উত্তর-পূর্ব' },
  E: { en: 'east', bn: 'পূর্ব' },
  SE: { en: 'south-east', bn: 'দক্ষিণ-পূর্ব' },
  S: { en: 'south', bn: 'দক্ষিণ' },
  SW: { en: 'south-west', bn: 'দক্ষিণ-পশ্চিম' },
  W: { en: 'west', bn: 'পশ্চিম' },
  NW: { en: 'north-west', bn: 'উত্তর-পশ্চিম' },
};

// The storm-approach sentence: the satellite image time, the cell's movement and expected arrival, and what the estimate is not.
function describeStorm(event, { areaName, nowMs, lang }) {
  const m = event.evidence?.metrics ?? {};
  const storm = event.evidence?.storm ?? {};
  const image = storm.observedAtMs ? whenText(storm.observedAtMs, nowMs, lang) : '';
  const arrival = m.arrivalAtMs ? whenText(m.arrivalAtMs, nowMs, lang) : '';
  const dir = pick(COMPASS_WORDS[storm.towards], lang);
  const speed = Number.isFinite(storm.speedKmh) ? Math.round(storm.speedKmh) : null;
  const already = m.arrivalAtMs && m.arrivalAtMs <= nowMs;
  const top = Number.isFinite(m.minTempC) ? Math.round(m.minTempC) : null;

  if (lang === 'bn') {
    const moving = dir && speed !== null ? `প্রায় ${withUnit(speed, 'kph', lang)} বেগে ${dir} দিকে যাচ্ছে এবং ` : '';
    const reach = already ? `হয়তো এখনই ${areaName}-এ পৌঁছাচ্ছে (আনুমানিক ${arrival})` : `${arrival} নাগাদ ${areaName}-এ পৌঁছাতে পারে`;
    const cold = top === null ? '' : ` মেঘের চূড়া প্রায় ${withUnit(top, 'c', lang)}, যা উঁচু বজ্রঝড়ের মেঘের লক্ষণ।`;
    return `${image}-এর স্যাটেলাইট ছবিতে একটি বজ্রঝড়ের মেঘ ${moving}${reach}।${cold} এটি স্যাটেলাইটভিত্তিক অনুমান, প্রায় ৩০ কিমি এদিক-ওদিক হতে পারে; বজ্রপাতের পর্যবেক্ষণ নয়।`;
  }
  const moving = dir && speed !== null ? `is moving ${dir} at about ${withUnit(speed, 'kph', lang)} and ` : '';
  const reach = already ? `may already be reaching ${areaName} (expected ${arrival})` : `may reach ${areaName} around ${arrival}`;
  const cold = top === null ? '' : ` Its cloud top is about ${withUnit(top, 'c', lang)}, a sign of a tall thunderstorm cloud.`;
  return `A thunderstorm cloud on the satellite image of ${image} ${moving}${reach}.${cold} This is a satellite estimate that can be about 30 km off, not a lightning observation.`;
}

// The factual sentence about the hazard (not the advice). `nowMs` anchors "today" and "tomorrow".
export function describeHazard(event, { areaName, nowMs, lang }) {
  const m = event.evidence?.metrics ?? {};
  const level = event.level;
  const span = event.validFrom && event.validUntil ? windowText(+new Date(event.validFrom), +new Date(event.validUntil), nowMs, lang) : '';

  if (event.origin === 'admin-declared') {
    const label = pick(HAZARD_LABELS[event.hazardType], lang);
    return lang === 'bn'
      ? `প্রশাসক ${areaName}-এর জন্য ${label} ঘোষণা করেছেন (স্তর ${level}), ${span}। এটি আবহাওয়ার উপাত্ত থেকে শনাক্ত করা নয়।`
      : `An administrator has declared ${label} (level ${level}) for ${areaName}, ${span}. This was not detected from weather data.`;
  }

  switch (event.hazardType) {
    case 'HEAVY_RAIN': {
      const pop = m.popPercent !== null && m.popPercent !== undefined ? m.popPercent : null;
      const head = lang === 'bn'
        ? `${areaName}-এ ${span} ৩ ঘণ্টায় সর্বোচ্চ প্রায় ${withUnit(m.rain3hMm, 'mm', lang)} এবং ২৪ ঘণ্টায় মোট প্রায় ${withUnit(m.rain24hMm, 'mm', lang)} বৃষ্টির পূর্বাভাস আছে`
        : `Rain is forecast for ${areaName} ${span}: up to about ${withUnit(m.rain3hMm, 'mm', lang)} in 3 hours and about ${withUnit(m.rain24hMm, 'mm', lang)} over 24 hours`;
      const chance = pop === null ? '' : (lang === 'bn' ? `, সম্ভাবনা ${pop}%` : `, with a ${pop}% chance`);
      const note = lang === 'bn' ? '। সময় ও পরিমাণ পূর্বাভাসের অনিশ্চয়তার অধীন।' : '. Timing and amounts are uncertain.';
      return head + chance + note;
    }
    case 'HEAT_STRESS': {
      const indicator = pick(INDICATOR_TEXT[m.indicator] ?? INDICATOR_TEXT.heat_index, lang);
      const peak = m.peakStartMs ? whenText(m.peakStartMs, nowMs, lang) : '';
      return lang === 'bn'
        ? `${areaName}-এ ${indicator} ${peak} নাগাদ প্রায় ${withUnit(m.peakValueC, 'c', lang)} পর্যন্ত উঠতে পারে।`
        : `In ${areaName} the ${indicator} may reach about ${withUnit(m.peakValueC, 'c', lang)} around ${peak}.`;
    }
    case 'STRONG_WIND':
      return lang === 'bn'
        ? `${areaName}-এ ${span} দমকা হাওয়া সর্বোচ্চ প্রায় ${withUnit(m.maxGustKph, 'kph', lang)} পর্যন্ত হতে পারে (পূর্বাভাস)।`
        : `Gusts of up to about ${withUnit(m.maxGustKph, 'kph', lang)} are forecast for ${areaName} ${span}.`;
    case 'MARINE_WEATHER': {
      const parts = [];
      if (m.maxWaveM !== null && m.maxWaveM !== undefined) parts.push(lang === 'bn' ? `ঢেউ প্রায় ${withUnit(m.maxWaveM, 'm', lang)} পর্যন্ত` : `waves up to about ${withUnit(m.maxWaveM, 'm', lang)}`);
      if (m.maxGustKph !== null && m.maxGustKph !== undefined) parts.push(lang === 'bn' ? `দমকা হাওয়া প্রায় ${withUnit(m.maxGustKph, 'kph', lang)} পর্যন্ত` : `gusts up to about ${withUnit(m.maxGustKph, 'kph', lang)}`);
      return lang === 'bn'
        ? `${areaName}-এর কাছে ${span} ${parts.join(', ')} হতে পারে (পূর্বাভাস)।`
        : `Forecast for ${areaName} ${span}: ${parts.join(', ')}.`;
    }
    case 'DRY_SPELL':
      return lang === 'bn'
        ? `${areaName}-এ আগামী ${m.dryDays} দিন বৃষ্টির পূর্বাভাস নেই, দিনের সর্বোচ্চ তাপমাত্রা গড়ে প্রায় ${withUnit(m.meanTmaxC, 'c', lang)}। এটি পূর্বাভাস, খরার ঘোষণা নয়।`
        : `No rain is forecast for ${areaName} for the next ${m.dryDays} days, with daytime highs averaging about ${withUnit(m.meanTmaxC, 'c', lang)}. This is a forecast, not a drought declaration.`;
    case 'OBSERVED_LIGHTNING': {
      const when = m.lastStrikeAtMs ? whenText(m.lastStrikeAtMs, nowMs, lang) : '';
      const near = m.nearestKm !== null && m.nearestKm !== undefined ? m.nearestKm : null;
      return lang === 'bn'
        ? `${when} নাগাদ ${areaName}-এর ${near === null ? 'কাছে' : `${withUnit(near, 'km', lang)} দূরত্বের মধ্যে`} বজ্রপাত শনাক্ত হয়েছে (পর্যবেক্ষণ)। এটি পরবর্তী বজ্রপাতের নির্ভুল পূর্বাভাস নয়।`
        : `Lightning was detected ${near === null ? 'near' : `${withUnit(near, 'km', lang)} from`} ${areaName} at ${when} (observed). This does not predict the next strike.`;
    }
    case 'LIGHTNING_THREAT':
      return event.level >= 3
        ? (lang === 'bn'
          ? `${areaName}-এর কাছে প্রায় ৩০ মিনিটের মধ্যে বজ্রপাতের আশঙ্কা আছে (স্বল্পমেয়াদি পূর্বাভাস, নির্দিষ্ট জায়গার নিশ্চিত পূর্বাভাস নয়)।`
          : `A lightning threat area covers ${areaName} within about 30 minutes (a short-range nowcast, not a prediction for one exact place).`)
        : (lang === 'bn'
          ? `${areaName}-এর কাছে আগামী এক ঘণ্টার মধ্যে বজ্রপাতের সম্ভাবনা আছে (স্বল্পমেয়াদি পূর্বাভাস, নির্দিষ্ট জায়গার নিশ্চিত পূর্বাভাস নয়)।`
          : `A lightning threat area may cover ${areaName} within the next hour (a short-range nowcast, not a prediction for one exact place).`);
    case 'STORM_APPROACH':
      return describeStorm(event, { areaName, nowMs, lang });
    case 'OFFICIAL_NOTICE': {
      if (event.evidence?.kind === 'withdrawal') {
        return lang === 'bn'
          ? `${areaName}-এর জন্য আবহাওয়া অধিদপ্তরের (বিএমডি) সর্বশেষ বুলেটিনে আর কোনো সতর্কসংকেত উল্লেখ নেই। মূল বিজ্ঞপ্তি দেখুন।`
          : `BMD's latest bulletin for ${areaName} no longer states a warning. See the original notice.`;
      }
      const quote = event.official?.signalText ? ` "${event.official.signalText}"` : '';
      return lang === 'bn'
        ? `${areaName}-এর জন্য আবহাওয়া অধিদপ্তরের (বিএমডি) সরকারি বুলেটিনে সতর্কবার্তা আছে (মূল ইংরেজি ভাষ্য):${quote}`
        : `BMD's official bulletin for ${areaName} states (original wording):${quote}`;
    }
    default:
      return '';
  }
}

// ---------- forecast confidence (rain, ml-service) ----------
const CONFIDENCE_WORDS = {
  high: { en: 'High', bn: 'উচ্চ' },
  medium: { en: 'Medium', bn: 'মাঝারি' },
  low: { en: 'Low', bn: 'কম' },
};

// One line for a rain alert: how often similar past forecasts brought the rain the alert is about, as a band. Never a percentage,
// because the model's probabilities did not pass the calibration check. An unknown band gives no line.
export function confidenceLine(band, lang) {
  const word = pick(CONFIDENCE_WORDS[band], lang);
  if (!word) return '';
  return lang === 'bn' ? `পূর্বাভাসের নির্ভরযোগ্যতা: ${word}।` : `Forecast confidence: ${word}.`;
}

// ---------- advice (role-specific) ----------
export const ADVICE = {
  rain_harvest: {
    en: 'Your crop is at the harvest stage. If you can, cover or move harvested crops and keep them dry.',
    bn: 'আপনার ফসল কাটার পর্যায়ে আছে। সম্ভব হলে কাটা ফসল ঢেকে বা সরিয়ে শুকনো রাখুন।',
  },
  rain_post_harvest: {
    en: 'Your harvested crop may be drying or in storage. If you can, cover it, keep it off the ground and keep it dry.',
    bn: 'আপনার কাটা ফসল শুকানো বা মজুতের অবস্থায় থাকতে পারে। সম্ভব হলে ঢেকে রাখুন, মাটি থেকে উঁচুতে ও শুকনো রাখুন।',
  },
  rain_planting: {
    en: 'Your crop is at the planting stage. Rain can help or delay sowing, so plan field work around the forecast window and check that water can drain.',
    bn: 'আপনার ফসল রোপণ বা বপনের পর্যায়ে আছে। বৃষ্টি কাজে সাহায্য করতে বা দেরি করাতে পারে; পূর্বাভাসের সময় অনুযায়ী মাঠের কাজ সাজান এবং পানি সরার ব্যবস্থা দেখে নিন।',
  },
  rain_growing: {
    en: 'Check that water can drain from your field and that young plants are not left standing in water.',
    bn: 'আপনার জমি থেকে পানি সরে যাচ্ছে কিনা এবং চারা পানিতে ডুবে থাকছে কিনা দেখে নিন।',
  },
  rain_commute: {
    en: 'Rain is forecast during your usual travel time. Leave a little earlier or plan another way, and check road conditions locally. This is a rain forecast, not a report of road conditions.',
    bn: 'আপনার যাতায়াতের সময়ে বৃষ্টির পূর্বাভাস আছে। একটু আগে বের হোন বা অন্য পথ ভাবুন, এবং রাস্তার অবস্থা স্থানীয়ভাবে দেখে নিন। এটি বৃষ্টির পূর্বাভাস, রাস্তার অবস্থার প্রতিবেদন নয়।',
  },
  rain_work: {
    en: 'Rain is forecast during your working hours. Allow extra travel time and check road conditions locally. This is a rain forecast, not a report of road conditions.',
    bn: 'আপনার কাজের সময়ে বৃষ্টির পূর্বাভাস আছে। যাতায়াতে বাড়তি সময় রাখুন এবং রাস্তার অবস্থা স্থানীয়ভাবে দেখে নিন। এটি বৃষ্টির পূর্বাভাস, রাস্তার অবস্থার প্রতিবেদন নয়।',
  },
  rain_site: {
    en: 'Rain is forecast at your work site. Stairs, walkways, planks and scaffolding can stay slippery after the rain stops. Inspect them before work resumes; this message cannot tell whether the site is ready.',
    bn: 'আপনার কাজের জায়গায় বৃষ্টির পূর্বাভাস আছে। বৃষ্টি থামার পরও সিঁড়ি, চলার পথ, তক্তা ও ভারা পিচ্ছিল থাকতে পারে। কাজ আবার শুরুর আগে এগুলো পরীক্ষা করে নিন; জায়গাটি কাজের উপযোগী কিনা এই বার্তা বলতে পারে না।',
  },
  rain_market: {
    en: 'Rain is forecast at this market during market hours. If you plan to sell here, bring cover for your goods and check the forecast before you set up.',
    bn: 'বাজার চলার সময় এই বাজারে বৃষ্টির পূর্বাভাস আছে। এখানে বিক্রির পরিকল্পনা থাকলে মালপত্র ঢাকার ব্যবস্থা সঙ্গে রাখুন এবং দোকান বসানোর আগে পূর্বাভাস দেখে নিন।',
  },
  location_old: {
    en: 'The location you last shared is out of date, so this alert is based on your saved markets. Share your location again if you are somewhere else.',
    bn: 'আপনার সর্বশেষ জানানো অবস্থান পুরোনো হয়ে গেছে, তাই এই সতর্কবার্তা আপনার সংরক্ষিত বাজারগুলোর ভিত্তিতে। অন্য কোথাও থাকলে আবার অবস্থান জানান।',
  },
  dry_spell: {
    en: 'Check the moisture level in your field.',
    bn: 'আপনার জমির আর্দ্রতা কেমন তা দেখে নিন।',
  },
  dry_spell_irrigation: {
    en: 'If the soil is drying out, use your irrigation as needed.',
    bn: 'মাটি শুকিয়ে এলে প্রয়োজনমতো আপনার সেচের ব্যবস্থা ব্যবহার করুন।',
  },
  dry_spell_rainfed: {
    en: 'You rely on rain, so think now about how to save water and which plots matter most.',
    bn: 'আপনি বৃষ্টির ওপর নির্ভরশীল, তাই এখনই ভাবুন কীভাবে পানি বাঁচানো যায় এবং কোন জমি আগে গুরুত্বপূর্ণ।',
  },
  heat_farm: {
    en: 'Fieldwork in this heat is tiring. Rest in the shade, drink water often, and try to do heavy work early in the morning or late in the afternoon. Get urgent medical help for confusion, fainting or very hot, dry skin.',
    bn: 'এই গরমে মাঠের কাজ ক্লান্তিকর। ছায়ায় বিশ্রাম নিন, ঘন ঘন পানি পান করুন এবং ভারী কাজ সকালে বা বিকেলে করার চেষ্টা করুন। বিভ্রান্তি, অজ্ঞান হয়ে যাওয়া বা খুব গরম শুকনো ত্বক হলে জরুরি চিকিৎসা নিন।',
  },
  heat_labour: {
    en: 'The heat is forecast to build toward midday, with the peak {peak}. Plan rests in the shade, carry water, and start heavy work early if you can. Get urgent medical help for confusion, fainting or very hot, dry skin.',
    bn: 'দুপুরের দিকে গরম বাড়বে বলে পূর্বাভাস আছে, সর্বোচ্চ {peak} নাগাদ। ছায়ায় বিশ্রামের পরিকল্পনা করুন, সঙ্গে পানি রাখুন এবং পারলে ভারী কাজ আগে শুরু করুন। বিভ্রান্তি, অজ্ঞান হয়ে যাওয়া বা খুব গরম শুকনো ত্বক হলে জরুরি চিকিৎসা নিন।',
  },
  heat_urban: {
    en: 'Concrete and tarmac hold heat, so it can feel hotter on the street than the forecast suggests.',
    bn: 'কংক্রিট ও পিচঢালা রাস্তা তাপ ধরে রাখে, তাই রাস্তায় পূর্বাভাসের চেয়ে বেশি গরম লাগতে পারে।',
  },
  heat_long_shift: {
    en: 'Long physical shifts in the heat build up tiredness. Rest, drink water, and check on the people you work with. This is not a medical diagnosis.',
    bn: 'গরমে দীর্ঘ শারীরিক পরিশ্রমের শিফটে ক্লান্তি জমে। বিশ্রাম নিন, পানি পান করুন এবং সহকর্মীদের খোঁজ নিন। এটি কোনো চিকিৎসাগত রোগনির্ণয় নয়।',
  },
  heat_cons: {
    en: 'Heavy work in protective gear adds to heat stress. Reduce effort, rest often in shade or a cool place, and drink water. Please ask your site supervisor to review the work and rest plan.',
    bn: 'সুরক্ষা সরঞ্জাম পরে ভারী কাজ গরমের চাপ বাড়ায়। পরিশ্রম কমান, ছায়ায় বা ঠান্ডা জায়গায় ঘন ঘন বিশ্রাম নিন এবং পানি পান করুন। কাজ ও বিশ্রামের পরিকল্পনা পর্যালোচনা করতে সাইট সুপারভাইজারকে বলুন।',
  },
  heat_vendor: {
    en: 'Standing in the sun for long hours raises heat risk, especially with little shade or drinking water. Take breaks, drink clean water, watch for signs of heat illness, and get medical help if you feel unwell.',
    bn: 'দীর্ঘক্ষণ রোদে দাঁড়িয়ে থাকলে গরমজনিত ঝুঁকি বাড়ে, বিশেষ করে ছায়া বা খাবার পানি কম থাকলে। বিরতি নিন, পরিষ্কার পানি পান করুন, গরমজনিত অসুস্থতার লক্ষণ খেয়াল করুন এবং অসুস্থ বোধ করলে চিকিৎসা নিন।',
  },
  heat_sensitive: {
    en: 'Some people feel heat sooner. Rest, drink water and move to a cooler place. If you feel unwell, get medical care.',
    bn: 'কিছু মানুষ গরম আগে টের পান। বিশ্রাম নিন, পানি পান করুন এবং ঠান্ডা জায়গায় যান। অসুস্থ বোধ করলে চিকিৎসা নিন।',
  },
  wind_height: {
    en: 'Strong gusts are dangerous at height. Stop unsafe work at height according to your site safety procedures. This message does not replace an engineering safety assessment.',
    bn: 'উঁচু জায়গায় প্রবল দমকা হাওয়া বিপজ্জনক। আপনার সাইটের নিরাপত্তা নিয়ম অনুযায়ী ঝুঁকিপূর্ণ উঁচু কাজ বন্ধ করুন। এই বার্তা প্রকৌশলগত নিরাপত্তা মূল্যায়নের বিকল্প নয়।',
  },
  wind_stall: {
    en: 'Strong wind can lift roofs, signs and loose goods. Secure your stall now only if you can do it without going out in the storm. Once the storm starts, do not go out to rescue items.',
    bn: 'প্রবল হাওয়ায় চালা, সাইনবোর্ড ও হালকা মালপত্র উড়ে যেতে পারে। ঝড়ে বাইরে না গিয়ে যতটুকু সম্ভব, এখনই দোকান বেঁধে ফেলুন। ঝড় শুরু হলে মালপত্র বাঁচাতে বাইরে যাবেন না।',
  },
  wind_river: {
    en: 'Strong gusts make rivers dangerous for small boats. Postpone trips if you have not left, and head to the nearest landing early if you are on the water.',
    bn: 'প্রবল দমকা হাওয়ায় ছোট নৌকার জন্য নদী বিপজ্জনক হয়ে ওঠে। রওনা না দিয়ে থাকলে যাত্রা পিছিয়ে দিন, আর পানিতে থাকলে আগেভাগে নিকটতম ঘাটে ফিরুন।',
  },
  marine_pre_departure: {
    en: 'Postpone your departure and check the latest official forecast from BMD before you decide to go.',
    bn: 'রওনা পিছিয়ে দিন এবং যাওয়ার সিদ্ধান্ত নেওয়ার আগে বিএমডির সর্বশেষ সরকারি পূর্বাভাস দেখে নিন।',
  },
  marine_on_water: {
    en: 'You said you are on the water. Head toward the shore or the nearest shelter early and do not wait for conditions to get worse. Do not rely on this message alone for your route or timing.',
    bn: 'আপনি জানিয়েছেন আপনি পানিতে আছেন। আগেভাগে তীর বা নিকটতম আশ্রয়ের দিকে ফিরুন, পরিস্থিতি আরও খারাপ হওয়ার অপেক্ষা করবেন না। পথ বা সময় ঠিক করতে শুধু এই বার্তার ওপর নির্ভর করবেন না।',
  },
  marine_ashore: {
    en: 'Check the latest official forecast from BMD before you plan your next trip.',
    bn: 'পরবর্তী যাত্রার পরিকল্পনার আগে বিএমডির সর্বশেষ সরকারি পূর্বাভাস দেখে নিন।',
  },
  fish_stale_status: {
    en: 'Your last status update was about {hours} hours ago, so this alert may not match where you are now. Please update your status.',
    bn: 'আপনার সর্বশেষ অবস্থা হালনাগাদ প্রায় {hours} ঘণ্টা আগের, তাই এই সতর্কবার্তা আপনার বর্তমান অবস্থানের সঙ্গে নাও মিলতে পারে। অনুগ্রহ করে অবস্থা হালনাগাদ করুন।',
  },
  lightning_field: {
    en: 'If you are working in the field, stop and go to a substantial building or an enclosed vehicle now. Open fields and isolated trees are not shelter.',
    bn: 'আপনি মাঠে কাজ করলে এখনই কাজ বন্ধ করে পাকা ভবন বা বন্ধ গাড়িতে আশ্রয় নিন। খোলা মাঠ ও একা দাঁড়ানো গাছ আশ্রয় নয়।',
  },
  lightning_water: {
    en: 'You said you are on the water. Lightning is life-threatening on rivers and at sea: head for shore and take cover as soon as you can reach it. Do not rely on this message to judge your route.',
    bn: 'আপনি জানিয়েছেন আপনি পানিতে আছেন। নদী ও সমুদ্রে বজ্রপাত প্রাণঘাতী: যত দ্রুত সম্ভব তীরে গিয়ে আশ্রয় নিন। পথ ঠিক করতে এই বার্তার ওপর নির্ভর করবেন না।',
  },
  lightning_road: {
    en: 'If you are on the road, stop the rickshaw or vehicle and go inside a shop or building. Do not shelter under trees.',
    bn: 'আপনি রাস্তায় থাকলে রিকশা বা যান থামিয়ে দোকান বা ভবনের ভেতরে যান। গাছের নিচে আশ্রয় নেবেন না।',
  },
  lightning_height: {
    en: 'If you are working on a roof or scaffolding, stop and come down into a proper building now.',
    bn: 'আপনি ছাদে বা ভারায় কাজ করলে এখনই কাজ বন্ধ করে নেমে পাকা ভবনের ভেতরে যান।',
  },
  lightning_play: {
    en: 'If you are outdoors, leave the field and go into a building now. As general guidance, wait at least 30 minutes after the last thunder before going back outside.',
    bn: 'আপনি বাইরে থাকলে এখনই মাঠ ছেড়ে ভবনের ভেতরে যান। সাধারণ নির্দেশনা হিসেবে, শেষ বজ্রধ্বনির পর অন্তত ৩০ মিনিট অপেক্ষা করে তারপর বাইরে যান।',
  },
  storm_field: {
    en: 'If you are working in the field, finish now and get into a substantial building or an enclosed vehicle before the storm arrives. Open fields and isolated trees are not shelter.',
    bn: 'মাঠে কাজ করলে ঝড় আসার আগেই এখন কাজ শেষ করে পাকা ভবন বা বন্ধ গাড়িতে আশ্রয় নিন। খোলা মাঠ ও একা দাঁড়ানো গাছ আশ্রয় নয়।',
  },
  storm_water: {
    en: 'You said you are on the water. Head for shore now, before the storm arrives, and take cover as soon as you reach land. Do not rely on this message to judge your route.',
    bn: 'আপনি জানিয়েছেন আপনি পানিতে আছেন। ঝড় আসার আগেই এখন তীরের দিকে ফিরুন এবং ডাঙায় পৌঁছেই আশ্রয় নিন। পথ ঠিক করতে এই বার্তার ওপর নির্ভর করবেন না।',
  },
  storm_departure: {
    en: 'If you are about to go out on the water, wait until the storm has passed. If you are already out, head for shore now.',
    bn: 'পানিতে যাওয়ার প্রস্তুতি থাকলে ঝড় না কাটা পর্যন্ত অপেক্ষা করুন। ইতিমধ্যে পানিতে থাকলে এখনই তীরের দিকে ফিরুন।',
  },
  storm_site: {
    en: 'If you are working on a roof, scaffolding or at height, come down and go into a proper building before the storm arrives. Strong gusts and lightning can come with it.',
    bn: 'ছাদে, ভারায় বা উঁচুতে কাজ করলে ঝড় আসার আগেই নেমে পাকা ভবনের ভেতরে যান। ঝড়ের সঙ্গে প্রবল দমকা হাওয়া ও বজ্রপাত আসতে পারে।',
  },
  storm_stall: {
    en: 'Secure your goods only if it takes a few minutes, then go inside a building before the storm arrives. Awnings, stalls and trees are not shelter.',
    bn: 'কয়েক মিনিটে সম্ভব হলে তবেই মালপত্র গুছিয়ে নিন, তারপর ঝড় আসার আগেই কোনো ভবনের ভেতরে যান। ছাউনি, দোকানের চালা ও গাছ আশ্রয় নয়।',
  },
  storm_road: {
    en: 'Plan to stop before the storm arrives and go inside a shop or building. Do not shelter under trees.',
    bn: 'ঝড় আসার আগেই থামার পরিকল্পনা করুন এবং দোকান বা ভবনের ভেতরে যান। গাছের নিচে আশ্রয় নেবেন না।',
  },
  storm_public: {
    en: 'If you are outdoors, go into a building before the storm arrives and stop outdoor play or sport. As general guidance, wait at least 30 minutes after the last thunder before going back outside.',
    bn: 'বাইরে থাকলে ঝড় আসার আগেই কোনো ভবনের ভেতরে যান এবং বাইরের খেলাধুলা বন্ধ করুন। সাধারণ নির্দেশনা হিসেবে, শেষ বজ্রধ্বনির পর অন্তত ৩০ মিনিট অপেক্ষা করে তারপর বাইরে যান।',
  },
  official_river: {
    en: 'An official notice covering river waters was updated. Read the original notice for what applies to your area and follow its instructions.',
    bn: 'নদীপথ সম্পর্কিত একটি সরকারি বিজ্ঞপ্তি হালনাগাদ হয়েছে। আপনার এলাকায় কী প্রযোজ্য তা মূল বিজ্ঞপ্তিতে দেখুন এবং এর নির্দেশনা মেনে চলুন।',
  },
  official_marine: {
    en: 'An official marine notice was updated. Read the original notice for what applies to your waters and follow its instructions.',
    bn: 'সমুদ্র সম্পর্কিত একটি সরকারি বিজ্ঞপ্তি হালনাগাদ হয়েছে। আপনার জলসীমায় কী প্রযোজ্য তা মূল বিজ্ঞপ্তিতে দেখুন এবং এর নির্দেশনা মেনে চলুন।',
  },
  official_transition: {
    en: 'An official warning was withdrawn, but water conditions can stay rough for some time. Check the latest official forecast before you decide to go out.',
    bn: 'একটি সরকারি সতর্কতা প্রত্যাহার হয়েছে, কিন্তু পানির অবস্থা কিছুক্ষণ উত্তাল থাকতে পারে। বের হওয়ার সিদ্ধান্তের আগে সর্বশেষ সরকারি পূর্বাভাস দেখে নিন।',
  },
};

export const ACTIONS = {
  cover_harvest: { en: 'Cover or move harvested crops', bn: 'কাটা ফসল ঢেকে বা সরিয়ে রাখুন' },
  check_forecast: { en: 'Check the latest forecast', bn: 'সর্বশেষ পূর্বাভাস দেখুন' },
  plan_fieldwork: { en: 'Plan field work around the rain', bn: 'বৃষ্টির সময় বুঝে মাঠের কাজ সাজান' },
  check_drainage: { en: 'Check field drainage', bn: 'জমির পানি নিষ্কাশন দেখুন' },
  leave_early: { en: 'Leave a little earlier', bn: 'একটু আগে বের হোন' },
  check_roads: { en: 'Check road conditions locally', bn: 'রাস্তার অবস্থা স্থানীয়ভাবে দেখুন' },
  extra_travel_time: { en: 'Allow extra travel time', bn: 'যাতায়াতে বাড়তি সময় রাখুন' },
  check_field_moisture: { en: 'Check the moisture in your field', bn: 'জমির আর্দ্রতা দেখুন' },
  use_irrigation: { en: 'Use irrigation if the soil is drying', bn: 'মাটি শুকালে সেচ দিন' },
  save_water: { en: 'Plan how to save water', bn: 'পানি বাঁচানোর পরিকল্পনা করুন' },
  rest_shade: { en: 'Rest often in the shade', bn: 'ঘন ঘন ছায়ায় বিশ্রাম নিন' },
  drink_water: { en: 'Drink water regularly', bn: 'নিয়মিত পানি পান করুন' },
  shift_hours: { en: 'Move heavy work away from the hottest hours', bn: 'ভারী কাজ সবচেয়ে গরম সময় থেকে সরান' },
  seek_medical: { en: 'Get urgent medical help for serious symptoms', bn: 'গুরুতর লক্ষণে জরুরি চিকিৎসা নিন' },
  check_on_coworkers: { en: 'Check on the people you work with', bn: 'সহকর্মীদের খোঁজ নিন' },
  ask_supervisor: { en: 'Ask your supervisor to review the work and rest plan', bn: 'কাজ ও বিশ্রামের পরিকল্পনা পর্যালোচনায় সুপারভাইজারকে বলুন' },
  move_cooler: { en: 'Move to a cooler place', bn: 'ঠান্ডা জায়গায় যান' },
  stop_elevated_work: { en: 'Stop unsafe work at height', bn: 'ঝুঁকিপূর্ণ উঁচু কাজ বন্ধ করুন' },
  secure_stall: { en: 'Secure your stall only if you can do it without going out in the storm', bn: 'ঝড়ে বাইরে না গিয়ে যতটুকু সম্ভব দোকান বেঁধে ফেলুন' },
  inspect_site: { en: 'Inspect stairs, walkways and scaffolding before work resumes', bn: 'কাজ শুরুর আগে সিঁড়ি, চলার পথ ও ভারা পরীক্ষা করুন' },
  cover_goods: { en: 'Bring cover for your goods', bn: 'মালপত্র ঢাকার ব্যবস্থা সঙ্গে রাখুন' },
  share_location: { en: 'Share your location again if you are at another market', bn: 'অন্য বাজারে থাকলে আবার অবস্থান জানান' },
  stay_in: { en:'Do not go out to rescue items once the storm starts', bn: 'ঝড় শুরু হলে মালপত্র বাঁচাতে বাইরে যাবেন না' },
  postpone_departure: { en: 'Postpone your departure', bn: 'রওনা পিছিয়ে দিন' },
  return_to_shore: { en: 'Head toward the shore or nearest shelter', bn: 'তীর বা নিকটতম আশ্রয়ের দিকে ফিরুন' },
  check_official_forecast: { en: 'Check the latest official BMD forecast', bn: 'বিএমডির সর্বশেষ সরকারি পূর্বাভাস দেখুন' },
  update_status: { en: 'Update your status', bn: 'আপনার অবস্থা হালনাগাদ করুন' },
  stop_fieldwork: { en: 'Stop fieldwork', bn: 'মাঠের কাজ বন্ধ করুন' },
  seek_shelter: { en: 'Take cover as soon as you reach land', bn: 'ডাঙায় পৌঁছেই আশ্রয় নিন' },
  go_to_building: { en: 'Go into a substantial building or enclosed vehicle', bn: 'পাকা ভবন বা বন্ধ গাড়িতে যান' },
  avoid_trees: { en: 'Do not shelter under trees', bn: 'গাছের নিচে আশ্রয় নেবেন না' },
  stop_vehicle: { en: 'Stop the rickshaw or vehicle and go inside', bn: 'রিকশা বা যান থামিয়ে ভেতরে যান' },
  come_down: { en: 'Come down from the roof or scaffolding', bn: 'ছাদ বা ভারা থেকে নেমে আসুন' },
  leave_field: { en: 'Leave the field and go into a building', bn: 'মাঠ ছেড়ে ভবনের ভেতরে যান' },
  wait_30: { en: 'Wait at least 30 minutes after the last thunder', bn: 'শেষ বজ্রধ্বনির পর অন্তত ৩০ মিনিট অপেক্ষা করুন' },
  read_notice: { en: 'Read the original official notice', bn: 'মূল সরকারি বিজ্ঞপ্তি পড়ুন' },
};

// ---------- reasons ("why you received this") ----------
export function reasonText({ occupation, details = [], areaRole, areaName, activityLabel = null }, lang) {
  const occ = occupationLabel(occupation, lang);
  const roleWord = pick(AREA_ROLE_WORDS[areaRole] ?? AREA_ROLE_WORDS.home, lang);
  const parts = details.map((detail) => pick(detail, lang)).filter(Boolean);
  if (activityLabel) parts.push(lang === 'bn' ? `আপনি জানিয়েছেন আপনি এখন: ${activityLabel}` : `you said you are currently: ${activityLabel}`);
  return lang === 'bn'
    ? `আপনি ${occ} হিসেবে নিবন্ধিত${parts.length ? `; ${parts.join('; ')}` : ''}; ${roleWord} ${areaName}-এ।`
    : `You are registered as ${/^[aeiou]/i.test(occ) ? 'an' : 'a'} ${occ.toLowerCase()}${parts.length ? `; ${parts.join('; ')}` : ''}; ${roleWord} is in ${areaName}.`;
}

export function areaText({ scope, name, districtName }, lang) {
  if (scope === 'district') return lang === 'bn' ? `${name} জেলা (জেলাভিত্তিক বিজ্ঞপ্তি)` : `${name} district (district-wide notice)`;
  if (scope === 'marine-zone') return name;
  return districtName && districtName !== name ? `${name}, ${districtName}` : name;
}

export function zoneName(zoneId, lang) {
  return pick(ZONE_NAMES[zoneId], lang) ?? zoneId;
}
