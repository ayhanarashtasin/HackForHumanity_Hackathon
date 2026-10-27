// Reads the official phone numbers out of a health complex's own contact page on the Government of Bangladesh portal.
//
// The portal stores a page's own content, base64-encoded, in <rt-renderer encoded-content="...">, ahead of its menus and shared widgets
// (which include a hotline list with unrelated 11-digit numbers). Only that content is read. Among the numbers in it, the most useful one
// for someone in trouble comes first: the emergency department, then a number marked official/office, then any labelled number, then
// any other number in the contact text.
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const asciiDigits = (text) => text.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
const ENCODED = /<rt-renderer\s+encoded-content="([A-Za-z0-9+/=]+)"/;

export function pageContent(html) {
  const encoded = ENCODED.exec(html)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
}

const textOf = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h\d>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&');

const EMERGENCY = /জরুরি|জরূরী|জরুরী|emergency|ইমার্জেন্সি/i;
const OFFICIAL = /সরকারি|সরকারী|official|অফিস|office|কমপ্লেক্স|complex|হাসপাতাল|hospital/i;
const LABEL = /মোবাইল|মোবাঃ|মোবা:|মোবা\.|টেলিফোন|ফোন|phone|mobile|tel\b|cell|নং|no\b|নম্বর/i;
const FAX = /ফ্যাক্স|fax/i;

// -> { mobile, landline, email, emergency } (each null when absent). `emergency` is true when the mobile is the emergency department's.
export function officialNumbers(html) {
  const content = pageContent(html);
  if (!content) return { mobile: null, landline: null, email: null, emergency: false };
  const lines = asciiDigits(textOf(content)).split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const mobiles = [];
  const landlines = [];
  for (const line of lines) {
    if (FAX.test(line) && !/মোবাইল|mobile/i.test(line)) continue;
    for (const match of line.matchAll(/(?:\+?88)?0\d[\d\s\-–]{6,14}\d/g)) {
      const digits = match[0].replace(/\D/g, '').replace(/^88/, '');
      const rank = EMERGENCY.test(line) ? 0 : OFFICIAL.test(line) ? 1 : LABEL.test(line) ? 2 : 3;
      if (/^01[3-9]\d{8}$/.test(digits)) mobiles.push({ digits, rank });
      else if (/^0[2-9]\d{7,9}$/.test(digits)) landlines.push({ digits, rank });
    }
  }
  const best = (list) => list.sort((a, b) => a.rank - b.rank)[0] ?? null;
  const mobile = best(mobiles);
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.gov(?:\s?\.)?\s?bd/i.exec(asciiDigits(textOf(content)))?.[0]?.replace(/\s/g, '') ?? null;
  return { mobile: mobile?.digits ?? null, landline: best(landlines)?.digits ?? null, email, emergency: mobile?.rank === 0 };
}
