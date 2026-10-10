// Bangladeshi mobile numbers only: the product serves Bangladesh, and refusing every other country code closes the door on
// international SMS-pumping abuse. Accepts 01712345678, +8801712345678 and 8801712345678, with spaces or dashes, in Latin or Bangla digits.
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

function toLatinDigits(text) {
  return String(text).replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
}

// -> "+8801XXXXXXXXX" or null.
export function normalizeBdMobile(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const compact = toLatinDigits(input).replace(/[\s\-().]/g, '');
  const match = /^(?:\+?880|0)(1[3-9]\d{8})$/.exec(compact);
  return match ? `+880${match[1]}` : null;
}

// "+8801712345678" -> "+8801•••••678": enough for a person to recognise their own number, not enough to reuse it.
export function maskPhone(e164) {
  const text = String(e164 ?? '');
  return text.length >= 8 ? `${text.slice(0, 5)}${'•'.repeat(Math.max(text.length - 8, 3))}${text.slice(-3)}` : '•••';
}

// WhatsApp's Cloud API wants the number without the plus sign.
export const toWhatsAppId = (e164) => String(e164).replace(/^\+/, '');
