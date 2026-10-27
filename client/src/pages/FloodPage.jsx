import { digits, formatDhaka } from '../alert/format.js';
import { Icon } from '../components/Icon.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { usePolled } from '../hooks/usePolled.js';
import { errorText, useLanguage } from '../i18n/index.js';
import { navigate, ROUTES, usePathname } from '../lib/router.js';
import { request } from '../services/api.js';
import '../landing.css';
import './flood-page.css';

const REFRESH_MS = 5 * 60_000;

const TEXT = {
  en: {
    title: 'River levels and flood shelters',
    lead: "Measured river levels from FFWC's national gauges, matched to local areas, with nearby DDM-listed shelters. This is an observation service, not an official evacuation order.",
    skip: 'Skip to content',
    feed: 'Data view',
    live: 'Live gauges',
    demo: 'Demo view',
    demoBanner: 'DEMO DATA: illustrative gauges for the interface only. Nothing here creates an alert or is sent to anyone.',
    loading: 'Loading the latest river readings…',
    refreshing: 'Refreshing…',
    refreshFailed: 'Refresh failed',
    refreshError: 'Could not refresh. The last loaded information may be out of date.',
    refresh: 'Refresh',
    updated: 'Updated {time} (Bangladesh time)',
    unavailable: 'Live FFWC data is not available yet. The background job may not have run, or the server is not configured. You can inspect the labelled demo.',
    error: 'Could not load the flood view.',
    retry: 'Try again',
    demoError: 'Could not load the demo view.',
    overview: 'At a glance',
    overviewNote: 'A summary of the available gauge readings',
    areasTitle: 'Areas near or above danger level',
    areasNote: 'Select a location or shelter for directions. Check conditions before travelling.',
    alerting: 'Areas at or near the danger level',
    approaching: 'Close to the danger level',
    above: 'Above the danger level',
    significantly: 'Well above the danger level',
    stations: 'Matched gauges',
    unmatchedNote: 'Gauges not matched to an area: {count}. They are not included in this summary or the area list.',
    empty: 'No matched areas are listed near or above their danger levels. This is not an all-clear: the river can rise after the next reading.',
    gauge: 'Water level',
    upazila: 'Upazila',
    district: 'District',
    danger: 'Danger level',
    difference: 'Difference from danger level',
    aboveBy: '{value} above',
    belowBy: '{value} below',
    rain24: 'Rain in the last 24 hours',
    rain3d: 'Rain in the last 3 days',
    rainMonth: 'Rain this month',
    shelters: 'Nearby DDM shelters',
    noShelters: 'No DDM shelter was matched within 50 km of this area.',
    sheltersUnavailable: 'DDM shelter information is not available right now.',
    sheltersNoLocation: 'Nearby shelters cannot be matched because this area has no coordinates.',
    shelterNote: 'Locations from DDM only. Occupancy and open/closed status are not published; check before travelling.',
    shelterStale: 'The shelter list may be out of date.',
    directions: 'Directions',
    directionsTo: 'Directions to {name}',
    viewArea: 'View area',
    fromArea: '{distance} km from area centre',
    methodTitle: 'What this page does and does not tell you',
    method: [
      "Each card is one matched area, usually an upazila or, when necessary, a district. The river level is FFWC's latest measurement at a named gauge, compared with FFWC's published danger level for that gauge.",
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
    lead: 'এফএফডব্লিউসি-র জাতীয় গেইজে মাপা নদীর পানির উচ্চতা স্থানীয় এলাকা অনুযায়ী সাজানো, সঙ্গে নিকটবর্তী ডিডিএম-তালিকাভুক্ত আশ্রয়কেন্দ্র। এটি একটি পর্যবেক্ষণ সেবা, সরকারি সরিয়ে নেওয়ার নির্দেশ নয়।',
    skip: 'মূল অংশে যান',
    feed: 'তথ্যের ধরন',
    live: 'সরাসরি গেইজ',
    demo: 'ডেমো দেখুন',
    demoBanner: 'ডেমো তথ্য: শুধু ইন্টারফেস দেখানোর জন্য নমুনা গেইজ। এখান থেকে কোনো সতর্কবার্তা তৈরি বা পাঠানো হয় না।',
    loading: 'সর্বশেষ নদীর পাঠ লোড হচ্ছে…',
    refreshing: 'হালনাগাদ হচ্ছে…',
    refreshFailed: 'হালনাগাদ করা যায়নি',
    refreshError: 'হালনাগাদ করা যায়নি। আগে লোড করা তথ্য পুরোনো হতে পারে।',
    refresh: 'হালনাগাদ করুন',
    updated: 'হালনাগাদ {time} (বাংলাদেশ সময়)',
    unavailable: 'এফএফডব্লিউসি-র সরাসরি তথ্য এখনো পাওয়া যাচ্ছে না। পটভূমির কাজটি চালু হয়নি, অথবা সার্ভার কনফিগার করা নেই। লেবেল দেওয়া ডেমো দেখতে পারেন।',
    error: 'বন্যার পাতা লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
    demoError: 'ডেমো পাতা লোড করা যায়নি।',
    overview: 'এক নজরে',
    overviewNote: 'পাওয়া গেইজের পাঠের সারসংক্ষেপ',
    areasTitle: 'বিপদসীমার কাছে বা উপরে থাকা এলাকা',
    areasNote: 'পথনির্দেশ দেখতে এলাকা বা আশ্রয়কেন্দ্র বেছে নিন। যাওয়ার আগে পরিস্থিতি যাচাই করুন।',
    alerting: 'বিপদসীমার কাছে বা তার উপরে থাকা এলাকা',
    approaching: 'বিপদসীমার কাছে',
    above: 'বিপদসীমার উপরে',
    significantly: 'বিপদসীমার অনেক উপরে',
    stations: 'এলাকার সঙ্গে মেলানো গেইজ',
    unmatchedNote: 'এলাকার সঙ্গে মেলানো যায়নি এমন গেইজ: {count}টি। এগুলো এই সারসংক্ষেপ বা নিচের তালিকায় নেই।',
    empty: 'বিপদসীমার কাছাকাছি বা উপরে মেলানো কোনো এলাকা তালিকায় নেই। এটি নিরাপদ থাকার নিশ্চয়তা নয়: পরের পাঠে পানি বাড়তে পারে।',
    gauge: 'পানির উচ্চতা',
    upazila: 'উপজেলা',
    district: 'জেলা',
    danger: 'বিপদসীমা',
    difference: 'বিপদসীমার সঙ্গে পার্থক্য',
    aboveBy: '{value} উপরে',
    belowBy: '{value} নিচে',
    rain24: 'গত ২৪ ঘণ্টায় বৃষ্টি',
    rain3d: 'গত ৩ দিনে বৃষ্টি',
    rainMonth: 'এ মাসে বৃষ্টি',
    shelters: 'নিকটবর্তী ডিডিএম আশ্রয়কেন্দ্র',
    noShelters: 'এই এলাকার ৫০ কিমির মধ্যে কোনো ডিডিএম আশ্রয়কেন্দ্র মেলানো যায়নি।',
    sheltersUnavailable: 'ডিডিএম আশ্রয়কেন্দ্রের তথ্য এখন পাওয়া যাচ্ছে না।',
    sheltersNoLocation: 'এলাকার স্থানাঙ্ক না থাকায় কাছের আশ্রয়কেন্দ্র মেলানো যায়নি।',
    shelterNote: 'অবস্থান শুধু ডিডিএম থেকে। কতজন আছে বা খোলা কিনা তা প্রকাশিত নয়; যাওয়ার আগে যাচাই করুন।',
    shelterStale: 'আশ্রয়কেন্দ্রের তালিকা পুরোনো হতে পারে।',
    directions: 'পথনির্দেশ',
    directionsTo: '{name}-এ যাওয়ার পথনির্দেশ',
    viewArea: 'এলাকা দেখুন',
    fromArea: 'এলাকার কেন্দ্র থেকে {distance} কিমি',
    methodTitle: 'এই পাতা কী বলে, কী বলে না',
    method: [
      'প্রতিটি কার্ড একটি এলাকা, সাধারণত উপজেলা বা প্রয়োজনে জেলা। নদীর উচ্চতা হলো নির্দিষ্ট গেইজে এফএফডব্লিউসি-র সর্বশেষ মাপ, যা ওই গেইজের প্রকাশিত বিপদসীমার সঙ্গে তুলনা করা হয়েছে।',
      '“কাছে” মানে বিপদসীমার ০.৫ মিটারের মধ্যে নিচে। এফএফডব্লিউসি “কাছাকাছি” শ্রেণি প্রকাশ করে না; এই সীমা আমাদের সতর্কতার নিয়ম।',
      'আশ্রয়কেন্দ্র ডিডিএমের সরকারি তালিকা থেকে। কতজন আছে বা খোলা কিনা তা প্রকাশিত নয়, তাই যাওয়ার আগে যাচাই করুন।',
      'এটি বন্যার পূর্বাভাস, রাস্তার প্রতিবেদন বা সরিয়ে নেওয়ার নির্দেশ নয়। এফএফডব্লিউসি-র বুলেটিন, স্থানীয় প্রশাসন ও আশ্রয়কেন্দ্রের দায়িত্বপ্রাপ্তদের নির্দেশনা মানুন।',
    ],
    sources: 'উৎস',
    ffwc: 'এফএফডব্লিউসি নদীর গেইজ',
    ddm: 'ডিডিএম বন্যা আশ্রয়কেন্দ্র',
    staleData: 'এই পাঠটি হালনাগাদের নির্ধারিত সময়সীমার চেয়ে পুরোনো; এটি শুধু প্রসঙ্গের জন্য দেখানো হচ্ছে এবং নতুন সতর্কবার্তা তৈরি করতে পারে না।',
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
  const hasLocation = Number.isFinite(group.lat) && Number.isFinite(group.lon);
  return (
    <article className={`flood-card flood-card--${group.level}`}>
      <header className="flood-card-head">
        <div>
          <span className={`flood-level ${LEVEL_CLASS[group.classification] ?? ''}`}><Icon name={group.level === 3 ? 'critical' : group.level === 2 ? 'warning' : 'info'} size={14} />{t[LEVEL_KEY[group.classification]] ?? group.classification}</span>
          <h3 lang={lang === 'bn' && group.nameBn ? 'bn' : 'en'}>{lang === 'bn' ? group.nameBn ?? group.name : group.name}</h3>
          {group.scope && <p className="flood-area-scope">{t[group.scope] ?? group.scope}</p>}
        </div>
        {hasLocation && (
          <a className="flood-map-link" href={`https://www.google.com/maps/dir/?api=1&destination=${group.lat},${group.lon}`} target="_blank" rel="noopener noreferrer">
            <Icon name="pin" size={16} />{t.viewArea}
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
          <dl className="flood-rain">
            <div><dt>{t.rain24}</dt><dd>{millimetres(lead.rainfall24hMm, t, lang)}</dd></div>
            <div><dt>{t.rain3d}</dt><dd>{millimetres(lead.rainfall3dMm, t, lang)}</dd></div>
            <div><dt>{t.rainMonth}</dt><dd>{millimetres(lead.rainfallMonthMm, t, lang)}</dd></div>
          </dl>
          {lead.measuredAt && <p className="flood-measured"><Icon name="clock" size={14} />{t.updated.replace('{time}', formatDhaka(lead.measuredAt, lang))}</p>}
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
        <h4><Icon name="pin" size={17} />{t.shelters}</h4>
        {group.shelters?.length ? (
          <ul>
            {group.shelters.map((shelter) => (
              <li key={shelter.id}>
                <span className="flood-shelter-name">{shelter.name}{shelter.upazila ? `, ${shelter.upazila}` : ''}{Number.isFinite(shelter.distanceKm) && <small>{t.fromArea.replace('{distance}', digits(String(shelter.distanceKm), lang))}</small>}</span>
                {shelter.mapsUrl && <a href={shelter.mapsUrl} target="_blank" rel="noopener noreferrer" aria-label={t.directionsTo.replace('{name}', shelter.name)}>{t.directions}<Icon name="arrow" size={14} /></a>}
              </li>
            ))}
          </ul>
        ) : <p>{group.shelterStatus === 'UNAVAILABLE' ? t.sheltersUnavailable : !hasLocation ? t.sheltersNoLocation : t.noShelters}</p>}
        <p className="flood-note">{group.shelterStatus === 'STALE' ? `${t.shelterStale} ` : ''}{t.shelterNote}</p>
      </section>
    </article>
  );
}

export default function FloodPage() {
  const { lang } = useLanguage();
  const t = TEXT[lang] ?? TEXT.en;
  const demo = usePathname().replace(/\/+$/, '') === ROUTES.floodDemo;
  // Keep the two feeds separate so switching views can never label demo readings as live (or vice versa).
  const liveFeed = usePolled((signal) => request('/flood/status', { signal }), REFRESH_MS, { enabled: !demo });
  const demoFeed = usePolled((signal) => request('/flood/demo', { signal }), REFRESH_MS, { enabled: demo });
  const { data, error, loading, reload } = demo ? demoFeed : liveFeed;

  const groups = data?.groups?.filter((group) => group.level > 0) ?? [];
  const summary = data?.status !== 'UNAVAILABLE' ? data?.summary : null;
  const status = data?.status ?? 'UNAVAILABLE';

  return (
    <div className="flood-page" lang={lang}>
      <a className="skip-link" href="#flood-main">{t.skip}</a>
      <Navbar />
      <main id="flood-main" className="flood-shell">
        <header className="flood-hero">
          <div className="flood-hero-copy">
            <p className="flood-kicker"><span><Icon name="drop" size={18} /></span>FloodSense <i /> FFWC + DDM</p>
            <h1>{t.title}</h1>
            <p className="flood-lead">{t.lead}</p>
          </div>
          <div className="flood-toolbar">
            <div className="flood-feed-head">
              <span>{t.feed}</span>
              <span className={`flood-status flood-status--${error ? 'error' : data ? status.toLowerCase() : 'loading'}`} aria-live="polite">
                {loading && data ? t.refreshing : error ? t.refreshFailed : data ? (STATUS[lang]?.[status] ?? status) : t.loading}
              </span>
            </div>
            <div className="flood-mode" role="group" aria-label={t.feed}>
              <button type="button" aria-pressed={!demo} onClick={() => { if (demo) navigate(ROUTES.flood); }}>{t.live}</button>
              <button type="button" aria-pressed={demo} onClick={() => { if (!demo) navigate(ROUTES.floodDemo); }}>{t.demo}</button>
            </div>
            <div className="flood-feed-foot">
              <span className="flood-updated">{data?.fetchedAt ? t.updated.replace('{time}', formatDhaka(data.fetchedAt, lang)) : 'FFWC + DDM'}</span>
              <button type="button" className="flood-refresh" onClick={reload} disabled={loading}><Icon name="refresh" size={15} />{t.refresh}</button>
            </div>
          </div>
        </header>

        {demo && <p className="flood-banner flood-banner--demo"><Icon name="info" size={19} />{t.demoBanner}</p>}
        {!data && !error && <p className="flood-loading" role="status"><Icon name="drop" size={20} />{t.loading}</p>}
        {error && <p className="flood-banner flood-banner--error" role="alert"><Icon name="warning" size={19} /><span>{data ? t.refreshError : demo ? t.demoError : t.error} {errorText(error, lang)}</span></p>}
        {!loading && !error && data && status === 'UNAVAILABLE' && !demo && <p className="flood-banner">{t.unavailable}</p>}
        {!loading && !error && data && status === 'STALE' && !demo && <p className="flood-banner">{t.staleData}</p>}

        {summary && (
          <section className="flood-overview" aria-labelledby="flood-overview-title">
            <div className="flood-section-heading">
              <div><p className="flood-section-kicker">FFWC / DDM</p><h2 id="flood-overview-title">{t.overview}</h2></div>
              <p>{t.overviewNote}</p>
            </div>
            <dl className="flood-summary">
              <div><dt>{t.alerting}</dt><dd>{digits(String(summary.alertingAreas), lang)}</dd></div>
              <div><dt>{t.approaching}</dt><dd>{digits(String(summary.approaching), lang)}</dd></div>
              <div><dt>{t.above}</dt><dd>{digits(String(summary.above), lang)}</dd></div>
              <div><dt>{t.significantly}</dt><dd>{digits(String(summary.significantlyAbove), lang)}</dd></div>
              <div><dt>{t.stations}</dt><dd>{digits(String(summary.observedStations), lang)}</dd></div>
            </dl>
            {summary.unmatchedStations > 0 && <p className="flood-unmatched"><Icon name="info" size={16} />{t.unmatchedNote.replace('{count}', digits(String(summary.unmatchedStations), lang))}</p>}
          </section>
        )}

        {data && (demo || status !== 'UNAVAILABLE') && (
          <section className="flood-areas" aria-labelledby="flood-areas-title">
            <div className="flood-section-heading">
              <div><p className="flood-section-kicker">FloodSense</p><h2 id="flood-areas-title">{t.areasTitle}</h2></div>
              <p>{t.areasNote}</p>
            </div>
            {groups.length === 0 ? <p className="flood-empty"><Icon name="info" size={20} />{t.empty}</p> : (
              <div className="flood-grid">
                {groups.map((group) => <GroupCard key={group.key} group={group} lang={lang} t={t} />)}
              </div>
            )}
          </section>
        )}

        <section className="flood-method">
          <div><p className="flood-section-kicker">FloodSense</p><h2>{t.methodTitle}</h2></div>
          <div>
            <ul>{t.method.map((line) => <li key={line}>{line}</li>)}</ul>
            <p className="flood-sources">
              {t.sources}: <a href="https://ffwc.gov.bd/" target="_blank" rel="noopener noreferrer">{t.ffwc}</a> · <a href="https://rapid.ddm.gov.bd/service/shelter_info" target="_blank" rel="noopener noreferrer">{t.ddm}</a>
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
