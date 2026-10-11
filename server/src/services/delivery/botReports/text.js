import { env } from '../../../config/env.js';
import {
  PROVIDER_LABELS, dayWord, localizeDigits, whenText,
} from '../../alerts/messages.js';
import { formatHm } from '../../time.js';
import { parentOf } from './places.js';
import {
  COMPASS, STEP_MS, compassIndex, dailySummaries, freshnessOf, gustClass, hasHailCode, heatCategory, isThunderCode, laterIdx, peakOf, rainClass, sumOf,
  windowIdx,
} from './readings.js';

// The words of the bot's weather replies, in English and Bangla. The Bangla is a draft that still needs a fluent reader (BN_REVIEWED).
// Style rules are the alert rules (alerts/messages.js DISCOURAGED_PHRASES, enforced by test): never "safe", never "all clear", never a
// forecast described as a measurement, never zero for a missing value. Replies are HTML for Telegram; every dynamic string is escaped.
const MAX_LENGTH = 3800;
const MAX_LINES = 9;

export const COMMAND_NAMES = ['update', 'heat', 'rain', 'wind', 'thunderstorm', 'lightning', 'forecast', 'alerts', 'status'];

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
    'Fatigue is possible with long exposure or activity. Drink water regularly and take breaks in the shade.',
    'Heat cramps and heat exhaustion are possible with long exposure or activity. Drink water often, rest in the shade and avoid the hottest hours for hard work.',
    'Heat exhaustion is likely and heat stroke is possible with long exposure or activity. Limit outdoor work, drink water often and rest in the shade.',
    'Heat stroke is highly likely with continued exposure. Avoid outdoor activity during these hours.',
  ],
  bn: [
    'পরবর্তী ২৪ ঘণ্টায় পূর্বাভাসের হিট ইনডেক্স সতর্ক-স্তরের (২৭ °সে.) নিচে থাকবে।',
    'দীর্ঘক্ষণ রোদে থাকলে বা পরিশ্রম করলে ক্লান্তি হতে পারে। নিয়মিত পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
    'দীর্ঘক্ষণ রোদে থাকলে বা পরিশ্রম করলে পেশিতে টান ও গরমজনিত অবসাদ হতে পারে। ঘন ঘন পানি পান করুন, ছায়ায় বিশ্রাম নিন এবং সবচেয়ে গরম সময়ে ভারী কাজ এড়িয়ে চলুন।',
    'দীর্ঘক্ষণ রোদে থাকলে বা পরিশ্রম করলে গরমজনিত অবসাদের সম্ভাবনা বেশি এবং হিটস্ট্রোক হতে পারে। বাইরের কাজ কমান, ঘন ঘন পানি পান করুন এবং ছায়ায় বিশ্রাম নিন।',
    'রোদে থাকা চালিয়ে গেলে হিটস্ট্রোকের আশঙ্কা অত্যন্ত বেশি। এই সময়গুলোতে বাইরের কাজ এড়িয়ে চলুন।',
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
  const where = place.level === 'district' ? kind : [kind, parentName ? T.s(`${parentName} district`, `${parentName} জেলা`) : null].filter(Boolean).join(', ');
  return `${bold(nameOf(place, T.L))} · ${esc(where)}`;
}

function placeNote(place, T) {
  if (place.level === 'district') {
    return T.s(
      'District figures: temperature and humidity are the average of its upazilas; heat, rain and gusts show the highest upazila.',
      'জেলার হিসাব: তাপমাত্রা ও আর্দ্রতা উপজেলাগুলোর গড়; গরম, বৃষ্টি ও দমকা হাওয়ায় সবচেয়ে বেশি মান থাকা উপজেলাটি দেখানো হয়েছে।',
    );
  }
  if (place.level === 'polygon') {
    return (place.members?.length ?? 0) > 1 && !place.approx
      ? T.s(`${nameOf(place, T.L)} is shown as the average of its BMD thanas.`, `${nameOf(place, T.L)} তার বিএমডি থানাগুলোর গড় হিসেবে দেখানো হয়েছে।`)
      : T.s(`BMD has no separate forecast for ${nameOf(place, T.L)}; this uses the nearest BMD location.`, `${nameOf(place, T.L)}-এর জন্য বিএমডির আলাদা পূর্বাভাস নেই; এখানে নিকটতম বিএমডি অবস্থানের পূর্বাভাস দেখানো হয়েছে।`);
  }
  return null;
}

// ---------- shared lines ----------
const DISCLAIMER = (T) => T.s(
  'Prototype information, not an official warning service. Official warnings: bmd.gov.bd.',
  'পরীক্ষামূলক তথ্য, সরকারি সতর্কীকরণ সেবা নয়। সরকারি সতর্কবার্তার জন্য bmd.gov.bd দেখুন।',
);

