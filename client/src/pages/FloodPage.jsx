import { useEffect, useRef, useState } from 'react';
import { digits, formatDhaka } from '../alert/format.js';
import { Icon } from '../components/Icon.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { usePolled } from '../hooks/usePolled.js';
import { useLanguage } from '../i18n/index.js';
import { request } from '../services/api.js';
import '../landing.css';
import './flood-page.css';

const REFRESH_MS = 5 * 60_000;

const TEXT = {
  en: {
    title: 'River levels and flood shelters',
    lead: "Measured river levels from FFWC's national gauges, matched to an upazila, with the nearest DDM-listed shelters. This is an observation service, not an official evacuation order.",
    live: 'Live gauges',
    demo: 'Demo view',
    demoBanner: 'DEMO DATA: illustrative gauges for the interface only. Nothing here creates an alert or is sent to anyone.',
    loading: 'Loading the latest river readings…',
    updated: 'Updated {time}',
    unavailable: 'Live FFWC data is not available yet. The background job may not have run, or the server is not configured. You can inspect the labelled demo.',
    error: 'Could not load the flood view.',
    retry: 'Try again',
    demoError: 'Could not load the demo view.',
    alerting: 'Areas at or near the danger level',
    approaching: 'Close to the danger level',
    above: 'Above the danger level',
    significantly: 'Well above the danger level',
    stations: 'Gauges read',
    unmatched: 'Gauges not matched to an upazila',
    empty: 'No gauge is currently in the approach band or above its danger level. This is not an all-clear: the river can rise after the next reading.',
    gauge: 'Gauge',
    danger: 'Danger level',
    difference: 'Difference from danger level',
    aboveBy: '{value} above',
    belowBy: '{value} below',
    rain24: 'Rain in the last 24 hours',
    rain3d: 'Rain in the last 3 days',
    rainMonth: 'Rain this month',
    shelters: 'Nearby DDM shelters',
    noShelters: 'No DDM shelter was matched within 50 km of this area.',
    shelterNote: 'Locations from DDM only. Occupancy and open/closed status are not published; check before travelling.',
    shelterStale: 'The shelter list may be out of date.',
    directions: 'Directions',
    methodTitle: 'What this page does and does not tell you',
    method: [
      "Each card is one upazila. The river level is FFWC's latest measurement at a named gauge, compared with FFWC's published danger level for that gauge.",
      '“Close to” means within 0.5 m below the danger level. FFWC does not publish an “approaching” class; this band is our alert rule.',
      "Shelters come from DDM's public list. Occupancy and open/closed status are not published, so check before you travel.",
      'This is not a flood forecast, a road report or an evacuation instruction. Follow FFWC bulletins, local authorities and the shelter staff.',
    ],
    sources: 'Sources',
    ffwc: 'FFWC river gauges',
    ddm: 'DDM flood shelters',
    staleData: 'This reading is older than the freshness window; it is shown for context and cannot create a new alert.',
  },
  bn: {
    title: 'নদীর পানির উচ্চতা ও বন্যা আশ্রয়কেন্দ্র',
    lead: 'এফএফডব্লিউসি-র জাতীয় গেইজে মাপা নদীর পানির উচ্চতা, উপজেলা অনুযায়ী সাজানো, সঙ্গে নিকটতম ডিডিএম-তালিকাভুক্ত আশ্রয়কেন্দ্র। এটি একটি পর্যবেক্ষণ সেবা, সরকারি সরিয়ে নেওয়ার নির্দেশ নয়।',
    live: 'সরাসরি গেইজ',
    demo: 'ডেমো দেখুন',
    demoBanner: 'ডেমো তথ্য: শুধু ইন্টারফেস দেখানোর জন্য নমুনা গেইজ। এখান থেকে কোনো সতর্কবার্তা তৈরি বা পাঠানো হয় না।',
    loading: 'সর্বশেষ নদীর পাঠ লোড হচ্ছে…',
    updated: 'হালনাগাদ {time}',
    unavailable: 'এফএফডব্লিউসি-র সরাসরি তথ্য এখনো পাওয়া যাচ্ছে না। পটভূমির কাজটি চালু হয়নি, অথবা সার্ভার কনফিগার করা নেই। লেবেল দেওয়া ডেমো দেখতে পারেন।',
    error: 'বন্যার পাতা লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
    demoError: 'ডেমো পাতা লোড করা যায়নি।',
    alerting: 'বিপদসীমার কাছে বা তার উপরে থাকা এলাকা',
    approaching: 'বিপদসীমার কাছে',
    above: 'বিপদসীমার উপরে',
    significantly: 'বিপদসীমার অনেক উপরে',
    stations: 'গেইজ পড়া হয়েছে',
    unmatched: 'উপজেলার সঙ্গে মেলানো যায়নি এমন গেইজ',
    empty: 'এই মুহূর্তে কোনো গেইজ বিপদসীমার কাছাকাছি বা তার উপরে নেই। এটি নিরাপদ থাকার নিশ্চয়তা নয়: পরের পাঠে পানি বাড়তে পারে।',
    gauge: 'গেইজ',
    danger: 'বিপদসীমা',
    difference: 'বিপদসীমার সঙ্গে পার্থক্য',
    aboveBy: '{value} উপরে',
    belowBy: '{value} নিচে',
    rain24: 'গত ২৪ ঘণ্টায় বৃষ্টি',
    rain3d: 'গত ৩ দিনে বৃষ্টি',
    rainMonth: 'এ মাসে বৃষ্টি',
    shelters: 'নিকটবর্তী ডিডিএম আশ্রয়কেন্দ্র',
    noShelters: 'এই এলাকার ৫০ কিমির মধ্যে কোনো ডিডিএম আশ্রয়কেন্দ্র মেলানো যায়নি।',
    shelterNote: 'অবস্থান শুধু ডিডিএম থেকে। কতজন আছে বা খোলা কিনা তা প্রকাশিত নয়; যাওয়ার আগে যাচাই করুন।',
    shelterStale: 'আশ্রয়কেন্দ্রের তালিকা পুরোনো হতে পারে।',
    directions: 'পথনির্দেশ',
    methodTitle: 'এই পাতা কী বলে, কী বলে না',
    method: [
      'প্রতিটি কার্ড একটি উপজেলা। নদীর উচ্চতা হলো নির্দিষ্ট গেইজে এফএফডব্লিউসি-র সর্বশেষ মাপ, যা ওই গেইজের প্রকাশিত বিপদসীমার সঙ্গে তুলনা করা হয়েছে।',
      '“কাছে” মানে বিপদসীমার ০.৫ মিটারের মধ্যে নিচে। এফএফডব্লিউসি “কাছাকাছি” শ্রেণি প্রকাশ করে না; এই সীমা আমাদের সতর্কতার নিয়ম।',
      'আশ্রয়কেন্দ্র ডিডিএমের সরকারি তালিকা থেকে। কতজন আছে বা খোলা কিনা তা প্রকাশিত নয়, তাই যাওয়ার আগে যাচাই করুন।',
      'এটি বন্যার পূর্বাভাস, রাস্তার প্রতিবেদন বা সরিয়ে নেওয়ার নির্দেশ নয়। এফএফডব্লিউসি-র বুলেটিন, স্থানীয় প্রশাসন ও আশ্রয়কেন্দ্রের দায়িত্বপ্রাপ্তদের নির্দেশনা মানুন।',
    ],
    sources: 'উৎস',
    ffwc: 'এফএফডব্লিউসি নদীর গেইজ',
    ddm: 'ডিডিএম বন্যা আশ্রয়কেন্দ্র',
    staleData: 'এই পাঠটি freshness সীমার চেয়ে পুরোনো; এটি শুধু প্রসঙ্গের জন্য দেখানো হচ্ছে এবং নতুন সতর্কবার্তা তৈরি করতে পারে না।',
  },
};

