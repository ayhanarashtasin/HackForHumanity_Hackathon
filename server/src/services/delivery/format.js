import { env } from '../../config/env.js';
import { SENDER_LABELS, confidenceLine, localizeDigits, whenText } from '../alerts/messages.js';

// A short copy of a stored notification for a messaging channel. Built from the notification alone: no occupation, no "why you
// received this", no profile answers (catalogue CTX-03: a shared or glanced-at phone must not reveal personal information).
// What stays is what a person needs: how serious, what, where and until when, who said it, and where to read more.
const SEVERITY_LABEL = {
  ADVISORY: { en: 'Advisory', bn: 'পরামর্শ' },
  WARNING: { en: 'Warning', bn: 'সতর্কতা' },
  CRITICAL: { en: 'Critical', bn: 'জরুরি' },
};

const OFFICIAL_LABEL = { en: 'Official BMD notice (quoted)', bn: 'বিএমডির অফিসিয়াল বিজ্ঞপ্তি (উদ্ধৃত)' };

const TEXT = {
  en: {
    validUntil: (when) => `Valid until ${when} (Bangladesh time).`,
    details: (url) => `Details: ${url}`,
    official: (quote) => `Official BMD wording (quoted): "${quote}"`,
    original: (url) => `Original: ${url}`,
    reference: (url) => `Reference: ${url}`,
    until: (when) => `Until ${when}`,
  },
  bn: {
    validUntil: (when) => `${when} পর্যন্ত বলবৎ (বাংলাদেশ সময়)।`,
    details: (url) => `বিস্তারিত: ${url}`,
    official: (quote) => `বিএমডির মূল বক্তব্য (উদ্ধৃত): "${quote}"`,
    original: (url) => `মূল নথি: ${url}`,
    reference: (url) => `সূত্র: ${url}`,
    until: (when) => `${when} পর্যন্ত`,
  },
};

const SMS_LIMIT = { en: 320, bn: 200 }; // Bangla is sent as UCS-2: 70 characters per segment, so 200 is three segments
const TELEGRAM_MAX = 3800;

export function senderOf(notification) {
  if (notification.origin !== 'automatic') return 'administrator';
  return notification.evidence?.official ? 'official' : 'automatic';
}

function senderLabel(notification, lang) {
  const sender = senderOf(notification);
  if (sender === 'official') return OFFICIAL_LABEL[lang];
  if (sender === 'administrator') return SENDER_LABELS.administrator[lang];
  return (notification.ruleStatus === 'validated' ? SENDER_LABELS['automatic-validated'] : SENDER_LABELS.automatic)[lang];
}

// GSM-7 SMS holds 160 characters, but one typographic dash or curly quote switches the whole message to UCS-2 (70 characters).
function plainAscii(text) {
  return text
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/·/g, '-')
    .replace(/ /g, ' ');
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, Math.max(max - 1, 1)).trimEnd()}…` : text);
const stripEnd = (text) => String(text ?? '').trim().replace(/[.\s]+$/, '');

// -> { text, parts }: `text` for Telegram and SMS, `parts` (the four variables of the WhatsApp template) for WhatsApp.
export function renderMessage(channel, notification, { nowMs = Date.now(), siteUrl = env.channels.publicUrl } = {}) {
  const lang = notification.lang === 'bn' ? 'bn' : 'en';
  const words = TEXT[lang];
  const severity = SEVERITY_LABEL[notification.severity]?.[lang] ?? notification.severity;
  const tag = lang === 'bn' ? severity : severity.toUpperCase();
  const title = stripEnd(notification.title);
  const until = localizeDigits(whenText(+new Date(notification.validUntil), nowMs, lang), lang);
  const sender = senderLabel(notification, lang);
  const link = `${siteUrl}/alert`;
  const official = notification.evidence?.official ?? null;
  const documentUrl = official?.documentUrl ?? notification.sourceReferences?.find((source) => source.url)?.url ?? null;
  const referenceUrl = notification.params?.referenceUrl ?? null;

  const lines = [`[${tag}] ${title}`, '', clip(String(notification.message ?? '').trim(), 2800), ''];
  lines.push(words.validUntil(until), sender);
  if (official?.signalText) lines.push(words.official(String(official.signalText).slice(0, 300)));
  if (documentUrl && /^https?:\/\//i.test(documentUrl)) lines.push(words.original(documentUrl));
  else if (referenceUrl && /^https?:\/\//i.test(referenceUrl)) lines.push(words.reference(referenceUrl));
  lines.push(words.details(link));
  const full = clip(lines.join('\n'), TELEGRAM_MAX);

  // SMS: one short line. The first recommended action is the most useful sentence; drop it before cutting the title.
  // English is normalised to plain ASCII BEFORE measuring, so the ellipsis and dashes cannot push it over the limit afterwards.
  const limit = SMS_LIMIT[lang];
  const ascii = lang === 'en' ? plainAscii : (text) => text;
  const ellipsis = lang === 'en' ? '...' : '…';
  const cut = (text, max) => (text.length > max ? `${text.slice(0, Math.max(max - ellipsis.length, 1)).trimEnd()}${ellipsis}` : text);
  const head = ascii(`AkashSathi ${tag}: ${title}`);
  const confidence = ascii(stripEnd(confidenceLine(notification.evidence?.forecastConfidence?.band, lang).replace(/।$/, '')));
  const action = ascii(stripEnd(notification.recommendedActions?.[0]?.text));
  const tail = ascii(`${words.until(until)}. ${link}`);
  // Drop the action first, then the confidence line, before cutting the title.
  let sms = [head, confidence, action, tail].filter(Boolean).join('. ');
  if (sms.length > limit) sms = [head, confidence, tail].filter(Boolean).join('. ');
  if (sms.length > limit) sms = [head, tail].join('. ');
  if (sms.length > limit) sms = `${cut(head, Math.max(limit - tail.length - 2, 20))}. ${tail}`;

  return {
    text: channel === 'sms' ? sms : full,
    // WhatsApp template variables may not contain line breaks, so the confidence line joins the message with a space there.
    parts: [tag, title, `${String(notification.message ?? '').trim().replace(/\s*\n\s*/g, ' ')} (${sender})`, until],
  };
}