function sourceLine(T, source, info, { label = 'Source' } = {}) {
  const fresh = freshnessOf(info);
  const name = PROVIDER_LABELS[source][T.L];
  const parts = [`${T.s(label, 'সূত্র')}: ${name}`, T.s('model forecast, not a station reading', 'মডেল পূর্বাভাস, কোনো কেন্দ্রের পরিমাপ নয়')];
  if (fresh.updatedMs) parts.push(T.s(`updated ${T.when(fresh.updatedMs)}`, `হালনাগাদ ${T.when(fresh.updatedMs)}`));
  let line = italic(parts.join(' · '));
  if (fresh.status === 'stale') {
    line += `\n⚠ ${T.s(
      `Stale data${fresh.updatedMs ? `: last updated ${T.when(fresh.updatedMs)}` : ''}. Treat it with caution.`,
      `পুরনো তথ্য${fresh.updatedMs ? `: সর্বশেষ হালনাগাদ ${T.when(fresh.updatedMs)}` : ''}। সতর্কতার সঙ্গে ব্যবহার করুন।`,
    )}`;
  } else if (fresh.status !== 'ok') {
    line += `\n⚠ ${T.s('This source is not available right now.', 'এই সূত্র এখন পাওয়া যাচ্ছে না।')}`;
  }
  return line;
}

const closing = (T, lines) => [...lines.filter(Boolean), italic(DISCLAIMER(T))].join('\n');

function unavailable(f, place, T, what) {
  return fit([
    placeTitle(place, T),
    '',
    T.s(
      `${what} is not available for this place right now. Missing data does not mean calm weather.`,
      `এই জায়গার জন্য ${what} এখন পাওয়া যাচ্ছে না। তথ্য না থাকার অর্থ আবহাওয়া শান্ত থাকা নয়।`,
    ),
    '',
    italic(DISCLAIMER(T)),
  ].join('\n'));
}

