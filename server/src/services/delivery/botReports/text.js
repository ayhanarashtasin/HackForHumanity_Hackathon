import { env } from '../../../config/env.js';
import {
  BN_MONTHS, EN_MONTHS, PROVIDER_LABELS, dayWord, localizeDigits, whenText,
} from '../../alerts/messages.js';
import {
  DHAKA_OFFSET_MS, addDays, dhakaDate, formatHm,
} from '../../time.js';
import { parentOf } from './places.js';
import {
  COMPASS, STEP_MS, compassIndex, dailySummaries, dayParts, freshnessOf, gustClass, hasHailCode, heatCategory, isThunderCode, laterIdx, lowOf, peakOf,
  rainClass, sumOf, todayIdx, windowIdx,
} from './readings.js';

// The words of the bot's weather replies, in English and Bangla. The Bangla is a draft that still needs a fluent reader (BN_REVIEWED).
// Style rules are the alert rules (alerts/messages.js DISCOURAGED_PHRASES, enforced by test): never "safe", never "all clear", never a
// forecast described as a measurement, never zero for a missing value. Replies are HTML for Telegram; every dynamic string is escaped.
const MAX_LENGTH = 3800;
const MAX_TIMELINE_LINES = 4;

export const COMMAND_NAMES = ['update', 'heat', 'rain', 'wind', 'thunderstorm', 'lightning', 'forecast', 'route', 'alerts', 'status'];

export const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bold = (value) => `<b>${esc(value)}</b>`;
const italic = (value) => `<i>${esc(value)}</i>`;

