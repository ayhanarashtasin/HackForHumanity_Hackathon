// The pure side of connecting Telegram, WhatsApp and SMS (no React): number checking, which message to show for which server answer.
// The server validates everything again; this only saves a round trip and gives answers in the person's language.
export const CHANNELS = ['telegram', 'whatsapp', 'sms'];
export const PHONE_CHANNELS = ['whatsapp', 'sms'];

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
export const latinDigits = (text) => String(text ?? '').replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));

// "0171 234 5678", "+8801712345678" and Bangla digits all mean the same number. Returns +8801XXXXXXXXX, or null when it is not a Bangladeshi mobile.
export function normalizeBdMobile(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const compact = latinDigits(input).replace(/[\s\-().]/g, '');
  const match = /^(?:\+?880|0)(1[3-9]\d{8})$/.exec(compact);
  return match ? `+880${match[1]}` : null;
}

// -> i18n key of the problem, or null when the form can be sent.
export function phoneFormProblem({ phone, consent }) {
  if (!normalizeBdMobile(phone)) return 'ch.err.phone';
  if (consent !== true) return 'ch.err.consent';
  return null;
}

export const codeFormProblem = (code) => (/^\d{6}$/.test(latinDigits(code).trim()) ? null : 'ch.err.code');

// The server's answers are in English; the page shows its own wording in the person's language.
export function channelErrorKey(problem) {
  const details = problem?.details ?? {};
  if (details.consent) return 'ch.err.consent';
  if (details.phone) return 'ch.err.phone';
  if (details.code === 'invalid') return 'ch.err.code';
  if (details.code === 'wrong') return 'ch.err.wrong';
  if (details.code === 'expired') return 'ch.err.expired';
  if (problem?.status === 429) return 'ch.err.rate';
  if (problem?.status === 502 || problem?.status === 503) return 'ch.err.send';
  if (problem?.status === 400 && /cannot receive/i.test(problem.message ?? '')) return 'ch.err.blocked';
  return 'ch.err.generic';
}

// What a channel carries, from the lowest severity the server sends on it.
export const receivesKey = (minSeverity) => `ch.sev.${['ADVISORY', 'WARNING', 'CRITICAL'].includes(minSeverity) ? minSeverity : 'ADVISORY'}`;
