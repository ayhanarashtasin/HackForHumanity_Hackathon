import zlib from 'node:zlib';
import { freshness } from '../config/alertRules.js';
import { effectiveStatus, loadSnapshots, saveSnapshot } from './alerts/snapshots.js';

// BMD's official bulletins are PDFs found by scraping each product's content page (there is no verified JSON feed). This module only DISCOVERS
// the current document, reads its text on a best-effort basis, and records what it explicitly says. Anything it cannot read stays a link
// ("link-only"), and a blank or missing page is never taken as a withdrawal.
export const PRODUCTS = [
  { key: 'fishermen-forecast', page: 'Fishermen-Forecast', label: { en: 'Fishermen forecast', bn: 'জেলেদের জন্য পূর্বাভাস' }, kind: 'marine', validityHours: 24 },
  { key: 'fleet-forecast', page: 'Fleet-Forecast-107', label: { en: 'Fleet forecast', bn: 'ফ্লিট পূর্বাভাস' }, kind: 'marine', validityHours: 12 },
  { key: 'sea-bulletin', page: 'SEA-BULLETING', label: { en: 'Sea bulletin', bn: 'সমুদ্র বুলেটিন' }, kind: 'marine', validityHours: 24 },
  { key: 'inland-riverport', page: 'Inland-Riverport-Warning', label: { en: 'Inland river-port warning', bn: 'অভ্যন্তরীণ নদীবন্দর সতর্কবার্তা' }, kind: 'river', validityHours: 24 },
  { key: 'general-forecast', page: 'Weather-Forecast', label: { en: 'General weather forecast', bn: 'সাধারণ আবহাওয়ার পূর্বাভাস' }, kind: 'general', validityHours: 24 },
];

const PAGE_BASE = 'https://www.bmd.gov.bd/web/en/p/';
const MAX_PAGE_BYTES = 2_000_000;
const MAX_PDF_BYTES = 6_000_000;
const TIMEOUT_MS = 20_000;
const EXCERPT_CHARS = 1200;
const HOUR = 3_600_000;

// Only documents hosted by BMD itself are ever fetched (a scraped page must not be able to point this server at another host).
export function isBmdHost(urlText) {
  try {
    const url = new URL(urlText);
    return url.protocol === 'https:' && (url.hostname === 'bmd.gov.bd' || url.hostname.endsWith('.bmd.gov.bd'));
  } catch {
    return false;
  }
}

// ".../file/2026/10/10/pdf/210645.pdf": the folder is the date, the number is the document id.
export function discoverLink(html) {
  const match = /https:\/\/[a-z0-9.-]*bmd\.gov\.bd\/file\/(\d{4})\/(\d{2})\/(\d{2})\/pdf\/(\d+)\.pdf/i.exec(String(html ?? ''));
  if (!match || !isBmdHost(match[0])) return null;
  const issuedDate = `${match[1]}-${match[2]}-${match[3]}`;
  if (!Number.isFinite(Date.parse(issuedDate)) || new Date(issuedDate).toISOString().slice(0, 10) !== issuedDate) return null;
  return { documentUrl: match[0], fileId: match[4], issuedDate };
}

// ---------- reading the PDF text (best effort) ----------
// BMD's PDFs are "Print to PDF" files: Type0 fonts with ToUnicode maps. The extractor reads those maps and rebuilds lines by position.
function hexToText(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

function parseCMap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(from, 16), hexToText(to));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const start = parseInt(lo, 16);
      const end = Math.min(parseInt(hi, 16), start + 0xffff);
      if (rest.startsWith('[')) {
        [...rest.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((entry, i) => map.set(start + i, hexToText(entry[1])));
      } else {
        const first = parseInt(rest.slice(1, -1), 16);
        for (let code = start; code <= end; code += 1) map.set(code, hexToText((first + code - start).toString(16).padStart(4, '0')));
      }
    }
  }
  return map;
}

export function extractPdfText(buffer) {
  try {
    const source = buffer.toString('latin1');
    const objects = new Map();
    for (const match of source.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
      const body = match[2];
      const at = body.indexOf('stream');
      const dict = at < 0 ? body : body.slice(0, at);
      let data = null;
      if (at >= 0) {
        const start = at + /^stream\r?\n/.exec(body.slice(at))[0].length;
        const raw = Buffer.from(body.slice(start, body.lastIndexOf('endstream')), 'latin1');
        try { data = /FlateDecode/.test(dict) ? zlib.inflateSync(raw, { maxOutputLength: MAX_PDF_BYTES }).toString('latin1') : raw.toString('latin1'); } catch { data = null; }
      }
      objects.set(Number(match[1]), { dict, data });
    }

    // font resource names -> ToUnicode maps
    const fontObject = new Map();
    for (const group of source.matchAll(/\/Font\s*<<([^>]*)>>/g)) for (const [, name, num] of group[1].matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) fontObject.set(name, Number(num));
    const cmaps = new Map();
    for (const [name, num] of fontObject) {
      const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(objects.get(num)?.dict ?? '');
      const data = toUnicode ? objects.get(Number(toUnicode[1]))?.data : null;
      if (data) cmaps.set(name, parseCMap(data));
    }
    if (!cmaps.size) return null;

    const runs = [];
    for (const { data } of objects.values()) {
      if (!data || !/\bBT\b/.test(data) || !/\bET\b/.test(data)) continue;
      let font = null;
      let x = 0;
      let y = 0;
      const token = /\/(\w+)\s+[\d.]+\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
      for (const t of data.matchAll(token)) {
        if (t[1]) font = cmaps.get(t[1]) ?? null;
        else if (t[2] !== undefined) { x = Number(t[6]); y = Number(t[7]); } else if (font) {
          const hexes = t[8] !== undefined ? [...t[8].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]) : [t[9]];
          let text = '';
          for (const hex of hexes) for (let i = 0; i + 3 < hex.length + 1; i += 4) text += font.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
          if (text) runs.push({ x, y, text });
        }
      }
    }
    if (!runs.length) return null;

    const lines = new Map();
    for (const run of runs) {
      const key = Math.round(run.y / 3);
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(run);
    }
    return [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, line]) => line.sort((a, b) => a.x - b.x).map((run) => run.text).join('').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  } catch {
    return null;
  }
}

