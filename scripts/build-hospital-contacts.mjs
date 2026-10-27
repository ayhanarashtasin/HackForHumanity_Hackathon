// Builds server/data/hospital-contacts-bd.json: the official website and official phone numbers of every upazila health complex, read from
// the Government of Bangladesh's national portal (the portal's own office list, then each health complex's "যোগাযোগ" page).
//
//   node scripts/build-hospital-contacts.mjs        (then: node scripts/build-hospitals.mjs, which attaches them to the hospitals)
//
// Only numbers the official contact page labels as a telephone or mobile number are kept, and each keeps the page it came from. Officers'
// personal pages and the portal's shared hotline list are never read. Responses are cached in scripts/.cache/gov, so a rerun resumes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialNumbers } from './lib/official-numbers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache', 'gov');
const OUT = join(ROOT, 'server', 'data', 'hospital-contacts-bd.json');
const PORTAL = 'https://jhalakathi.gov.bd'; // any portal site serves the shared national office directory
const FIELD_OFFICES = { level: '626a41e552093d4768e64b14', type: '687df048256c87dc78f1a068' }; // upazila level · government field offices
const USER_AGENT = 'AkashSathi/1.0 (route planner: official hospital contact lookup)';
const CONCURRENCY = 6; // the health sites are separate hosts; each is asked about once
const refresh = process.argv.includes('--refresh');

mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The portal's pages start quickly but can trickle in for a minute or more. `until` stops reading as soon as the part needed has arrived
// (the menu with the contact link; the contact block before the shared hotline list), and whatever arrived within the time limit is used.
async function cached(url, kind, { until = null, limitMs = 30_000 } = {}) {
  const file = join(CACHE, `${createHash('sha1').update(url).digest('hex')}.${kind}`);
  // A cached copy that was cut off before the part needed is fetched again.
  if (!refresh && existsSync(file)) {
    const saved = readFileSync(file, 'utf8');
    if (!until || until.test(saved)) return saved;
  }
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    let text = '';
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest' }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (until?.test(text)) { controller.abort(); break; }
      }
    } catch (error) {
      if (!text || !(until?.test(text) || controller.signal.aborted)) { last = error; clearTimeout(timer); await sleep(1500); continue; }
    }
    clearTimeout(timer);
    if (!text) { last = new Error('empty response'); continue; }
    writeFileSync(file, text);
    await sleep(200);
    return text;
  }
  throw last;
}
const json = async (path) => JSON.parse(await cached(`${PORTAL}${path}`, 'json'));

// ---------- the directory walk ----------
async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index).catch((error) => ({ error: error.message }));
    }
  }));
  return results;
}

const pad = (value) => String(value).padStart(2, '0');
const catalogue = JSON.parse(readFileSync(join(ROOT, 'server', 'data', 'locations.json'), 'utf8'));
// Spelling-tolerant names: no "Sadar"/"Upazila", no chandrabindu or hasanta, and the Bangla letters that are often swapped made equal.
const norm = (text) => String(text ?? '').toLowerCase()
  .replace(/sadar|upazila|upazilla|thana|সদর|উপজেলা|\(.*?\)/g, '')
  .replace(/[ঁ্‌‍]/g, '').replace(/ড়/g, 'ড').replace(/ঢ়/g, 'ঢ').replace(/য়/g, 'য').replace(/[ীূ]/g, (c) => (c === 'ী' ? 'ি' : 'ু'))
  .replace(/[^a-zঀ-৿]+/g, '');

// --district=4209 limits a run to one district (by AkashSathi district code) for a quick check; its result is printed, not written.
const onlyDistrict = /^--district=(\d{4})$/.exec(process.argv.find((arg) => arg.startsWith('--district=')) ?? '')?.[1] ?? null;