const STATUS = {
  en: { FRESH: 'Latest', PARTIAL: 'Partly updated', STALE: 'Outdated', UNAVAILABLE: 'Unavailable', DEMO: 'Demo' },
  bn: { FRESH: 'সর্বশেষ', PARTIAL: 'আংশিক হালনাগাদ', STALE: 'পুরোনো', UNAVAILABLE: 'পাওয়া যাচ্ছে না', DEMO: 'ডেমো' },
};

const LEVEL_CLASS = { APPROACHING: 'flood-level--1', ABOVE: 'flood-level--2', SIGNIFICANTLY_ABOVE: 'flood-level--3' };
const LEVEL_KEY = { APPROACHING: 'approaching', ABOVE: 'above', SIGNIFICANTLY_ABOVE: 'significantly' };

const metres = (value, t, lang) => (Number.isFinite(value) ? `${digits(String(value), lang)} ${t === TEXT.bn ? 'মি.' : 'm'}` : '—');
const millimetres = (value, t, lang) => (Number.isFinite(value) ? `${digits(String(value), lang)} ${t === TEXT.bn ? 'মিমি' : 'mm'}` : '—');

function difference(group, t, lang) {
  if (!Number.isFinite(group.aboveDangerM)) return '—';
  return group.aboveDangerM >= 0
    ? t.aboveBy.replace('{value}', metres(group.aboveDangerM, t, lang))
    : t.belowBy.replace('{value}', metres(Math.abs(group.aboveDangerM), t, lang));
}