// ---------- what the bulletin explicitly says ----------
const NO_WARNING = /\bNO\s+(?:STORM\s+|INLAND\s+RIVER[\s-]*PORT\s+)?WARNING\b|\bNO\s+SIGNAL\b/i;
const SIGNAL = /\b(?:(?:LOCAL|DISTANT)\s+)?(?:CAUTIONARY|WARNING|DANGER|GREAT\s+DANGER)\s+SIGNAL\s+(?:NO\.?|NUMBER)?[\s.-]*(\d{1,2})\b/gi;
// "Storm Warning Center" is BMD's letterhead, and "NO STORM WARNING" is the opposite statement: neither is a warning.
const STORM_WARNING = /\b(?<!NO\s)STORM\s+WARNING\b(?!\s+CENT(?:ER|RE))/i;

// 'no-warning' | 'warning' | 'unknown'. Only explicit statements count; a text that says both, or neither, is 'unknown' and changes nothing.
export function classifyBulletin(text) {
  if (!text) return { statement: 'unknown', signals: [], excerpt: null };
  const excerpt = text.slice(0, EXCERPT_CHARS);
  const signals = [...text.matchAll(SIGNAL)].map((match) => ({ text: match[0].replace(/\s+/g, ' ').trim(), number: Number(match[1]) }));
  const says = { none: NO_WARNING.test(text), signal: signals.length > 0 || STORM_WARNING.test(text) };
  if (says.none && says.signal) return { statement: 'unknown', signals, excerpt };
  const lines = text.split('\n').filter((line) => /SIGNAL\s+(?:NO|NUMBER)|STORM\s+WARNING(?!\s+CENT)/i.test(line));
  const signalText = (lines.length ? lines.join(' ') : excerpt).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (says.signal) return { statement: 'warning', signals, excerpt, signalText, greatDanger: /GREAT\s+DANGER/i.test(text) };
  if (says.none) return { statement: 'no-warning', signals: [], excerpt };
  return { statement: 'unknown', signals: [], excerpt };
}

// Only documented header formats are interpreted. An upload-folder date is not an issue time, and AREA C-90 is not North Bay.
// `issuedAt` is the stated header reference/validity-start time used for ordering; the UI calls it a reference time, not a publication clock.
// ponytail: best-effort extraction for the inspected BMD layouts; unfamiliar layouts stay link-only until verified.
export function bulletinMetadata(text, product) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  const metadata = { issuedAt: null, validFrom: null, validUntil: null, tz: null, validityAssumed: false, marineZone: null };
  if (!/\bAREA\s+C[ -]?90\b/i.test(flat) && /\bOVER\s+NORTH\s+BAY\b/i.test(flat)) metadata.marineZone = 'north_bay';

  const stamp = (day, month, year, hour, minute, tz) => {
    const date = `${year}-${month}-${day}`;
    if (Number(hour) > 23 || Number(minute) > 59 || !Number.isFinite(Date.parse(date))) return null;
    if (new Date(date).toISOString().slice(0, 10) !== date) return null;
    return new Date(`${date}T${hour}:${minute}:00${tz.toUpperCase() === 'BST' ? '+06:00' : 'Z'}`).toISOString();
  };
  const validity = /\bVALID\s+FOR\s+(\d{1,2})\s+HOURS\s+COMMENCING\s+(\d{2}):?(\d{2})\s+(?:HOURS\s+)?(BST|UTC)\s+OF\s+(\d{2})[./-](\d{2})[./-](\d{4})\b/i.exec(flat);
  if (validity) {
    const [, hours, hour, minute, tz, day, month, year] = validity;
    const start = stamp(day, month, year, hour, minute, tz);
    if (start && Number(hours) > 0 && Number(hours) <= 72) {
      Object.assign(metadata, { issuedAt: start, validFrom: start, validUntil: new Date(Date.parse(start) + Number(hours) * HOUR).toISOString(), tz: tz.toUpperCase() });
    }
  } else if (product.key === 'sea-bulletin') {
    const reference = /\bAT\s+(\d{2})[./-](\d{2})[./-](\d{4}),?\s+(\d{2}):?(\d{2})\s+(BST|UTC)\b/i.exec(flat);
    if (reference) {
      const [, day, month, year, hour, minute, tz] = reference;
      const start = stamp(day, month, year, hour, minute, tz);
      if (start) Object.assign(metadata, { issuedAt: start, validFrom: start, validUntil: new Date(Date.parse(start) + product.validityHours * HOUR).toISOString(), tz: tz.toUpperCase(), validityAssumed: true });
    }
  }
  return metadata;
}