const upazilas = [];
for (const division of await json('/ajax/get/division/list')) {
  for (const district of await json(`/ajax/get/district/${division._id}/list`)) {
    const districtCode = `${division.bbs_code}${pad(district.bbs_code)}`;
    if (onlyDistrict && districtCode !== onlyDistrict) continue;
    const inCatalogue = catalogue.locations.filter((item) => item.district === districtCode);
    for (const upazila of await json(`/ajax/get/upazilla/${district._id}/list`)) {
      // The portal's upazila BBS code when it has one; otherwise its English or Bangla name within the same district.
      const code = Number(upazila.bbs_code); // sometimes a number, sometimes text, sometimes missing
      const byCode = Number.isInteger(code) && code > 0 ? inCatalogue.find((item) => item.pcode === `${districtCode}${pad(code)}`) : null;
      const byName = inCatalogue.find((item) => norm(item.name) === norm(upazila.title_en) || (item.nameBn && norm(item.nameBn) === norm(upazila.title_bn)));
      upazilas.push({ portal: upazila, district: district.title_en, pcode: (byCode ?? byName)?.pcode ?? null });
    }
  }
}
console.log(`${upazilas.length} upazilas on the portal, ${upazilas.filter((u) => u.pcode).length} matched to AkashSathi's catalogue.`);

let done = 0;
const results = await pool(upazilas, async ({ portal, district, pcode }) => {
  const offices = await json(`/ajax/get/office-level/${FIELD_OFFICES.level}/offices?office_type_id=${FIELD_OFFICES.type}&loc_id=${portal._id}&loc_type=loc_upazila_id`);
  const office = (Array.isArray(offices) ? offices : []).find((item) => /^health\./.test(item.subdomain ?? '') || /স্বাস্থ্য কমপ্লেক্স/.test(item.title_bn ?? ''));
  done += 1;
  if (done % 25 === 0) process.stdout.write(`  ${done}/${upazilas.length}\n`);
  if (!office) return { pcode, district, upazila: portal.title_en, site: null };
  const site = `https://${office.subdomain ?? office.domain}`;
  // Read until the contact link, or the end of the menu's contact group ("যোগাযোগ ম্যাপ") on a site that has no contact page.
  const home = await cached(`${site}/`, 'html', {
    until: /href="[^"]*(?:static-pages|contact)[^"]*"[^>]*>\s*(?:অনলাইন যোগাযোগ|যোগাযোগ|অফিস যোগাযোগ)\s*<|যোগাযোগের? ম্যাপ/,
    limitMs: 75_000,
  });
  const links = [...home.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(([, href, text]) => ({ href, text: text.replace(/<[^>]+>/g, '').trim() }))
    .filter((link) => /^(অনলাইনে? যোগাযোগ|যোগাযোগ|অফিস যোগাযোগ)$/.test(link.text) && /static-pages|contact|\/pages\//.test(link.href));
  const contactPage = links[0] ? new URL(links[0].href, site).href : null;
  const numbers = contactPage
    ? officialNumbers(await cached(contactPage, 'html', { until: /<rt-renderer\s+encoded-content="[A-Za-z0-9+/=]+"/, limitMs: 60_000 }))
    : { mobile: null, landline: null, email: null, emergency: false };
  return { pcode, district, upazila: portal.title_en, site, contactPage, ...numbers };
});

if (onlyDistrict) {
  console.log(JSON.stringify(results, null, 1));
  process.exit(0);
}
const byPcode = {};
for (const result of results) if (result?.pcode && result.site) byPcode[result.pcode] = result;
const failed = results.filter((result) => result?.error).length;
writeFileSync(OUT, `${JSON.stringify({
  source: 'Government of Bangladesh national portal (bangladesh.gov.bd network): each upazila health complex\'s own contact page',
  fetchedAt: new Date().toISOString().slice(0, 10),
  upazilas: byPcode,
})}\n`);
const list = Object.values(byPcode);
console.log(`Wrote ${OUT}: ${list.length} health complex sites, ${list.filter((r) => r.mobile).length} with an official mobile, ${list.filter((r) => r.landline).length} with a landline, ${list.filter((r) => r.mobile || r.landline).length} with any number. ${failed} lookups failed (rerun to retry).`);