const heatName = (level, T) => HEAT_NAMES[T.L][level];
const thunderName = (level, T) => THUNDER_NAMES[T.L][Math.min(Math.max(level ?? 0, 0), 3)];
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

  const lines = [`📍 ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('');

  const i = f.nowIdx;
  const { cols } = f;
  if (i >= 0) {
    const code = cols.wmo?.[i] ?? null;
    const label = CONDITION[T.L][code] ?? null;
    lines.push(`${T.s('Now', 'এখন')} · ${T.range(f.steps[i])}`);
    lines.push(`${conditionEmoji(code)} ${label ? `${esc(label)} · ` : ''}${bold(T.c(cols.temp[i], 1))}`);
    const hiLevel = heatCategory(cols.hi?.[i]);
    lines.push(`${T.s('Heat index', 'হিট ইনডেক্স')} ${T.c(cols.hi?.[i], 0)}${hiLevel === null ? '' : ` (${esc(heatName(hiLevel, T))})`}`);
    const chance = Number.isFinite(f.cols.pop?.[i]) ? ` · ${T.s('chance of rain', 'বৃষ্টির সম্ভাবনা')} ${T.pct(f.cols.pop[i])}` : '';
    lines.push(`${T.s('Rain', 'বৃষ্টি')} ${T.mm(f.rain.values?.[i])} ${T.s('in 3 h', '৩ ঘণ্টায়')}${chance}`);
    lines.push(`${T.s('Humidity', 'আর্দ্রতা')} ${T.pct(cols.rh?.[i])} · ${T.s('Wind', 'বাতাস')} ${T.kph(cols.ws?.[i])}${esc(windFrom(cols.wd?.[i], T))}, ${T.s('gusts up to', 'দমকা হাওয়া সর্বোচ্চ')} ${T.kph(cols.wg?.[i])}`);
    if (f.thunder.values) lines.push(`${T.s('Thunderstorm potential', 'বজ্রঝড়ের সম্ভাবনা')}: ${esc(thunderName(f.thunder.values[i], T))}`);
  } else {
    lines.push(T.s('The stored forecast does not cover the current time.', 'সংরক্ষিত পূর্বাভাস বর্তমান সময়কে ধরে না।'));
  }

  const later = laterIdx(f, 12).slice(0, 4);
  if (later.length) {
    lines.push('', bold(T.s('Next 12 hours', 'পরবর্তী ১২ ঘণ্টা')));
    for (const k of later) {
      const parts = [T.when(f.steps[k]), `${T.n(cols.temp[k])}°`, T.mm(f.rain.values?.[k]), `${T.s('gust', 'দমকা')} ${T.n(cols.wg?.[k])}`];
      if ((f.thunder.values?.[k] ?? 0) >= 1) parts.push(`${T.s('thunder', 'বজ্রঝড়')} ${thunderName(f.thunder.values[k], T)}`);
      lines.push(parts.map(esc).join(' · '));
    }
  }

  if (lightning !== undefined) lines.push('', `⚡ ${esc(lightningShort(lightning, T))}`);
  if (alertCount !== null) {
    lines.push(alertCount > 0
      ? `🔔 ${T.s(`${T.n(alertCount)} active alert${alertCount === 1 ? '' : 's'} · send /alerts`, `${T.n(alertCount)}টি সক্রিয় সতর্কবার্তা · /alerts পাঠান`)}`
      : `🔔 ${T.s('No active AkashSathi alert for your saved area. That does not mean calm weather.', 'আপনার সংরক্ষিত এলাকায় আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই। এর মানে আবহাওয়া শান্ত থাকা নয়।')}`);
  }

  const extraSource = f.coreSource !== 'open-meteo' && (f.thunder.values || f.rain.source === 'open-meteo')
    ? sourceLine(T, 'open-meteo', f.thunder.info, { label: f.rain.source === 'open-meteo' ? 'Rain amounts, rain chance and thunder' : 'Rain chance and thunder' })
    : null;
  const rainCaveat = f.rain.unverified ? italic(T.s('Rain amounts are BMD values as published; their unit has not been independently confirmed.', 'বৃষ্টির পরিমাণ বিএমডির প্রকাশিত মান; এর একক এখনো স্বাধীনভাবে নিশ্চিত করা হয়নি।')) : null;
  lines.push('', closing(T, [rainCaveat, sourceLine(T, f.coreSource, f.coreInfo), extraSource]));
  return fit(lines.join('\n'));
}

// ---------- /heat ----------
export function renderHeat(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available) return unavailable(f, f.place, T, T.s('Heat information', 'গরমের তথ্য'));
  const { cols } = f;
  const win = windowIdx(f, 24).slice(0, MAX_LINES);
  const peak = peakOf(cols.hi, win);
  const hottest = peakOf(cols.temp, win);
  if (!peak && !hottest) return unavailable(f, f.place, T, T.s('Heat information', 'গরমের তথ্য'));

  const lines = [`🌡 ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('');

  const i = f.nowIdx;
  if (i >= 0) {
    const level = heatCategory(cols.hi?.[i]);
    lines.push(`${bold(T.s('Now', 'এখন'))} (${T.range(f.steps[i])}): ${T.s('temperature', 'তাপমাত্রা')} ${T.c(cols.temp[i], 1)} · ${T.s('heat index', 'হিট ইনডেক্স')} ${T.c(cols.hi?.[i])}${level === null ? '' : ` — ${esc(heatName(level, T))}`}`);
  }
  if (peak) {
    const level = heatCategory(peak.value);
    lines.push(`${bold(T.s('Highest in the next 24 hours', 'পরবর্তী ২৪ ঘণ্টায় সর্বোচ্চ'))}: ${T.s('heat index', 'হিট ইনডেক্স')} ${T.c(peak.value)} (${esc(heatName(level, T))}) ${T.s('around', 'প্রায়')} ${T.range(f.steps[peak.index])}${hottest ? `; ${T.s('temperature up to', 'তাপমাত্রা সর্বোচ্চ')} ${T.c(hottest.value, 1)}` : ''}`);
    lines.push('', esc(HEAT_ADVICE[T.L][level]));
    lines.push('', bold(T.s('Heat index by time', 'সময় অনুযায়ী হিট ইনডেক্স')));
    for (const k of win) {
      const level2 = heatCategory(cols.hi?.[k]);
      lines.push(`${esc(T.when(f.steps[k]))} · ${T.n(cols.hi?.[k])}°${level2 ? ` (${esc(heatName(level2, T))})` : ''} · ${T.n(cols.temp[k], 1)}°`);
    }
  } else {
    lines.push(T.s('The heat index is not available; only the temperature is.', 'হিট ইনডেক্স পাওয়া যাচ্ছে না; শুধু তাপমাত্রা আছে।'));
  }
  lines.push('', italic(T.s(
    'The heat index is computed from temperature and humidity (NWS). It is not a measured value or a WBGT reading. Alerts matched to your work arrive automatically.',
    'হিট ইনডেক্স তাপমাত্রা ও আর্দ্রতা থেকে হিসাব করা (এনডব্লিউএস)। এটি পরিমাপ করা মান বা ডব্লিউবিজিটি নয়। আপনার কাজ অনুযায়ী সতর্কবার্তা নিজে থেকেই আসবে।',
  )));
  lines.push('', closing(T, [sourceLine(T, f.coreSource, f.coreInfo)]));
  return fit(lines.join('\n'));
}