function GroupCard({ group, lang, t }) {
  const lead = group.stations?.[0];
  return (
    <article className="flood-card">
      <header className="flood-card-head">
        <span className={`flood-level ${LEVEL_CLASS[group.classification] ?? ''}`}>{t[LEVEL_KEY[group.classification]] ?? group.classification}</span>
        <h3 lang={lang === 'bn' ? 'bn' : 'en'}>{lang === 'bn' ? group.nameBn ?? group.name : group.name}</h3>
        {Number.isFinite(group.lat) && Number.isFinite(group.lon) && (
          <a className="flood-map-link" href={`https://www.google.com/maps/dir/?api=1&destination=${group.lat},${group.lon}`} target="_blank" rel="noopener noreferrer">
            <Icon name="pin" size={15} />{t.directions}
          </a>
        )}
      </header>

      {lead && (
        <div className="flood-gauge">
          <p className="flood-gauge-name"><Icon name="drop" size={16} />{lead.name}{lead.river ? ` · ${lead.river}` : ''}</p>
          <dl className="flood-numbers">
            <div><dt>{t.gauge}</dt><dd>{metres(lead.waterLevelM, t, lang)}</dd></div>
            <div><dt>{t.danger}</dt><dd>{metres(lead.dangerLevelM, t, lang)}</dd></div>
            <div className="flood-difference"><dt>{t.difference}</dt><dd>{difference(group, t, lang)}</dd></div>
          </dl>
          <p className="flood-rain">
            {t.rain24}: {millimetres(lead.rainfall24hMm, t, lang)} · {t.rain3d}: {millimetres(lead.rainfall3dMm, t, lang)} · {t.rainMonth}: {millimetres(lead.rainfallMonthMm, t, lang)}
          </p>
          {lead.measuredAt && <p className="flood-measured">{t.updated.replace('{time}', formatDhaka(lead.measuredAt, lang))}</p>}
          {group.stations?.length > 1 && (
            <ul className="flood-other-gauges">
              {group.stations.slice(1).map((station) => (
                <li key={station.stationId}>{station.name}: {metres(station.waterLevelM, t, lang)} / {t.danger} {metres(station.dangerLevelM, t, lang)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="flood-shelters">
        <h4>{t.shelters}</h4>
        {group.shelters?.length ? (
          <ul>
            {group.shelters.map((shelter) => (
              <li key={shelter.id}>
                <span>{shelter.name}{shelter.upazila ? `, ${shelter.upazila}` : ''}</span>
                {Number.isFinite(shelter.distanceKm) && <span className="flood-shelter-distance">{digits(String(shelter.distanceKm), lang)} {lang === 'bn' ? 'কিমি' : 'km'}</span>}
                <a href={shelter.mapsUrl} target="_blank" rel="noopener noreferrer">{t.directions}</a>
              </li>
            ))}
          </ul>
        ) : <p>{t.noShelters}</p>}
        <p className="flood-note">{group.shelterStatus === 'STALE' ? `${t.shelterStale} ` : ''}{t.shelterNote}</p>
      </section>
    </article>
  );
}

export default function FloodPage() {
  const { lang } = useLanguage();
  const t = TEXT[lang] ?? TEXT.en;
  const [demo, setDemo] = useState(false);
  const firstLoad = useRef(true);
  const { data, error, loading, reload } = usePolled(
    (signal) => request(`/flood/${demo ? 'demo' : 'status'}`, { signal }),
    REFRESH_MS,
  );

  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    reload();
  }, [demo, reload]);

  const groups = data?.groups?.filter((group) => group.level > 0) ?? [];
  const summary = data?.summary;
  const status = data?.status ?? 'UNAVAILABLE';

  return (
    <main className="flood-page">
      <Navbar />
      <div className="flood-shell">
        <header className="flood-hero">
          <p className="flood-kicker"><Icon name="drop" size={17} />FloodSense · FFWC + DDM</p>
          <h1>{t.title}</h1>
          <p className="flood-lead">{t.lead}</p>
          <div className="flood-toolbar">
            <span className={`flood-status flood-status--${status.toLowerCase()}`}>{STATUS[lang]?.[status] ?? status}</span>
            {data?.fetchedAt && <span className="flood-updated">{t.updated.replace('{time}', formatDhaka(data.fetchedAt, lang))}</span>}
            <button type="button" className={`flood-toggle${demo ? ' is-on' : ''}`} aria-pressed={demo} onClick={() => setDemo((value) => !value)}>
              {demo ? t.live : t.demo}
            </button>
            <button type="button" className="flood-toggle" onClick={reload}>{t.retry}</button>
          </div>
          {demo && <p className="flood-banner flood-banner--demo">{t.demoBanner}</p>}
        </header>

        {loading && !data && <p className="flood-loading" role="status">{t.loading}</p>}
        {error && <p className="flood-banner flood-banner--error">{demo ? t.demoError : t.error} {error}</p>}
        {!loading && !error && data && status === 'UNAVAILABLE' && !demo && <p className="flood-banner">{t.unavailable}</p>}
        {!loading && !error && data && status === 'STALE' && !demo && <p className="flood-banner">{t.staleData}</p>}

        {summary && (
          <section className="flood-summary" aria-label={t.alerting}>
            <div><strong>{digits(String(summary.alertingAreas), lang)}</strong><span>{t.alerting}</span></div>
            <div><strong>{digits(String(summary.approaching), lang)}</strong><span>{t.approaching}</span></div>
            <div><strong>{digits(String(summary.above), lang)}</strong><span>{t.above}</span></div>
            <div><strong>{digits(String(summary.significantlyAbove), lang)}</strong><span>{t.significantly}</span></div>
            <div><strong>{digits(String(summary.observedStations), lang)}</strong><span>{t.stations}</span></div>
          </section>
        )}

        {data && groups.length === 0 && !error && (demo || status !== 'UNAVAILABLE') && (
          <p className="flood-empty">{t.empty}</p>
        )}

        <section className="flood-grid">
          {groups.map((group) => <GroupCard key={group.key} group={group} lang={lang} t={t} />)}
        </section>

        <section className="flood-method">
          <h2>{t.methodTitle}</h2>
          <ul>{t.method.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="flood-sources">
            {t.sources}: <a href="https://ffwc.gov.bd/" target="_blank" rel="noopener noreferrer">{t.ffwc}</a> · <a href="https://rapid.ddm.gov.bd/service/shelter_info" target="_blank" rel="noopener noreferrer">{t.ddm}</a>
          </p>
        </section>
      </div>
    </main>
  );
}