export function bulletinStatus(row, nowMs = Date.now()) {
  const status = effectiveStatus(row, freshness.bulletins.maxCheckAgeMs, nowMs);
  if (['STALE', 'UNAVAILABLE'].includes(status)) return status;
  const until = Date.parse(row.data?.validUntil);
  if (Number.isFinite(until) && until <= nowMs) return 'STALE';
  return row.data?.documentFound !== false && row.data?.parserStatus === 'parsed' && Number.isFinite(until) ? status : 'PARTIAL';
}

// ---------- fetching ----------
async function fetchBytes(url, { fetchImpl, maxBytes, signal }) {
  let response;
  // Check every redirect as well as the discovered URL.
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isBmdHost(url)) throw new Error('The document is not hosted by BMD.');
    response = await fetchImpl(url, { signal, headers: { 'User-Agent': 'AkashSathi-prototype', Accept: '*/*' }, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('The document redirect could not be followed.');
    url = new URL(location, url).href;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('The document is larger than expected.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('The document is larger than expected.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// One product: read its page, find the current PDF, and (only when the document changed) read its text. Returns the snapshot data.
export async function refreshProduct(product, { fetchImpl = fetch, previous = null, now = () => new Date() } = {}) {
  const at = now();
  const base = { provider: 'bmd', product: 'bulletin', queryKey: product.key, scope: { page: `${PAGE_BASE}${product.page}` }, now: at };

  try {
    const page = await fetchBytes(`${PAGE_BASE}${product.page}`, { fetchImpl, maxBytes: MAX_PAGE_BYTES, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const link = discoverLink(page.toString('utf8'));
    // No link on the page is NOT a withdrawal: a blank page is recorded as "no document found" and nothing else.
    if (!link) {
      await saveSnapshot({ ...base, status: 'PARTIAL', data: { ...(previous?.data ?? {}), pageChecked: at.toISOString(), documentFound: false }, message: 'The page has no current document.' });
      return { key: product.key, status: 'PARTIAL', changed: false };
    }

    if (previous?.data?.fileId === link.fileId && previous?.data?.parserStatus === 'parsed' && previous.data.rawText && previous.data.documentFound !== false) {
      const status = 'FRESH';
      await saveSnapshot({ ...base, status, data: { ...previous.data, pageChecked: at.toISOString() }, issuedAt: previous.issuedAt, validFrom: previous.validFrom, validTo: previous.validTo });
      return { key: product.key, status, changed: false };
    }

    let text = null;
    let parserStatus = 'link-only';
    try {
      const pdf = await fetchBytes(link.documentUrl, { fetchImpl, maxBytes: MAX_PDF_BYTES, signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = extractPdfText(pdf);
      parserStatus = text ? 'parsed' : 'link-only';
    } catch {
      parserStatus = 'link-only';
    }
    const classification = classifyBulletin(text);
    const metadata = bulletinMetadata(text, product);
    const status = parserStatus === 'parsed' ? 'FRESH' : 'PARTIAL';
    await saveSnapshot({
      ...base,
      status,
      data: {
        ...link, ...metadata, rawText: text, parserStatus, statement: classification.statement, signals: classification.signals, signalText: classification.signalText ?? null, greatDanger: classification.greatDanger ?? false,
        excerpt: classification.excerpt, documentFound: true, pageChecked: at.toISOString(), discoveredAt: at.toISOString(),
      },
      issuedAt: metadata.issuedAt ? new Date(metadata.issuedAt) : null,
      validFrom: metadata.validFrom ? new Date(metadata.validFrom) : null,
      validTo: metadata.validUntil ? new Date(metadata.validUntil) : null,
    });
    return { key: product.key, status, changed: previous?.data?.fileId !== link.fileId, statement: classification.statement };
  } catch (error) {
    await saveSnapshot({ ...base, status: 'UNAVAILABLE', errorClass: 'network', message: String(error.message).slice(0, 160) });
    return { key: product.key, status: 'UNAVAILABLE', changed: false };
  }
}

export async function refreshBulletins({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const previous = await loadSnapshots('bmd', 'bulletin', PRODUCTS.map((product) => product.key));
  const results = [];
  for (const product of PRODUCTS) results.push(await refreshProduct(product, { fetchImpl, previous: previous.get(product.key) ?? null, now }));
  const failed = results.filter((result) => result.status === 'UNAVAILABLE').length;
  return { status: failed === results.length ? 'error' : (failed || results.some((result) => result.status === 'PARTIAL') ? 'partial' : 'ok'), results };
}