// ---------- /rain ----------
export function renderRain(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available || !f.rain.values) return unavailable(f, f.place, T, T.s('The rain forecast', 'বৃষ্টির পূর্বাভাস'));
  const win = windowIdx(f, 24).slice(0, MAX_LINES);
  const { total, partial } = sumOf(f.rain.values, win);
  if (total === null) return unavailable(f, f.place, T, T.s('The rain forecast', 'বৃষ্টির পূর্বাভাস'));

  const lines = [`🌧 ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('', bold(T.s('Next 24 hours, in 3-hour steps', 'পরবর্তী ২৪ ঘণ্টা, ৩ ঘণ্টা করে')));
  for (const k of win) {
    const amount = f.rain.values[k];
    const klass = rainClass(amount);
    const chance = Number.isFinite(f.cols.pop?.[k]) ? ` · ${T.s('chance', 'সম্ভাবনা')} ${T.pct(f.cols.pop[k])}` : '';
    lines.push(`${esc(T.range(f.steps[k]))} · ${T.mm(amount)}${klass ? ` (${esc(RAIN_NAMES[T.L][klass])})` : ''}${chance}`);
  }
  lines.push('', `${bold(T.s('Total', 'মোট'))}: ${partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(total)}`);
  const wettest = peakOf(f.rain.values, win);
  if (wettest && wettest.value >= 0.1) lines.push(`${bold(T.s('Wettest step', 'সবচেয়ে বেশি বৃষ্টির ধাপ'))}: ${T.mm(wettest.value)} ${T.s('around', 'প্রায়')} ${T.range(f.steps[wettest.index])}`);
  if (total < 0.1) lines.push(T.s('The forecast shows almost no rain in this period. Local showers can be missed by a model.', 'এই সময়ে পূর্বাভাসে প্রায় কোনো বৃষ্টি নেই। মডেল স্থানীয় বৃষ্টির ঝাপটা ধরতে না-ও পারে।'));
  lines.push('', italic(f.rain.unverified
    ? T.s('Rain amounts are BMD values as published; their unit has not been independently confirmed.', 'বৃষ্টির পরিমাণ বিএমডির প্রকাশিত মান; এর একক এখনো স্বাধীনভাবে নিশ্চিত করা হয়নি।')
    : T.s('Rain amounts are millimetres per 3-hour step; the class names follow the alert rules.', 'বৃষ্টির পরিমাণ প্রতি ৩ ঘণ্টায় মিলিমিটারে; শ্রেণির নামগুলো সতর্কবার্তার নিয়ম অনুযায়ী।')));
  lines.push('', closing(T, [sourceLine(T, f.rain.source, f.rain.info, { label: 'Rain source' })]));
  return fit(lines.join('\n'));
}

// ---------- /wind ----------
export function renderWind(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available || !f.cols.wg) return unavailable(f, f.place, T, T.s('The wind forecast', 'বাতাসের পূর্বাভাস'));
  const { cols } = f;
  const win = windowIdx(f, 24).slice(0, MAX_LINES);
  const peak = peakOf(cols.wg, win);
  if (!peak) return unavailable(f, f.place, T, T.s('The wind forecast', 'বাতাসের পূর্বাভাস'));

  const lines = [`💨 ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('');
  const i = f.nowIdx;
  if (i >= 0) lines.push(`${bold(T.s('Now', 'এখন'))} (${T.range(f.steps[i])}): ${T.kph(cols.ws?.[i])}${esc(windFrom(cols.wd?.[i], T))}, ${T.s('gusts up to', 'দমকা হাওয়া সর্বোচ্চ')} ${T.kph(cols.wg[i])}`);
  const klass = gustClass(peak.value);
  lines.push(`${bold(T.s('Strongest gust in the next 24 hours', 'পরবর্তী ২৪ ঘণ্টায় সবচেয়ে জোরালো দমকা হাওয়া'))}: ${T.kph(peak.value)} (${esc(GUST_NAMES[T.L][klass])}) ${T.s('around', 'প্রায়')} ${T.range(f.steps[peak.index])}`);
  lines.push('', bold(T.s('By time', 'সময় অনুযায়ী')));
  for (const k of win) {
    lines.push(`${esc(T.when(f.steps[k]))} · ${T.kph(cols.ws?.[k])}${esc(windFrom(cols.wd?.[k], T))} · ${T.s('gust', 'দমকা')} ${T.kph(cols.wg?.[k])}`);
  }
  if (peak.value >= 40) lines.push('', T.s('Strong gusts can bring down branches and loose objects. Take extra care on boats, roofs and open ground.', 'প্রবল দমকা হাওয়ায় ডালপালা ও আলগা জিনিস ভেঙে পড়তে পারে। নৌকা, ছাদ ও খোলা জায়গায় বাড়তি সতর্ক থাকুন।'));
  lines.push('', closing(T, [sourceLine(T, f.coreSource, f.coreInfo)]));
  return fit(lines.join('\n'));
}