export function fit(text) {
  if (text.length <= MAX_LENGTH) return text;
  const cut = text.slice(0, MAX_LENGTH);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('\n'), 1)).trimEnd()}\n…`;
}

// Strips the tags again, for the rare case Telegram refuses the formatted text.
export function toPlain(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function makeText(lang, nowMs) {
  const L = lang === 'bn' ? 'bn' : 'en';
  const s = (en, bn) => (L === 'bn' ? bn : en);
  const digits = (text) => localizeDigits(text, L);
  const n = (value, places = 0) => (Number.isFinite(value) ? digits(value.toFixed(places)) : '–');
  const hm = (ms) => digits(formatHm(new Date(ms)));
  const when = (ms) => digits(whenText(ms, nowMs, L));
  const range = (ms) => `${when(ms)}–${hm(ms + STEP_MS)}`;
  const day = (ms) => {
    const word = digits(dayWord(ms, nowMs, L));
    return L === 'en' ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  };
  const c = (value, places = 0) => `${n(value, places)} ${s('°C', '°সে.')}`;
  const mm = (value, places = 1) => `${n(value, places)} ${s('mm', 'মিমি')}`;
  const kph = (value) => `${n(value)} ${s('km/h', 'কিমি/ঘণ্টা')}`;
  const pct = (value) => `${n(value)}%`;
  const ago = (ms) => {
    const minutes = Math.max(Math.round((nowMs - ms) / 60_000), 0);
    if (minutes < 1) return s('just now', 'এইমাত্র');
    if (minutes < 120) return s(`${n(minutes)} min ago`, `${n(minutes)} মিনিট আগে`);
    return s(`${n(Math.round(minutes / 60))} h ago`, `${n(Math.round(minutes / 60))} ঘণ্টা আগে`);
  };
  return {
    L, s, n, hm, when, range, day, c, mm, kph, pct, ago,
  };
}

// ---------- vocabulary ----------
const CONDITION = {
  en: {
    0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
  },
  bn: {
    0: 'পরিষ্কার আকাশ', 1: 'প্রায় পরিষ্কার', 2: 'আংশিক মেঘলা', 3: 'মেঘলা', 45: 'কুয়াশা', 48: 'হিমশীতল কুয়াশা', 51: 'হালকা গুঁড়িগুঁড়ি বৃষ্টি',
    53: 'গুঁড়িগুঁড়ি বৃষ্টি', 55: 'ঘন গুঁড়িগুঁড়ি বৃষ্টি', 56: 'হিমশীতল গুঁড়িগুঁড়ি বৃষ্টি', 57: 'হিমশীতল গুঁড়িগুঁড়ি বৃষ্টি', 61: 'হালকা বৃষ্টি',
    63: 'বৃষ্টি', 65: 'ভারী বৃষ্টি', 66: 'হিমশীতল বৃষ্টি', 67: 'হিমশীতল বৃষ্টি', 80: 'হালকা বৃষ্টির ঝাপটা', 81: 'বৃষ্টির ঝাপটা',
    82: 'তীব্র বৃষ্টির ঝাপটা', 95: 'বজ্রসহ বৃষ্টি', 96: 'বজ্রসহ বৃষ্টি, শিলাবৃষ্টি', 99: 'বজ্রসহ বৃষ্টি, ভারী শিলাবৃষ্টি',
  },
};

function conditionEmoji(code) {
  if (code === null || code === undefined) return '🌡';
  if (code >= 95) return '⛈';
  if (code >= 80 && code <= 82) return '🌦';
  if (code >= 61) return '🌧';
  if (code >= 51) return '🌦';
  if (code >= 45) return '🌫';
  if (code === 3) return '☁️';
  if (code === 2) return '⛅';
  return '☀️';
}

const HEAT_NAMES = {
  en: ['Below the caution level', 'Caution', 'Extreme caution', 'Danger', 'Extreme danger'],
  bn: ['সতর্ক-স্তরের নিচে', 'সতর্কতা', 'বিশেষ সতর্কতা', 'বিপজ্জনক', 'অত্যন্ত বিপজ্জনক'],
};
const HEAT_ADVICE = {
  en: [
    'The forecast heat index stays below the caution level (27 °C) in the next 24 hours.',
    'Drink water regularly and take breaks in the shade.',
    'Drink water often, rest in the shade and avoid heavy work in the hottest hours.',
    'Limit outdoor work, drink water often and rest in the shade.',
    'Avoid outdoor activity during these hours.',
  ],
  bn: [
    'পরবর্তী ২৪ ঘণ্টায় পূর্বাভাসের হিট ইনডেক্স সতর্ক-স্তরের (২৭ °সে.) নিচে থাকবে।',
    'নিয়মিত পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
    'ঘন ঘন পানি পান করুন, ছায়ায় বিশ্রাম নিন এবং গরমের সময় ভারী কাজ এড়িয়ে চলুন।',
    'বাইরের কাজ কমান, ঘন ঘন পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
    'এই সময়ে বাইরের কাজ এড়িয়ে চলুন।',
  ],
};

const RAIN_NAMES = {
  en: { none: 'no rain', light: 'light rain', moderate: 'moderate rain', heavy: 'heavy rain', very_heavy: 'very heavy rain' },
  bn: { none: 'বৃষ্টি নেই', light: 'হালকা বৃষ্টি', moderate: 'মাঝারি বৃষ্টি', heavy: 'ভারী বৃষ্টি', very_heavy: 'অতি ভারী বৃষ্টি' },
};
const GUST_NAMES = {
  en: { light: 'light to moderate wind', brisk: 'brisk wind', strong: 'strong gusts', very_strong: 'very strong gusts', severe: 'severe gusts' },
  bn: { light: 'হালকা থেকে মাঝারি বাতাস', brisk: 'জোরালো বাতাস', strong: 'প্রবল দমকা হাওয়া', very_strong: 'অত্যন্ত প্রবল দমকা হাওয়া', severe: 'ভয়ংকর দমকা হাওয়া' },
};
const THUNDER_NAMES = { en: ['None', 'Low', 'Moderate', 'High'], bn: ['নেই', 'কম', 'মাঝারি', 'বেশি'] };
const COMPASS_NAMES = {
  en: COMPASS,
  bn: ['উত্তর', 'উত্তর-পূর্ব', 'পূর্ব', 'দক্ষিণ-পূর্ব', 'দক্ষিণ', 'দক্ষিণ-পশ্চিম', 'পশ্চিম', 'উত্তর-পশ্চিম'],
};
const SEVERITY_NAMES = { en: { ADVISORY: 'Advisory', WARNING: 'Warning', CRITICAL: 'Critical' }, bn: { ADVISORY: 'পরামর্শ', WARNING: 'সতর্কতা', CRITICAL: 'জরুরি' } };
const KIND_NAMES = {
  en: { district: 'District', thana: 'City thana', upazila: 'Upazila', 'city-corporation': 'City corporation' },
  bn: { district: 'জেলা', thana: 'সিটি থানা', upazila: 'উপজেলা', 'city-corporation': 'সিটি কর্পোরেশন' },
};

const nameOf = (place, L) => (L === 'bn' ? place.nameBn || place.name : place.name);

function placeTitle(place, T) {
  const parent = parentOf(place);
  const parentName = parent ? (T.L === 'bn' ? parent.nameBn || parent.name : parent.name) : null;
  const kind = KIND_NAMES[T.L][place.kind];
  const where = place.level === 'district' ? kind : parentName || kind;
  return `${bold(nameOf(place, T.L))} · ${esc(where)}`;
}

function placeNote(place, T) {
  if (place.level === 'district') {
    return T.s(
      'District: average temperature; highest heat, rain and gusts.',
      'জেলা: গড় তাপমাত্রা; সর্বোচ্চ গরম, বৃষ্টি ও দমকা হাওয়া।',
    );
  }
  if (place.level === 'polygon') {
    return (place.members?.length ?? 0) > 1 && !place.approx
      ? T.s('Area forecast: average of its thanas.', 'এলাকার পূর্বাভাস: থানাগুলোর গড়।')
      : T.s('Forecast for the nearest available location.', 'নিকটতম অবস্থানের পূর্বাভাস।');
  }
  return null;
}

// ---------- shared lines ----------
function freshnessNote(T, info) {
  const fresh = freshnessOf(info);
  if (fresh.status === 'ok') return null;
  if (fresh.status === 'stale') {
    return `⚠ ${T.s('Stale data', 'পুরনো তথ্য')}${fresh.updatedMs ? ` · ${T.s('updated', 'হালনাগাদ')} ${esc(T.when(fresh.updatedMs))}` : ''}`;
  }
  return `⚠ ${T.s('Latest data unavailable', 'সর্বশেষ তথ্য পাওয়া যাচ্ছে না')}`;
}

function reportHeader(place, T, icon, en, bn, infos = []) {
  const lines = [`${icon} ${bold(T.s(en, bn))}`, placeTitle(place, T)];
  const note = placeNote(place, T);
  if (note) lines.push(italic(note));
  lines.push(...new Set(infos.map((info) => freshnessNote(T, info)).filter(Boolean)));
  return [...lines, ''];
}

const rainNote = (f, T) => (f.rain.unverified ? `⚠ ${T.s('Rain unit unverified.', 'বৃষ্টির একক যাচাই হয়নি।')}` : null);

function unavailable(f, place, T, what) {
  return fit([
    placeTitle(place, T),
    '',
    T.s(
      `${what} is not available for this place right now.`,
      `এই জায়গার জন্য ${what} এখন পাওয়া যাচ্ছে না।`,
    ),
  ].join('\n'));
}

const heatName = (level, T) => HEAT_NAMES[T.L][level];
const thunderName = (level, T) => (Number.isFinite(level) ? THUNDER_NAMES[T.L][Math.min(Math.max(level, 0), 3)] : '–');
const windFrom = (degrees, T) => {
  const i = compassIndex(degrees);
  if (i === null) return '';
  return T.s(` from ${COMPASS_NAMES.en[i]}`, ` ${COMPASS_NAMES.bn[i]} দিক থেকে`);
};

// ---------- buttons ----------
export function buttonsFor(place, lang) {
  const T = makeText(lang, 0);
  const button = (emoji, en, bn, command) => ({ text: `${emoji} ${T.s(en, bn)}`, data: `r:${command}:${place.id}:${T.L}` });
  return [
    [button('🌡', 'Heat', 'গরম', 'heat'), button('🌧', 'Rain', 'বৃষ্টি', 'rain'), button('💨', 'Wind', 'বাতাস', 'wind')],
    [button('⛈', 'Thunderstorm', 'বজ্রঝড়', 'thunderstorm'), button('⚡', 'Lightning', 'বজ্রপাত', 'lightning'), button('📅', 'Days', 'দিনগুলো', 'forecast')],
  ];
}

// ---------- /update ----------
export function renderUpdate(f, { lang, nowMs, lightning = undefined, alertCount = null }) {
  const T = makeText(lang, nowMs);
  if (!f.available) return unavailable(f, f.place, T, T.s('The forecast', 'পূর্বাভাস'));

  const lines = reportHeader(f.place, T, '📍', 'Weather forecast', 'আবহাওয়ার পূর্বাভাস', [f.coreInfo, f.rain.info, ...(f.thunder.values ? [f.thunder.info] : [])]);

  const i = f.nowIdx;
  const { cols } = f;
  if (i >= 0) {
    const code = cols.wmo?.[i] ?? null;
    const label = CONDITION[T.L][code] ?? null;
    lines.push(`${bold(T.s('Now', 'এখন'))} · ${T.range(f.steps[i])}`);
    lines.push(`${conditionEmoji(code)} ${label ? `${esc(label)} · ` : ''}${bold(T.c(cols.temp[i], 1))}`);
    const hiLevel = heatCategory(cols.hi?.[i]);
    lines.push(`${T.s('Heat index', 'হিট ইনডেক্স')}: ${T.c(cols.hi?.[i], 0)}${hiLevel === null ? '' : ` · ${esc(heatName(hiLevel, T))}`}`);
    const chance = Number.isFinite(f.cols.pop?.[i]) ? ` · ${T.s('chance', 'সম্ভাবনা')} ${T.pct(f.cols.pop[i])}` : '';
    lines.push(`${T.s('Rain (3 h)', 'বৃষ্টি (৩ ঘণ্টা)')}: ${T.mm(f.rain.values?.[i])}${chance}`);
    lines.push(`${T.s('Wind', 'বাতাস')}: ${T.kph(cols.ws?.[i])} · ${T.s('gust', 'দমকা')} ${T.kph(cols.wg?.[i])}`);
    lines.push(`${T.s('Humidity', 'আর্দ্রতা')}: ${T.pct(cols.rh?.[i])}`);
    if (f.thunder.values) lines.push(`${T.s('Thunderstorm potential', 'বজ্রঝড়ের সম্ভাবনা')}: ${esc(thunderName(f.thunder.values[i], T))}`);
  } else {
    lines.push(T.s('The stored forecast does not cover the current time.', 'সংরক্ষিত পূর্বাভাস বর্তমান সময়কে ধরে না।'));
  }

  const later = laterIdx(f, 12).slice(0, MAX_TIMELINE_LINES);
  if (later.length) {
    lines.push('', bold(T.s('Next 12 hours', 'পরবর্তী ১২ ঘণ্টা')));
    for (const k of later) {
      const parts = [T.when(f.steps[k]), T.c(cols.temp[k]), `${T.s('rain', 'বৃষ্টি')} ${T.mm(f.rain.values?.[k])}`];
      lines.push(parts.map(esc).join(' · '));
    }
  }

  if (lightning !== undefined) lines.push('', `⚡ ${esc(lightningShort(lightning, T))}`);
  if (alertCount !== null) {
    lines.push(alertCount > 0
      ? `🔔 ${T.s(`${T.n(alertCount)} active alert${alertCount === 1 ? '' : 's'} · send /alerts`, `${T.n(alertCount)}টি সক্রিয় সতর্কবার্তা · /alerts পাঠান`)}`
      : `🔔 ${T.s('No active AkashSathi alert.', 'আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই।')}`);
  }

  if (rainNote(f, T)) lines.push('', rainNote(f, T));
  return fit(lines.join('\n'));
}

// ---------- /heat ----------
export function renderHeat(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available) return unavailable(f, f.place, T, T.s('Heat information', 'গরমের তথ্য'));
  const { cols } = f;
  const win = windowIdx(f, 24);
  const peak = peakOf(cols.hi, win);
  const hottest = peakOf(cols.temp, win);
  if (!peak && !hottest) return unavailable(f, f.place, T, T.s('Heat information', 'গরমের তথ্য'));

  const lines = reportHeader(f.place, T, '🌡', 'Heat forecast', 'গরমের পূর্বাভাস', [f.coreInfo]);

  const i = f.nowIdx;
  if (i >= 0) {
    const level = heatCategory(cols.hi?.[i]);
    lines.push(`${T.s('Now', 'এখন')}: ${T.c(cols.temp[i], 1)} · ${T.s('heat index', 'হিট ইনডেক্স')} ${T.c(cols.hi?.[i])}${level === null ? '' : ` (${esc(heatName(level, T))})`}`);
  }
  if (peak) {
    const level = heatCategory(peak.value);
    lines.push(`${bold(T.s('Peak heat index (24 h)', 'সর্বোচ্চ হিট ইনডেক্স (২৪ ঘণ্টা)'))}: ${T.c(peak.value)} · ${esc(heatName(level, T))}`);
    lines.push(`${T.s('Time', 'সময়')}: ${T.range(f.steps[peak.index])}`);
    if (hottest) lines.push(`${T.s('Max temperature', 'সর্বোচ্চ তাপমাত্রা')}: ${T.c(hottest.value, 1)}`);
    const later = laterIdx(f, 12).slice(0, MAX_TIMELINE_LINES);
    if (later.length) lines.push('', bold(T.s('Heat index · next 12 hours', 'হিট ইনডেক্স · পরবর্তী ১২ ঘণ্টা')));
    for (const k of later) {
      const level2 = heatCategory(cols.hi?.[k]);
      lines.push(`${esc(T.when(f.steps[k]))} · ${T.c(cols.hi?.[k])}${level2 ? ` · ${esc(heatName(level2, T))}` : ''}`);
    }
    lines.push('', esc(HEAT_ADVICE[T.L][level]));
  } else {
    lines.push(T.s('The heat index is not available; only the temperature is.', 'হিট ইনডেক্স পাওয়া যাচ্ছে না; শুধু তাপমাত্রা আছে।'));
  }
  return fit(lines.join('\n'));
}

// ---------- /rain ----------
export function renderRain(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available || !f.rain.values) return unavailable(f, f.place, T, T.s('The rain forecast', 'বৃষ্টির পূর্বাভাস'));
  const win = windowIdx(f, 24);
  const { total, partial } = sumOf(f.rain.values, win);
  if (total === null) return unavailable(f, f.place, T, T.s('The rain forecast', 'বৃষ্টির পূর্বাভাস'));

  const lines = reportHeader(f.place, T, '🌧', 'Rain forecast', 'বৃষ্টির পূর্বাভাস', [f.rain.info]);
  lines.push(`${bold(T.s('Total (24 h)', 'মোট (২৪ ঘণ্টা)'))}: ${partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(total)}`);
  const wettest = peakOf(f.rain.values, win);
  if (wettest && wettest.value >= 0.1) {
    lines.push(`${T.s('Wettest 3 h', 'সর্বোচ্চ বৃষ্টি (৩ ঘণ্টা)')}: ${T.mm(wettest.value)} · ${esc(RAIN_NAMES[T.L][rainClass(wettest.value)])}`);
    lines.push(`${T.s('Time', 'সময়')}: ${T.range(f.steps[wettest.index])}`);
  }
  if (total < 0.1) lines.push(T.s('Almost no rain in the forecast.', 'পূর্বাভাসে প্রায় কোনো বৃষ্টি নেই।'));
  const later = laterIdx(f, 12).slice(0, MAX_TIMELINE_LINES);
  if (later.length) lines.push('', bold(T.s('Next 12 hours · 3-hour amounts', 'পরবর্তী ১২ ঘণ্টা · ৩ ঘণ্টার পরিমাণ')));
  for (const k of later) {
    const amount = f.rain.values[k];
    const klass = rainClass(amount);
    const chance = Number.isFinite(f.cols.pop?.[k]) ? ` · ${T.s('chance', 'সম্ভাবনা')} ${T.pct(f.cols.pop[k])}` : '';
    lines.push(`${esc(T.range(f.steps[k]))} · ${T.mm(amount)}${klass ? ` (${esc(RAIN_NAMES[T.L][klass])})` : ''}${chance}`);
  }
  if (rainNote(f, T)) lines.push('', rainNote(f, T));
  return fit(lines.join('\n'));
}

// ---------- /wind ----------
export function renderWind(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available || !f.cols.wg) return unavailable(f, f.place, T, T.s('The wind forecast', 'বাতাসের পূর্বাভাস'));
  const { cols } = f;
  const win = windowIdx(f, 24);
  const peak = peakOf(cols.wg, win);
  if (!peak) return unavailable(f, f.place, T, T.s('The wind forecast', 'বাতাসের পূর্বাভাস'));

  const lines = reportHeader(f.place, T, '💨', 'Wind forecast', 'বাতাসের পূর্বাভাস', [f.coreInfo]);
  const i = f.nowIdx;
  if (i >= 0) lines.push(`${T.s('Now', 'এখন')}: ${T.kph(cols.ws?.[i])}${esc(windFrom(cols.wd?.[i], T))} · ${T.s('gust', 'দমকা')} ${T.kph(cols.wg[i])}`);
  const klass = gustClass(peak.value);
  lines.push(`${bold(T.s('Peak gust (24 h)', 'সর্বোচ্চ দমকা হাওয়া (২৪ ঘণ্টা)'))}: ${T.kph(peak.value)} · ${esc(GUST_NAMES[T.L][klass])}`);
  lines.push(`${T.s('Time', 'সময়')}: ${T.range(f.steps[peak.index])}`);
  const later = laterIdx(f, 12).slice(0, MAX_TIMELINE_LINES);
  if (later.length) lines.push('', bold(T.s('Next 12 hours', 'পরবর্তী ১২ ঘণ্টা')));
  for (const k of later) {
    lines.push(`${esc(T.when(f.steps[k]))} · ${T.kph(cols.ws?.[k])} · ${T.s('gust', 'দমকা')} ${T.kph(cols.wg?.[k])}`);
  }
  if (peak.value >= 40) lines.push('', T.s('Secure loose objects; take care on boats and roofs.', 'আলগা জিনিস বেঁধে রাখুন; নৌকা ও ছাদে সতর্ক থাকুন।'));
  return fit(lines.join('\n'));
}

// ---------- /thunderstorm ----------
export function renderThunderstorm(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  const values = f.available ? f.thunder.values : null;
  if (!f.available || !values) return unavailable(f, f.place, T, T.s('The thunderstorm outlook', 'বজ্রঝড়ের পূর্বাভাস'));
  const win = windowIdx(f, 24);
  const peak = peakOf(values, win);
  if (!peak) return unavailable(f, f.place, T, T.s('The thunderstorm outlook', 'বজ্রঝড়ের পূর্বাভাস'));

  const lines = reportHeader(f.place, T, '⛈', 'Thunderstorm forecast', 'বজ্রঝড়ের পূর্বাভাস', [f.thunder.info]);
  lines.push(`${bold(T.s('Peak potential (24 h)', 'সর্বোচ্চ সম্ভাবনা (২৪ ঘণ্টা)'))}: ${esc(thunderName(peak.value, T))}`);
  if (peak.value >= 1) {
    const gust = f.cols.wg?.[peak.index];
    lines.push(`${T.s('Time', 'সময়')}: ${T.range(f.steps[peak.index])}`);
    if (Number.isFinite(f.cols.pop?.[peak.index])) lines.push(`${T.s('Chance of rain', 'বৃষ্টির সম্ভাবনা')}: ${T.pct(f.cols.pop[peak.index])}`);
    if (Number.isFinite(gust)) lines.push(`${T.s('Gust', 'দমকা হাওয়া')}: ${T.kph(gust)}`);
  }

  const codes = f.cols.wmo;
  const stormSteps = win.filter((k) => isThunderCode(codes?.[k]));
  if (stormSteps.length) {
    const hail = stormSteps.some((k) => hasHailCode(codes[k]));
    lines.push(T.s(`Thunderstorm forecast${hail ? ' with hail' : ''}.`, `বজ্রসহ বৃষ্টির পূর্বাভাস${hail ? ', শিলাবৃষ্টিসহ' : ''}।`));
  }
  const later = laterIdx(f, 12).slice(0, MAX_TIMELINE_LINES);
  if (later.length) lines.push('', bold(T.s('Next 12 hours', 'পরবর্তী ১২ ঘণ্টা')));
  for (const k of later) {
    const chance = Number.isFinite(f.cols.pop?.[k]) ? ` · ${T.s('rain', 'বৃষ্টি')} ${T.pct(f.cols.pop[k])}` : '';
    lines.push(`${esc(T.range(f.steps[k]))} · ${esc(thunderName(values[k], T))}${chance}`);
  }
  lines.push('', T.s(
    'If you hear thunder, go indoors; avoid isolated trees and open water.',
    'বজ্রের শব্দ শুনলে ঘরে যান; একা গাছ ও খোলা জলাশয় এড়িয়ে চলুন।',
  ));
  return fit(lines.join('\n'));
}

// ---------- /lightning ----------
// `lightning` is { pick, error }: pick is the check most worth showing (readings.chooseLightning) or null.
function lightningLines(lightning, T, { short = false } = {}) {
  const pick = lightning?.pick ?? null;
  if (!pick) {
    if (lightning?.error) return T.s('Lightning data could not be read right now.', 'বজ্রপাতের তথ্য এখন পড়া যাচ্ছে না।');
    return T.s('No lightning check for this place yet.', 'এই জায়গার জন্য এখনো বজ্রপাতের তথ্য নেই।');
  }
  const at = Number.isFinite(pick.sampledMs) ? T.when(pick.sampledMs) : '–';
  const r = T.n(pick.radiusKm);
  switch (pick.kind) {
    case 'reported': {
      const count = T.n(pick.count);
      return short
        ? T.s(`Last lightning check: ${at} · ${count} recorded (${r} km).`, `সর্বশেষ বজ্রপাত পরীক্ষা: ${at} · ${count}টি রেকর্ড (${r} কিমি)।`)
        : [
          T.s('Lightning was recorded.', 'বজ্রপাত রেকর্ড হয়েছে।'),
          T.s(`Last check: ${at}`, `সর্বশেষ পরীক্ষা: ${at}`),
          T.s(`Strikes (previous 5 min): ${count}`, `বজ্রপাত (আগের ৫ মিনিট): ${count}টি`),
          T.s(`Search radius: ${r} km`, `অনুসন্ধানের ব্যাসার্ধ: ${r} কিমি`),
        ].join('\n');
    }
    case 'none':
      return short
        ? T.s(`Last lightning check: ${at} · none recorded.`, `সর্বশেষ বজ্রপাত পরীক্ষা: ${at} · কিছু রেকর্ড হয়নি।`)
        : [
          T.s('No lightning was recorded at the last check.', 'সর্বশেষ পরীক্ষায় কোনো বজ্রপাত রেকর্ড হয়নি।'),
          T.s(`Last check: ${at}`, `সর্বশেষ পরীক্ষা: ${at}`),
          T.s(`Window: previous 5 min · radius ${r} km`, `সময়সীমা: আগের ৫ মিনিট · ব্যাসার্ধ ${r} কিমি`),
        ].join('\n');
    case 'stale':
      return T.s(`The last successful lightning check (${at}) is out of date.`, `সর্বশেষ সফল বজ্রপাত পরীক্ষা (${at}) পুরনো হয়ে গেছে।`);
    case 'unavailable':
      return T.s('The lightning check is not available right now.', 'বজ্রপাত পরীক্ষা এখন পাওয়া যাচ্ছে না।');
    default:
      return T.s('Lightning has not been checked yet.', 'বজ্রপাত এখনো পরীক্ষা করা হয়নি।');
  }
}

const lightningShort = (lightning, T) => lightningLines(lightning, T, { short: true });

export function renderLightning(f, { lang, nowMs, lightning, place }) {
  const T = makeText(lang, nowMs);
  const target = place ?? f.place;
  const lines = [`⚡ ${bold(T.s('Lightning report', 'বজ্রপাতের তথ্য'))}`, placeTitle(target, T), '', esc(lightningLines(lightning, T))];
  if (lightning?.pick?.kind === 'reported') lines.push('', T.s('If you hear thunder, go indoors.', 'বজ্রের শব্দ শুনলে ঘরে যান।'));
  return fit(lines.join('\n'));
}

// ---------- /forecast ----------
export function renderForecast(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available) return unavailable(f, f.place, T, T.s('The forecast', 'পূর্বাভাস'));
  const days = dailySummaries(f);
  if (!days.length) return unavailable(f, f.place, T, T.s('The daily forecast', 'দৈনিক পূর্বাভাস'));

  const lines = reportHeader(f.place, T, '📅', 'Daily forecast', 'আগামী দিনগুলোর পূর্বাভাস', [f.coreInfo, f.rain.info, ...(f.thunder.values ? [f.thunder.info] : [])]);
  for (const day of days) {
    lines.push(`${bold(T.day(day.startMs))} · ${T.n(day.low)}–${T.n(day.high)} ${T.s('°C', '°সে.')}`);
    const parts = [
      day.rain.total === null ? T.s('rain not available', 'বৃষ্টির তথ্য নেই') : `${T.s('rain', 'বৃষ্টি')} ${day.rain.partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(day.rain.total)}`,
    ];
    if (Number.isFinite(day.pop)) parts.push(`${T.s('chance', 'সম্ভাবনা')} ${T.pct(day.pop)}`);
    lines.push(parts.join(' · '));
    const wind = [`${T.s('gust', 'দমকা')} ${T.kph(day.gust)}`];
    if ((day.thunder ?? 0) >= 1) wind.push(`${T.s('thunder', 'বজ্রঝড়')}: ${thunderName(day.thunder, T)}`);
    lines.push(wind.join(' · '), '');
  }
  if (rainNote(f, T)) lines.push(rainNote(f, T));
  return fit(lines.join('\n').trimEnd());
}

// ---------- /alerts ----------
export function renderAlerts({ lang, nowMs, linked, items = [], webUrl = env.channels.publicUrl }) {
  const T = makeText(lang, nowMs);
  if (!linked) {
    return fit([
      `🔔 ${bold(T.s('Your alerts', 'আপনার সতর্কবার্তা'))}`,
      '',
      T.s(
        `This chat is not connected to an alert profile.\nChoose "Connect Telegram" at ${esc(webUrl)}/alert`,
        `এই চ্যাট কোনো সতর্কবার্তা প্রোফাইলের সঙ্গে যুক্ত নয়।\n${esc(webUrl)}/alert থেকে "টেলিগ্রাম সংযুক্ত করুন" বেছে নিন।`,
      ),
    ].join('\n'));
  }
  const lines = [`🔔 ${bold(T.s('Your active alerts', 'আপনার সক্রিয় সতর্কবার্তা'))}`, ''];
  if (!items.length) {
    lines.push(T.s(
      'There is no active AkashSathi alert right now.\nWeather forecast: /update',
      'এখন আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই।\nআবহাওয়ার পূর্বাভাস: /update',
    ));
  } else {
    for (const item of items.slice(0, 5)) {
      const label = SEVERITY_NAMES[T.L][item.severity] ?? item.severity;
      lines.push(`${bold(label)} · ${esc(item.title)}`, `${T.s('Until', 'মেয়াদ')}: ${esc(T.when(+new Date(item.validUntil)))}`, '');
    }
    if (items.length > 5) lines.push(T.s(`…and ${T.n(items.length - 5)} more in the app.`, `…এবং অ্যাপে আরও ${T.n(items.length - 5)}টি।`));
    lines.push(`${T.s('Details', 'বিস্তারিত')}: ${esc(webUrl)}/alert`);
  }
  return fit(lines.join('\n'));
}

// ---------- /status ----------
const STATUS_WORDS = {
  en: { ok: 'current', stale: 'STALE', unavailable: 'unavailable', 'not-checked': 'not loaded yet' },
  bn: { ok: 'হালনাগাদ', stale: 'পুরনো', unavailable: 'পাওয়া যাচ্ছে না', 'not-checked': 'এখনো লোড হয়নি' },
};

export function renderStatus({
  lang, nowMs, statuses, engine = null,
}) {
  const T = makeText(lang, nowMs);
  const lines = [`📊 ${bold(T.s('Data status', 'তথ্যের অবস্থা'))}`, ''];
  for (const [key, source] of [['bmd', 'bmd'], ['openMeteo', 'open-meteo']]) {
    const info = statuses?.[key] ?? null;
    const fresh = freshnessOf(info);
    lines.push(`${fresh.status === 'ok' ? '✅' : '⚠'} ${bold(PROVIDER_LABELS[source][T.L])}: ${esc(STATUS_WORDS[T.L][fresh.status] ?? fresh.status)}`);
    if (fresh.updatedMs) lines.push(T.s(`Updated: ${T.when(fresh.updatedMs)} · ${T.ago(fresh.updatedMs)}`, `হালনাগাদ: ${T.when(fresh.updatedMs)} · ${T.ago(fresh.updatedMs)}`));
    lines.push('');
  }
  if (engine) {
    const last = engine.lastCompletedMs ? T.s(`last run ${T.ago(engine.lastCompletedMs)}`, `সর্বশেষ চালু হয়েছে ${T.ago(engine.lastCompletedMs)}`) : T.s('has not run yet', 'এখনো চালু হয়নি');
    lines.push(`${engine.enabled ? '✅' : '⚠'} ${T.s('Alert engine', 'সতর্কবার্তা ইঞ্জিন')}: ${engine.enabled ? esc(last) : T.s('switched off', 'বন্ধ আছে')}`);
  }
  return fit(lines.join('\n').trimEnd());
}

// ---------- help and place questions ----------
const COMMAND_HELP = {
  en: [
    ['update', 'weather now and the next hours'],
    ['follow', 'follow shared live location for alerts'],
    ['unfollow', 'stop live location following'],
    ['heat', 'heat index and advice'],
    ['rain', 'rain, next 24 hours'],
    ['wind', 'wind and gusts'],
    ['thunderstorm', 'thunderstorm outlook'],
    ['lightning', 'lightning that was recorded'],
    ['forecast', 'the days ahead'],
    ['route', 'weather between two places'],
    ['alerts', 'your active alerts'],
    ['status', 'how fresh the data is'],
  ],
  bn: [
    ['update', 'এখনকার আবহাওয়া ও পরের কয়েক ঘণ্টা'],
    ['follow', 'লাইভ অবস্থান দিয়ে সতর্কবার্তা'],
    ['unfollow', 'অবস্থান অনুসরণ বন্ধ'],
    ['heat', 'হিট ইনডেক্স ও পরামর্শ'],
    ['rain', 'বৃষ্টি, পরবর্তী ২৪ ঘণ্টা'],
    ['wind', 'বাতাস ও দমকা হাওয়া'],
    ['thunderstorm', 'বজ্রঝড়ের পূর্বাভাস'],
    ['lightning', 'রেকর্ড হওয়া বজ্রপাত'],
    ['forecast', 'আগামী দিনগুলো'],
    ['route', 'দুই জায়গার মাঝের আবহাওয়া'],
    ['alerts', 'আপনার সক্রিয় সতর্কবার্তা'],
    ['status', 'তথ্য কতটা নতুন'],
  ],
};

// Menu entries for Telegram's "/" list (name + description, 3-256 characters).
export const commandMenu = (lang) => [...COMMAND_HELP[lang === 'bn' ? 'bn' : 'en'], ['help', lang === 'bn' ? 'সব কমান্ড' : 'all commands'], ['stop', lang === 'bn' ? 'এই চ্যাটে সতর্কবার্তা বন্ধ' : 'stop alerts in this chat']]
  .map(([command, description]) => ({ command, description }));

export function renderHelp(lang, { webUrl = env.channels.publicUrl } = {}) {
  const make = (code) => {
    const T = makeText(code, 0);
    const list = COMMAND_HELP[T.L].map(([name, text]) => `/${name} — ${text}`).join('\n');
    return [
      bold(T.s('AkashSathi · Commands', 'আকাশসাথী · কমান্ড')),
      '',
      list,
      '',
      T.s(
        'Example: /heat Badda\n/route Savar to Chattogram\nNo place name → recent shared area, else saved areas. /update can request a one-time location. /follow requires sharing live location.\nLanguage: add bn or en.',
        'উদাহরণ: /heat বাড্ডা\n/route Savar থেকে Chattogram\nএলাকার নাম না দিলে → সাম্প্রতিক অবস্থান, না থাকলে সংরক্ষিত এলাকা। /update একবারের অবস্থান চাইতে পারে। /follow-এর জন্য লাইভ অবস্থান শেয়ার করুন।\nভাষা: শেষে bn বা en লিখুন।',
      ),
      '',
      T.s(
        `Connect Telegram: ${esc(webUrl)}/alert\n/stop — stop alerts\n/help — all commands`,
        `টেলিগ্রাম সংযুক্ত করুন: ${esc(webUrl)}/alert\n/stop — সতর্কবার্তা বন্ধ\n/help — সব কমান্ড`,
      ),
    ].join('\n');
  };
  return lang === 'bn' || lang === 'en' ? make(lang) : `${make('en')}\n\n${make('bn')}`;
}

export function renderAskPlace(lang) {
  const T = makeText(lang, 0);
  return T.s(
    'Which place?\nExample: /update Badda or /heat Savar, Dhaka\nUse a saved area: /help',
    'কোন জায়গা?\nউদাহরণ: /update বাড্ডা বা /heat Savar, Dhaka\nসংরক্ষিত এলাকা ব্যবহার করতে: /help',
  );
}

export function renderNotFound(lang, query) {
  const T = makeText(lang, 0);
  return T.s(
    `I could not find a place called "${esc(query)}".\nTry an upazila, thana or district, e.g. Badda or Savar, Dhaka.`,
    `"${esc(query)}" নামে কোনো জায়গা পাইনি।\nউপজেলা, থানা বা জেলার নাম দিন, যেমন বাড্ডা বা Savar, Dhaka।`,
  );
}

export function renderRoutePrompt(lang) {
  const T = makeText(lang, 0);
  return T.s('Add both places, for example: /route Savar to Chattogram', 'দুই জায়গার নাম দিন, যেমন: /route Savar থেকে Chattogram');
}

export function renderRoutePlaceError(lang, query, matches = []) {
  const T = makeText(lang, 0);
  const suggestions = matches.map((place) => {
    const parent = parentOf(place);
    const parentName = parent ? (T.L === 'bn' ? parent.nameBn || parent.name : parent.name) : '';
    return parentName ? `${nameOf(place, T.L)}, ${parentName}` : nameOf(place, T.L);
  });
  if (suggestions.length) {
    return T.s(`More than one place matches "${esc(query)}". Add its district: ${suggestions.join('; ')}`, `"${esc(query)}" একাধিক জায়গার সঙ্গে মেলে। জেলার নাম যোগ করুন: ${suggestions.join('; ')}`);
  }
  return T.s(`I could not find "${esc(query)}". Use an upazila, thana or district name.`, `"${esc(query)}" খুঁজে পাইনি। উপজেলা, থানা বা জেলার নাম দিন।`);
}

export function renderRoute(route, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  const { summary } = route;
  const duration = route.durationMinutes < 60
    ? T.s(`${T.n(route.durationMinutes)} min`, `${T.n(route.durationMinutes)} মিনিট`)
    : T.s(`${T.n(Math.floor(route.durationMinutes / 60))} h ${T.n(route.durationMinutes % 60)} min`, `${T.n(Math.floor(route.durationMinutes / 60))} ঘণ্টা ${T.n(route.durationMinutes % 60)} মিনিট`);
  const lines = [
    bold(T.s('Fastest road route · weather summary', 'দ্রুততম সড়কপথ · আবহাওয়ার সারাংশ')),
    `${esc(route.start.name)} → ${esc(route.end.name)} · ${T.n(route.distanceKm, 1)} km · ${duration}`,
    `${T.s('Heat index', 'হিট ইনডেক্স')}: ${T.c(summary.maxHeatIndexC)}`,
    `${T.s('Rain', 'বৃষ্টি')}: ${T.mm(summary.maxRainMm)} · ${T.s('chance', 'সম্ভাবনা')} ${T.pct(summary.maxRainChancePct)}`,
    `${T.s('Strongest wind', 'সর্বোচ্চ বাতাস')}: ${T.kph(summary.maxWindKph)}`,
    `${T.s('Thunderstorm potential', 'বজ্রঝড়ের সম্ভাবনা')}: ${T.n(summary.maxThunderPotential)}/3`,
    T.s(`Forecast coverage: ${T.n(summary.coveredCount)} of ${T.n(summary.sampleCount)} route samples.`, `পূর্বাভাসের আওতা: পথে ${T.n(summary.sampleCount)}টি নমুনার ${T.n(summary.coveredCount)}টি।`),
  ];
  if (summary.rainUnitUnverified) lines.push(`⚠ ${T.s('BMD rain units have not been verified.', 'BMD-এর বৃষ্টির একক যাচাই করা হয়নি।')}`);
  if (summary.forecastStatus !== 'ok') lines.push(`⚠ ${T.s('Some route forecast data is stale or unavailable.', 'পথের কিছু পূর্বাভাস পুরনো বা পাওয়া যাচ্ছে না।')}`);
  lines.push(italic(T.s('Model forecast, not station readings. Conditions between sampled locations may differ.', 'এটি মডেলের পূর্বাভাস, স্টেশনের সরাসরি মাপ নয়। নমুনার মাঝের আবহাওয়া ভিন্ন হতে পারে।')));
  return fit(lines.join('\n'));
}

export function renderAmbiguous(lang, matches, total, command) {
  const T = makeText(lang, 0);
  const lines = [T.s('More than one place matches. Send the name with its district, for example:', 'একাধিক জায়গা মিলেছে। জেলার নামসহ পাঠান, যেমন:')];
  for (const place of matches) {
    const parent = parentOf(place);
    const parentName = parent ? (T.L === 'bn' ? parent.nameBn || parent.name : parent.name) : '';
    const label = place.level === 'district' ? nameOf(place, T.L) : `${nameOf(place, T.L)}, ${parentName}`;
    lines.push(`/${command} ${esc(label)}  (${esc(KIND_NAMES[T.L][place.kind])})`);
  }
  if (total > matches.length) lines.push(T.s(`…and ${T.n(total - matches.length)} more.`, `…এবং আরও ${T.n(total - matches.length)}টি।`));
  return lines.join('\n');
}

export const renderBusy = (lang) => makeText(lang, 0).s(
  'You are sending requests very quickly. Please wait a few minutes and try again.',
  'আপনি খুব দ্রুত অনুরোধ পাঠাচ্ছেন। কয়েক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
);

export const renderError = (lang) => makeText(lang, 0).s(
  'Something went wrong while preparing that. Please try again in a moment.',
  'এটি তৈরি করতে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।',
);

// ---------- the morning message ----------
// What the bot sends by itself every morning to a connected chat: today's weather at the saved area, every figure the commands show,
// in one block. The facts and the honesty rules are the commands' (a forecast, never a measurement; missing is never zero; no "safe").
const WEEKDAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  bn: ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'],
};
const PART_NAMES = {
  en: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' },
  bn: { morning: 'সকাল', afternoon: 'দুপুর ও বিকাল', evening: 'সন্ধ্যা ও রাত' },
};

// The most severe weather code among some steps (WMO codes grow with severity), or null when none of them has one.
function worstCode(codes, indexes) {
  const values = indexes.map((k) => codes?.[k]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

export function renderMorning(f, { lang, nowMs, lightning = undefined, alertCount = null }) {
  const T = makeText(lang, nowMs);
  const rest = f.available ? todayIdx(f) : [];
  if (!rest.length) return unavailable(f, f.place, T, T.s("Today's forecast", 'আজকের পূর্বাভাস'));

  const { cols } = f;
  const span = (ms) => `${T.hm(ms)}–${T.hm(ms + STEP_MS)}`;
  const shifted = new Date(nowMs + DHAKA_OFFSET_MS);
  const dateText = `${WEEKDAYS[T.L][shifted.getUTCDay()]}, ${T.n(shifted.getUTCDate())} ${(T.L === 'bn' ? BN_MONTHS : EN_MONTHS)[shifted.getUTCMonth()]}`;
  const lines = reportHeader(f.place, T, '🌅', 'Good morning · Today’s weather', 'শুভ সকাল · আজকের আবহাওয়া', [f.coreInfo, f.rain.info, ...(f.thunder.values ? [f.thunder.info] : [])]);
  lines.splice(1, 0, esc(dateText));

  // The day at a glance: the worst condition still ahead and the day's own lowest and highest temperature.
  const whole = todayIdx(f, { whole: true });
  const low = lowOf(cols.temp, whole);
  const high = peakOf(cols.temp, whole);
  const code = worstCode(cols.wmo, rest);
  const label = CONDITION[T.L][code] ?? null;
  const range = low && high ? `${T.n(low.value)}–${T.n(high.value)} ${T.s('°C', '°সে.')}` : '–';
  lines.push(`${code === null ? '🌡' : conditionEmoji(code)} ${label ? `${esc(label)} · ` : ''}${bold(range)}`);
  if (alertCount !== null) {
    lines.push(alertCount > 0
      ? `🔔 ${T.s(`${T.n(alertCount)} active alert${alertCount === 1 ? '' : 's'} · send /alerts`, `${T.n(alertCount)}টি সক্রিয় সতর্কবার্তা · /alerts পাঠান`)}`
      : `🔔 ${T.s('No active AkashSathi alert.', 'আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই।')}`);
  }

  // Heat
  lines.push('', `🌡 ${bold(T.s('Heat', 'গরম'))}`);
  const hi = peakOf(cols.hi, rest);
  const hottest = peakOf(cols.temp, rest);
  if (hi) {
    const level = heatCategory(hi.value);
    lines.push(`${T.s('Peak heat index', 'সর্বোচ্চ হিট ইনডেক্স')} ${T.c(hi.value)} · ${esc(heatName(level, T))} · ${span(f.steps[hi.index])}`);
    if (level >= 1) lines.push(esc(HEAT_ADVICE[T.L][level]));
  } else if (hottest) {
    lines.push(T.s(`The heat index is not available. Hottest: ${T.c(hottest.value, 1)} · ${span(f.steps[hottest.index])}`, `হিট ইনডেক্স পাওয়া যাচ্ছে না। সবচেয়ে গরম: ${T.c(hottest.value, 1)} · ${span(f.steps[hottest.index])}`));
  } else {
    lines.push(T.s('Heat information is not available.', 'গরমের তথ্য পাওয়া যাচ্ছে না।'));
  }

  // Rain
  lines.push('', `🌧 ${bold(T.s('Rain', 'বৃষ্টি'))}`);
  const { total, partial } = f.rain.values ? sumOf(f.rain.values, rest) : { total: null, partial: true };
  if (total === null) {
    lines.push(T.s('The rain forecast is not available.', 'বৃষ্টির পূর্বাভাস পাওয়া যাচ্ছে না।'));
  } else {
    const chance = peakOf(cols.pop, rest);
    const amount = `${partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(total)}`;
    lines.push(total < 0.1
      ? T.s('Almost no rain in the forecast.', 'পূর্বাভাসে প্রায় কোনো বৃষ্টি নেই।')
      : `${T.s('Today', 'আজ')} ${amount}${chance ? ` · ${T.s('chance up to', 'সম্ভাবনা সর্বোচ্চ')} ${T.pct(chance.value)}` : ''}`);
    const wettest = peakOf(f.rain.values, rest);
    if (wettest && wettest.value >= 0.1) {
      lines.push(`${T.s('Wettest 3 h', 'সর্বোচ্চ বৃষ্টি (৩ ঘণ্টা)')} ${T.mm(wettest.value)} · ${span(f.steps[wettest.index])} (${esc(RAIN_NAMES[T.L][rainClass(wettest.value)])})`);
    }
  }

  // Wind
  lines.push('', `💨 ${bold(T.s('Wind', 'বাতাস'))}`);
  const gust = cols.wg ? peakOf(cols.wg, rest) : null;
  if (gust) {
    lines.push(`${T.s('Peak gust', 'সর্বোচ্চ দমকা হাওয়া')} ${T.kph(gust.value)} · ${span(f.steps[gust.index])} · ${esc(GUST_NAMES[T.L][gustClass(gust.value)])}`);
    if (gust.value >= 40) lines.push(T.s('Secure loose objects; take care on boats and roofs.', 'আলগা জিনিস বেঁধে রাখুন; নৌকা ও ছাদে সতর্ক থাকুন।'));
  } else {
    lines.push(T.s('The wind forecast is not available.', 'বাতাসের পূর্বাভাস পাওয়া যাচ্ছে না।'));
  }

  // Thunderstorm and lightning
  lines.push('', `⛈ ${bold(T.s('Thunderstorm', 'বজ্রঝড়'))}`);
  const storm = f.thunder.values ? peakOf(f.thunder.values, rest) : null;
  if (storm) {
    lines.push(`${T.s('Peak potential', 'সর্বোচ্চ সম্ভাবনা')}: ${esc(thunderName(storm.value, T))}${storm.value >= 1 ? ` · ${span(f.steps[storm.index])}` : ''}`);
    const stormSteps = rest.filter((k) => isThunderCode(cols.wmo?.[k]));
    if (stormSteps.length) {
      const hail = stormSteps.some((k) => hasHailCode(cols.wmo[k]));
      lines.push(T.s(`Thunderstorm forecast${hail ? ' with hail' : ''}.`, `বজ্রসহ বৃষ্টির পূর্বাভাস${hail ? ', শিলাবৃষ্টিসহ' : ''}।`));
    }
    if (storm.value >= 1 || stormSteps.length) lines.push(T.s('If you hear thunder, go indoors; avoid isolated trees and open water.', 'বজ্রের শব্দ শুনলে ঘরে যান; একা গাছ ও খোলা জলাশয় এড়িয়ে চলুন।'));
  } else {
    lines.push(T.s('The thunderstorm outlook is not available.', 'বজ্রঝড়ের পূর্বাভাস পাওয়া যাচ্ছে না।'));
  }
  if (lightning !== undefined) lines.push(`⚡ ${esc(lightningShort(lightning, T))}`);

  // Through the day: the parts of today that are still ahead.
  const parts = dayParts(f, rest);
  if (parts.length > 1) {
    lines.push('', bold(T.s('Through the day', 'দিনের বিভিন্ন সময়')));
    for (const part of parts) {
      const partLow = lowOf(cols.temp, part.indexes);
      const partHigh = peakOf(cols.temp, part.indexes);
      const partRain = f.rain.values ? sumOf(f.rain.values, part.indexes) : { total: null, partial: true };
      const partCode = worstCode(cols.wmo, part.indexes);
      const temps = partLow && partHigh ? `${T.n(partLow.value)}–${T.n(partHigh.value)} ${T.s('°C', '°সে.')}` : '–';
      const rain = partRain.total === null ? '–' : `${partRain.partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(partRain.total)}`;
      lines.push(`${partCode === null ? '•' : conditionEmoji(partCode)} ${bold(PART_NAMES[T.L][part.key])} · ${temps} · ${T.s('rain', 'বৃষ্টি')} ${rain}`);
    }
  }

  // Tomorrow, in one line.
  const tomorrow = dailySummaries(f).find((day) => day.date === addDays(dhakaDate(new Date(nowMs)), 1));
  if (tomorrow) {
    const bits = [`${T.n(tomorrow.low)}–${T.n(tomorrow.high)} ${T.s('°C', '°সে.')}`];
    bits.push(tomorrow.rain.total === null ? T.s('rain not available', 'বৃষ্টির তথ্য নেই') : `${T.s('rain', 'বৃষ্টি')} ${tomorrow.rain.partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(tomorrow.rain.total)}`);
    if (Number.isFinite(tomorrow.pop)) bits.push(`${T.s('chance', 'সম্ভাবনা')} ${T.pct(tomorrow.pop)}`);
    if ((tomorrow.thunder ?? 0) >= 1) bits.push(`${T.s('thunder', 'বজ্রঝড়')}: ${thunderName(tomorrow.thunder, T)}`);
    lines.push('', `📅 ${bold(T.s('Tomorrow', 'আগামীকাল'))} · ${bits.map(esc).join(' · ')}`);
  }

  const updated = freshnessOf(f.coreInfo).updatedMs;
  lines.push('', italic(`${T.s('Model forecast, not a station reading', 'মডেল পূর্বাভাস, কোনো কেন্দ্রের পরিমাপ নয়')}${updated ? ` · ${T.s('updated', 'হালনাগাদ')} ${T.when(updated)}` : ''}`));
  if (rainNote(f, T)) lines.push(rainNote(f, T));
  return fit(lines.join('\n'));
}
