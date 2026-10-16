// Dates and numbers for the alert pages: Bangladesh time (a fixed UTC+6), 24-hour clock, Bengali digits in Bangla.
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const OFFSET_MS = 6 * 3_600_000;
const pad = (n) => String(n).padStart(2, '0');

export function digits(text, lang) {
  return lang === 'bn' ? String(text).replace(/\d/g, (digit) => BN_DIGITS[Number(digit)]) : String(text);
}

// An alert's own text in the given language: the alternative reading the server stored (`translations`) if there is one, else the
// language it was actually composed and sent in (`item.lang`, what a profile edit changes going forward). An older alert from before
// `translations` existed, or free text the administrator left untranslated, has no `translations` and falls back the same way.
export function localized(item, lang) {
  const alt = item.translations?.[lang];
  return alt ? { ...alt, lang } : {
    title: item.title, message: item.message, recommendedActions: item.recommendedActions, reasonForSelection: item.reasonForSelection, affectedArea: item.affectedArea, lang: item.lang,
  };
}

// "10 Oct, 15:42" / "১০ অক্টোবর, ১৫:৪২". Returns '' for a missing or invalid date.
export function formatDhaka(value, lang = 'en', { withDate = true } = {}) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) return '';
  const shifted = new Date(time + OFFSET_MS);
  const clock = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  if (!withDate) return digits(clock, lang);
  const month = (lang === 'bn' ? BN_MONTHS : EN_MONTHS)[shifted.getUTCMonth()];
  return digits(`${shifted.getUTCDate()} ${month}, ${clock}`, lang);
}

// "3 min ago" style age for last-checked times; never negative.
export function ageText(value, lang = 'en', now = Date.now()) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return lang === 'bn' ? 'এইমাত্র' : 'just now';
  if (minutes < 60) return digits(lang === 'bn' ? `${minutes} মিনিট আগে` : `${minutes} min ago`, lang);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return digits(lang === 'bn' ? `${hours} ঘণ্টা আগে` : `${hours} h ago`, lang);
  const days = Math.round(hours / 24);
  return digits(lang === 'bn' ? `${days} দিন আগে` : `${days} d ago`, lang);
}

// The measured or forecast numbers behind an alert, as labelled rows. `tr` is the page translator (key, params) -> text.
const METRICS = {
  rain3hMm: 'mm', rain24hMm: 'mm', popPercent: 'pct', peakValueC: 'c', airTempMaxC: 'c', maxGustKph: 'kph', maxWaveM: 'm', dryDays: null, meanTmaxC: 'c', nearestKm: 'km', count: null,
};

export function evidenceRows(evidence, tr, lang = 'en') {
  const rows = [];
  const metrics = evidence?.metrics ?? {};
  for (const [key, unit] of Object.entries(METRICS)) {
    if (typeof metrics[key] !== 'number') continue;
    rows.push({ key, label: tr(`ev.${key}`), value: unit ? `${number(metrics[key], lang)} ${tr(`unit.${unit}`)}` : number(metrics[key], lang) });
  }
  if (metrics.indicator) rows.push({ key: 'indicator', label: tr('ev.indicator'), value: tr(`indicator.${metrics.indicator}`) });
  if (typeof evidence?.statusAgeHours === 'number') {
    rows.push({ key: 'statusAgeHours', label: tr('ev.statusAgeHours'), value: `${number(evidence.statusAgeHours, lang)} ${tr('unit.h')}` });
  }
  return rows;
}

// Numbers from the evidence block, with the digits of the page language.
export function number(value, lang = 'en') {
  return digits(Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10), lang);
}

export function referenceHref(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