// ---------- /thunderstorm ----------
export function renderThunderstorm(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  const values = f.available ? f.thunder.values : null;
  if (!f.available || !values) return unavailable(f, f.place, T, T.s('The thunderstorm outlook', 'বজ্রঝড়ের পূর্বাভাস'));
  const win = windowIdx(f, 24).slice(0, MAX_LINES);
  const peak = peakOf(values, win);
  if (!peak) return unavailable(f, f.place, T, T.s('The thunderstorm outlook', 'বজ্রঝড়ের পূর্বাভাস'));

  const lines = [`⛈ ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('', bold(T.s('Thunderstorm potential, next 24 hours', 'বজ্রঝড়ের সম্ভাবনা, পরবর্তী ২৪ ঘণ্টা')));
  for (const k of win) {
    const chance = Number.isFinite(f.cols.pop?.[k]) ? ` · ${T.s('chance of rain', 'বৃষ্টির সম্ভাবনা')} ${T.pct(f.cols.pop[k])}` : '';
    lines.push(`${esc(T.range(f.steps[k]))} · ${esc(thunderName(values[k], T))}${chance}`);
  }

  if (peak.value >= 1) {
    const gust = f.cols.wg?.[peak.index];
    lines.push('', `${bold(T.s('Highest', 'সর্বোচ্চ'))}: ${esc(thunderName(peak.value, T))} ${T.s('around', 'প্রায়')} ${T.range(f.steps[peak.index])}${Number.isFinite(gust) ? ` (${T.s('gusts up to', 'দমকা হাওয়া সর্বোচ্চ')} ${T.kph(gust)})` : ''}`);
  } else {
    lines.push('', T.s('The model shows no thunderstorm potential in this period. A model can miss local storms.', 'এই সময়ে মডেলে বজ্রঝড়ের সম্ভাবনা দেখা যাচ্ছে না। মডেল স্থানীয় ঝড় ধরতে না-ও পারে।'));
  }

  const codes = f.cols.wmo;
  const stormSteps = win.filter((k) => isThunderCode(codes?.[k]));
  if (stormSteps.length) {
    const hail = stormSteps.some((k) => hasHailCode(codes[k]));
    lines.push(`${T.s('The model forecasts a thunderstorm', 'মডেল বজ্রসহ বৃষ্টির পূর্বাভাস দিচ্ছে')}: ${stormSteps.map((k) => T.range(f.steps[k])).map(esc).join('; ')}${hail ? ` — ${T.s('with hail', 'শিলাবৃষ্টিসহ')}` : ''}${T.s('.', '।')}`);
  }

  lines.push('', T.s(
    'If you hear thunder, go into a building or a hard-topped vehicle. Do not shelter under an isolated tree and stay away from open water.',
    'বজ্রের শব্দ শুনলে দালান বা শক্ত ছাদের গাড়ির ভেতরে যান। একা দাঁড়ানো গাছের নিচে আশ্রয় নেবেন না এবং খোলা জলাশয় থেকে দূরে থাকুন।',
  ));
  lines.push('', italic(T.s(
    'This is a model outlook of storm potential, not a lightning detection. Send /lightning for what was recorded.',
    'এটি ঝড়ের সম্ভাবনার মডেল পূর্বাভাস, বজ্রপাত শনাক্তকরণ নয়। কী রেকর্ড হয়েছে জানতে /lightning পাঠান।',
  )));
  lines.push('', closing(T, [sourceLine(T, 'open-meteo', f.thunder.info)]));
  return fit(lines.join('\n'));
}

// ---------- /lightning ----------
// `lightning` is { pick, error }: pick is the check most worth showing (readings.chooseLightning) or null.
function lightningLines(lightning, T, { short = false } = {}) {
  const pick = lightning?.pick ?? null;
  if (!pick) {
    if (lightning?.error) return T.s('Lightning data could not be read right now.', 'বজ্রপাতের তথ্য এখন পড়া যাচ্ছে না।');
    return T.s(
      'No lightning check covers this place yet. Lightning data is shown for a specific upazila or city thana: try /lightning Savar.',
      'এই জায়গার জন্য এখনো কোনো বজ্রপাত পরীক্ষা নেই। বজ্রপাতের তথ্য নির্দিষ্ট উপজেলা বা সিটি থানার জন্য দেখানো হয়: /lightning Savar চেষ্টা করুন।',
    );
  }
  const at = T.when(pick.sampledMs);
  const r = T.n(pick.radiusKm);
  const area = T.s(`within the ${r} km search area`, `${r} কিমি অনুসন্ধান এলাকার মধ্যে`);
  switch (pick.kind) {
    case 'reported': {
      const count = Number.isFinite(pick.count) ? T.s(`${T.n(pick.count)} strike${pick.count === 1 ? '' : 's'} in the 5 minutes before it`, `তার আগের ৫ মিনিটে ${T.n(pick.count)}টি বজ্রপাত`) : T.s('the number was not reported', 'সংখ্যা জানানো হয়নি');
      return short
        ? T.s(`Last lightning check (${at}): lightning recorded ${area}.`, `সর্বশেষ বজ্রপাত পরীক্ষা (${at}): ${area} বজ্রপাত রেকর্ড হয়েছে।`)
        : T.s(`Lightning was recorded ${area} at the last check (${at}): ${count}.`, `সর্বশেষ পরীক্ষায় (${at}) ${area} বজ্রপাত রেকর্ড হয়েছে: ${count}।`);
    }
    case 'none':
      return short
        ? T.s(`Last lightning check (${at}): none recorded ${area}. Checks are not continuous.`, `সর্বশেষ বজ্রপাত পরীক্ষা (${at}): ${area} কিছু রেকর্ড হয়নি। পরীক্ষা সারাক্ষণ চলে না।`)
        : T.s(
          `No lightning was recorded ${area} at the last check (${at}). A check covers only the 5 minutes before it and checks are not continuous, so this does not show that lightning is not happening.`,
          `সর্বশেষ পরীক্ষায় (${at}) ${area} কোনো বজ্রপাত রেকর্ড হয়নি। প্রতিটি পরীক্ষা তার আগের মাত্র ৫ মিনিট দেখে এবং পরীক্ষা সারাক্ষণ চলে না, তাই এটি প্রমাণ করে না যে বজ্রপাত হচ্ছে না।`,
        );
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
  const lines = [`⚡ ${placeTitle(target, T)}`, '', esc(lightningLines(lightning, T))];
  if (f.available && f.thunder?.values) {
    const peak = peakOf(f.thunder.values, windowIdx(f, 12));
    if (peak && peak.value >= 1) lines.push('', T.s(`Forecast thunderstorm potential in the next 12 hours: ${thunderName(peak.value, T)}. Send /thunderstorm for the outlook.`, `পরবর্তী ১২ ঘণ্টায় বজ্রঝড়ের পূর্বাভাসিত সম্ভাবনা: ${thunderName(peak.value, T)}। বিস্তারিত জানতে /thunderstorm পাঠান।`));
  }
  lines.push('', italic(T.s(
    'Lightning checks come from Xweather and only look at the few minutes before each check. A storm between checks can be missed. If you hear thunder, go indoors.',
    'বজ্রপাতের পরীক্ষা Xweather থেকে আসে এবং প্রতিটি পরীক্ষার আগের কয়েক মিনিট দেখে। দুই পরীক্ষার মাঝের ঝড় ধরা না-ও পড়তে পারে। বজ্রের শব্দ শুনলে ঘরে যান।',
  )));
  lines.push('', closing(T, []));
  return fit(lines.join('\n'));
}

// ---------- /forecast ----------
export function renderForecast(f, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  if (!f.available) return unavailable(f, f.place, T, T.s('The forecast', 'পূর্বাভাস'));
  const days = dailySummaries(f);
  if (!days.length) return unavailable(f, f.place, T, T.s('The daily forecast', 'দৈনিক পূর্বাভাস'));

  const lines = [`📅 ${placeTitle(f.place, T)}`];
  const note = placeNote(f.place, T);
  if (note) lines.push(italic(note));
  lines.push('', bold(T.s('The days ahead', 'আগামী দিনগুলো')));
  for (const day of days) {
    const parts = [
      `${esc(T.day(day.startMs))}: ${T.n(day.low)}–${T.n(day.high)} ${T.s('°C', '°সে.')}`,
      day.rain.total === null ? T.s('rain not available', 'বৃষ্টির তথ্য নেই') : `${T.s('rain', 'বৃষ্টি')} ${day.rain.partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(day.rain.total)}`,
      `${T.s('gusts up to', 'দমকা হাওয়া সর্বোচ্চ')} ${T.kph(day.gust)}`,
    ];
    if (Number.isFinite(day.pop)) parts.push(`${T.s('chance of rain', 'বৃষ্টির সম্ভাবনা')} ${T.pct(day.pop)}`);
    if ((day.thunder ?? 0) >= 1) parts.push(`${T.s('thunder', 'বজ্রঝড়')}: ${thunderName(day.thunder, T)}`);
    lines.push(parts.join(' · '));
  }
  lines.push('', italic(T.s(
    'Daily ranges come from the 3-hour model steps, so they can differ from official daily extremes. The website has the 10-day outlook.',
    'দৈনিক সীমা ৩ ঘণ্টার মডেল ধাপ থেকে নেওয়া, তাই সরকারি দৈনিক সর্বোচ্চ-সর্বনিম্নের সঙ্গে ভিন্ন হতে পারে। ১০ দিনের পূর্বাভাস ওয়েবসাইটে আছে।',
  )));
  if (f.rain.unverified) lines.push(italic(T.s('Rain amounts are BMD values as published; their unit has not been independently confirmed.', 'বৃষ্টির পরিমাণ বিএমডির প্রকাশিত মান; এর একক এখনো স্বাধীনভাবে নিশ্চিত করা হয়নি।')));
  lines.push('', closing(T, [sourceLine(T, f.coreSource, f.coreInfo)]));
  return fit(lines.join('\n'));
}

// ---------- /alerts ----------
export function renderAlerts({ lang, nowMs, linked, items = [], webUrl = env.channels.publicUrl }) {
  const T = makeText(lang, nowMs);
  if (!linked) {
    return fit([
      `🔔 ${bold(T.s('Your alerts', 'আপনার সতর্কবার্তা'))}`,
      '',
      T.s(
        `This chat is not connected to an alert profile. Set up your alerts at ${webUrl}/alert and choose "Connect Telegram".`,
        `এই চ্যাট কোনো সতর্কবার্তা প্রোফাইলের সঙ্গে যুক্ত নয়। ${webUrl}/alert-এ সতর্কবার্তা চালু করে "টেলিগ্রাম সংযুক্ত করুন" বেছে নিন।`,
      ),
    ].join('\n'));
  }
  const lines = [`🔔 ${bold(T.s('Your active alerts', 'আপনার সক্রিয় সতর্কবার্তা'))}`, ''];
  if (!items.length) {
    lines.push(T.s(
      'There is no active AkashSathi alert for your saved area right now. That is not a statement that the weather is calm: send /update for the forecast and check official BMD warnings.',
      'আপনার সংরক্ষিত এলাকায় এখন আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই। এর মানে আবহাওয়া শান্ত থাকা নয়: পূর্বাভাসের জন্য /update পাঠান এবং বিএমডির সরকারি সতর্কবার্তা দেখুন।',
    ));
  } else {
    for (const item of items.slice(0, 5)) {
      const label = SEVERITY_NAMES[T.L][item.severity] ?? item.severity;
      lines.push(`[${esc(label)}] ${esc(item.title)} — ${T.s('until', 'পর্যন্ত')} ${esc(T.when(+new Date(item.validUntil)))}`);
    }
    if (items.length > 5) lines.push(T.s(`…and ${T.n(items.length - 5)} more in the app.`, `…এবং অ্যাপে আরও ${T.n(items.length - 5)}টি।`));
    lines.push('', `${T.s('Details', 'বিস্তারিত')}: ${webUrl}/alert`);
  }
  lines.push('', italic(T.s('Alerts are only created from current forecast data. Send /status to see how fresh it is.', 'সতর্কবার্তা শুধু হালনাগাদ পূর্বাভাসের তথ্য থেকে তৈরি হয়। তথ্য কতটা নতুন দেখতে /status পাঠান।')));
  lines.push('', italic(DISCLAIMER(T)));
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
    const parts = [STATUS_WORDS[T.L][fresh.status] ?? fresh.status];
    if (fresh.updatedMs) parts.push(T.s(`updated ${T.when(fresh.updatedMs)} (${T.ago(fresh.updatedMs)})`, `হালনাগাদ ${T.when(fresh.updatedMs)} (${T.ago(fresh.updatedMs)})`));
    lines.push(`${fresh.status === 'ok' ? '✅' : '⚠'} ${esc(PROVIDER_LABELS[source][T.L])}: ${esc(parts.join(' · '))}`);
  }
  if (engine) {
    const last = engine.lastCompletedMs ? T.s(`last run ${T.ago(engine.lastCompletedMs)}`, `সর্বশেষ চালু হয়েছে ${T.ago(engine.lastCompletedMs)}`) : T.s('has not run yet', 'এখনো চালু হয়নি');
    lines.push(`${engine.enabled ? '✅' : '⚠'} ${T.s('Alert engine', 'সতর্কবার্তা ইঞ্জিন')}: ${engine.enabled ? esc(last) : T.s('switched off', 'বন্ধ আছে')}`);
  }
  lines.push('', italic(T.s(
    'Lightning is checked a few times a day (more often when storms are forecast) and each check covers only a few minutes, so it is not continuous monitoring. Weather figures here are model forecasts, not station readings.',
    'বজ্রপাত দিনে কয়েকবার পরীক্ষা করা হয় (ঝড়ের পূর্বাভাস থাকলে আরও ঘন ঘন) এবং প্রতিটি পরীক্ষা মাত্র কয়েক মিনিট দেখে, তাই এটি সারাক্ষণ নজরদারি নয়। এখানের আবহাওয়ার সংখ্যাগুলো মডেল পূর্বাভাস, কেন্দ্রের পরিমাপ নয়।',
  )));
  lines.push('', italic(DISCLAIMER(T)));
  return fit(lines.join('\n'));
}

// ---------- help and place questions ----------
const COMMAND_HELP = {
  en: [
    ['update', 'weather now and the next hours'],
    ['heat', 'heat index and advice'],
    ['rain', 'rain, next 24 hours'],
    ['wind', 'wind and gusts'],
    ['thunderstorm', 'thunderstorm outlook'],
    ['lightning', 'lightning that was recorded'],
    ['forecast', 'the days ahead'],
    ['alerts', 'your active alerts'],
    ['status', 'how fresh the data is'],
  ],
  bn: [
    ['update', 'এখনকার আবহাওয়া ও পরের কয়েক ঘণ্টা'],
    ['heat', 'হিট ইনডেক্স ও পরামর্শ'],
    ['rain', 'বৃষ্টি, পরবর্তী ২৪ ঘণ্টা'],
    ['wind', 'বাতাস ও দমকা হাওয়া'],
    ['thunderstorm', 'বজ্রঝড়ের পূর্বাভাস'],
    ['lightning', 'রেকর্ড হওয়া বজ্রপাত'],
    ['forecast', 'আগামী দিনগুলো'],
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
      T.s('AkashSathi: weather information and alerts for your work and area.', 'আকাশসাথী: আপনার কাজ ও এলাকার আবহাওয়ার তথ্য ও সতর্কবার্তা।'),
      '',
      list,
      '',
      T.s(
        'Add a place to any weather command, in English or Bangla, for example /heat Badda or /rain Savar, Dhaka. Without a place it uses your saved area. Add "bn" or "en" at the end to choose the language.',
        'যেকোনো আবহাওয়ার কমান্ডের সঙ্গে ইংরেজি বা বাংলায় জায়গার নাম দিন, যেমন /heat বাড্ডা বা /rain Savar, Dhaka। নাম না দিলে আপনার সংরক্ষিত এলাকা ধরা হয়। ভাষা বাছতে শেষে "bn" বা "en" লিখুন।',
      ),
      '',
      T.s(
        `To get alerts for your work here, set them up at ${webUrl}/alert and choose "Connect Telegram". /stop turns alerts off in this chat.`,
        `আপনার কাজের জন্য এখানে সতর্কবার্তা পেতে ${webUrl}/alert-এ সেটআপ করে "টেলিগ্রাম সংযুক্ত করুন" বেছে নিন। /stop এই চ্যাটে সতর্কবার্তা বন্ধ করে।`,
      ),
    ].join('\n');
  };
  return lang === 'bn' || lang === 'en' ? make(lang) : `${make('en')}\n\n${make('bn')}`;
}

export function renderAskPlace(lang) {
  const T = makeText(lang, 0);
  return T.s(
    'Which place? Send the command with a place name, for example /update Badda or /heat Savar, Dhaka. To use your saved area automatically, connect your alerts first (send /help).',
    'কোন জায়গা? কমান্ডের সঙ্গে জায়গার নাম দিন, যেমন /update বাড্ডা বা /heat Savar, Dhaka। সংরক্ষিত এলাকা নিজে থেকে ব্যবহার করতে আগে আপনার সতর্কবার্তা সংযুক্ত করুন (/help পাঠান)।',
  );
}

export function renderNotFound(lang, query) {
  const T = makeText(lang, 0);
  return T.s(
    `I could not find a place called "${esc(query)}". Try the upazila, city thana or district name, in English or Bangla, for example Badda or Savar, Dhaka.`,
    `"${esc(query)}" নামে কোনো জায়গা পাইনি। উপজেলা, সিটি থানা বা জেলার নাম ইংরেজি বা বাংলায় লিখুন, যেমন বাড্ডা বা Savar, Dhaka।`,
  );
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
