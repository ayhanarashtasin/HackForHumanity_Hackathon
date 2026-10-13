import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { RoutePlanner, WeatherSummary } from '../components/RoutePlanner.jsx';
import { usePolled } from '../hooks/usePolled.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { containsPoint } from '../lib/locate.js';
import { placesFor } from '../lib/neighbourhoods.js';
import { areasAlongRoute, routeParent } from '../lib/routeAreas.js';
import { regionWeather, routeLightning, routeRegions } from '../lib/routeHierarchy.js';
import { resolveSelection } from '../lib/series.js';
import { formatBst, formatDay, stepIndexAt, toMs } from '../lib/time.js';
import { loadCatalogue, weatherApi } from '../services/weatherApi.js';
import '../landing.css';
import './route-page.css';

const ROUTE_INTERVAL = 5 * 60_000;
const DAILY_INTERVAL = 30 * 60_000;
const OUTLOOK_DAYS = 3;
const BST_OFFSET_MS = 6 * 60 * 60_000;

async function fetchJson(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Could not load ${path}.`);
  return response.json();
}

function endpointCard(place, boundaries, catalogue, progress) {
  if (!place) return null;
  const area = catalogue.areas?.find((item) => item.id === place.pcode);
  const location = catalogue.locations.find((item) => item.pcode === place.pcode);
  const pid = area?.parentPid ?? location?.pid
    ?? boundaries?.features.find((item) => containsPoint(item.geometry, place.lon, place.lat))?.properties.pid;
  return pid ? routeParent(pid, [place.lon, place.lat], catalogue, progress) : null;
}

function mergeEndpoints(parents, routeData, boundaries, catalogue) {
  const result = parents.map((parent) => ({ ...parent, areas: [...parent.areas], places: [...parent.places] }));
  const endpoints = [
    { place: routeData.places.start, progress: 0 },
    { place: routeData.places.end, progress: 1 },
  ];
  const ids = [];
  for (const { place, progress } of endpoints) {
    const card = endpointCard(place, boundaries, catalogue, progress);
    ids.push(card?.id);
    if (!card) continue;
    const existing = result.find((item) => item.id === card.id);
    const selectedPlace = place.level === 'neighbourhood' ? place : null;
    if (existing) {
      if (selectedPlace && !existing.places.some((item) => item.id === selectedPlace.id)) existing.places.push(selectedPlace);
      existing.progress = progress;
    } else {
      if (selectedPlace) card.places.push(selectedPlace);
      if (progress === 0) result.unshift(card);
      else result.push(card);
    }
  }

  const [startId, endId] = ids;
  if (startId && startId === endId) {
    const shared = result.find((item) => item.id === startId);
    if (shared) {
      shared.progress = 0;
      result.push({ ...shared, progress: 1, areas: [...shared.areas], places: [...shared.places] });
    }
  }
  const sorted = result.sort((a, b) => a.progress - b.progress);
  if (startId && sorted[0]?.id === startId) sorted[0].endpointPlace = routeData.places.start;
  if (endId && sorted.length > 1 && sorted.at(-1).id === endId) sorted.at(-1).endpointPlace = routeData.places.end;
  return sorted;
}

const cardPlace = (card) => card.endpointPlace ?? card;
const placeName = (item, lang, tr) => lang === 'bn' ? item.nameBn || tr(item.name) : item.name;
const value = (amount, number, suffix = '', decimals = 0) => Number.isFinite(amount) ? `${number(amount.toFixed(decimals))}${suffix}` : '–';

function cardWeather(parent, routeData, snapshot, catalogue, lang) {
  const resolved = resolveSelection({ level: parent.level ?? 'polygon', id: parent.id }, snapshot, catalogue, lang);
  const arrivalMs = routeData.places.checkedAt + routeData.result.durationMinutes * 60_000 * parent.progress;
  const index = snapshot?.steps?.length ? stepIndexAt(snapshot.steps, arrivalMs) : -1;
  const at = (key) => index >= 0 ? resolved?.series?.[key]?.[index] ?? null : null;
  return { arrivalMs, temp: at('temp'), hi: at('hi'), rf: at('rf'), wg: at('wg'), ts: snapshot?.thunderSource ? at('ts') : null };
}

const THUNDER = ['None', 'Low', 'Moderate', 'High'];

function WeatherValues({ weather, tr, number, regional = false }) {
  return (
    <>
      <dl className="route-weather-values">
        <div><dt>{tr(regional ? 'Average temperature' : 'Temperature')}</dt><dd>{value(weather.temp, number, tr('°C'), 1)}</dd></div>
        <div><dt>{tr(regional ? 'Peak heat index' : 'Heat index')}</dt><dd>{value(weather.hi, number, tr('°C'), 1)}</dd></div>
        <div><dt>{tr(regional ? 'Peak rain' : 'Rainfall')}</dt><dd>{value(weather.rf, number, ` ${tr('mm')}`, 1)}</dd></div>
        <div><dt>{tr(regional ? 'Strongest wind' : 'Wind')}</dt><dd>{value(weather.wg, number, ` ${tr('km/h')}`)}</dd></div>
        <div className="route-thunder"><dt><Icon name="bolt" size={15} /> {tr(regional ? 'Highest thunderstorm risk' : 'Thunderstorm risk')}</dt><dd>{Number.isFinite(weather.ts) ? tr(THUNDER[Math.round(weather.ts)] ?? 'Data not available') : tr('Data not available')}</dd></div>
      </dl>
      {![weather.temp, weather.hi, weather.rf, weather.wg, weather.ts].some(Number.isFinite) && <p className="route-weather-unavailable">{tr('Forecast unavailable at this time.')}</p>}
    </>
  );
}

function LightningValues({ stops, lightningState, tr, number }) {
  const info = routeLightning(stops, lightningState.error ? null : lightningState.data);
  const single = info?.items.length === 1 ? info.items[0] : null;
  const status = !info ? tr(lightningState.error ? 'Lightning updates are unavailable right now.' : 'Checking for lightning…')
    : tr(info.state === 'reported' ? 'Lightning reported near this part of your route.'
      : info.state === 'none' ? 'No lightning reported in available checks.'
        : info.state === 'no-coverage' ? 'No lightning checks near this part of your route.' : 'Lightning information is incomplete or out of date.');
  return (
    <div className="route-lightning">
      <p className="route-lightning-label"><Icon name="bolt" size={16} /> {tr('Lightning nearby')}</p>
      <strong>{status}</strong>
      {single?.state === 'reported' && Number.isFinite(single.count) && <span>{tr('Recorded in this check: {n}', { n: number(single.count) })}</span>}
      {single?.sampledAt && <small>{tr('Last checked: {time}', { time: formatBst(toMs(single.sampledAt)) })}</small>}
      {info?.state === 'reported' && info.items.some((item) => !['reported', 'none'].includes(item.state)) && <small>{tr('Other nearby checks are missing or out of date.')}</small>}
    </div>
  );
}

function roleOf(index, total, tr) {
  if (total === 1) return `${tr('Start')} · ${tr('Destination')}`;
  return index === 0 ? tr('Start') : index === total - 1 ? tr('Destination') : tr('On the way');
}

function RouteRegion({ group, index, total, level, routeData, snapshot, catalogue, lightningState, lang, tr, number }) {
  const arrivalMs = routeData.places.checkedAt + routeData.result.durationMinutes * 60_000 * group.progress;
  const weather = regionWeather(group, level, snapshot, catalogue, arrivalMs);
  const children = group.children.map((item) => placeName(item, lang, tr));
  const visible = children.slice(0, 4);
  return (
    <li className={`route-stop${index === 0 ? ' route-stop--start' : ''}${index === total - 1 ? ' route-stop--destination' : ''}`}>
      <span className="route-stop-marker" aria-hidden="true">{number(index + 1)}</span>
      <article className="route-stop-content">
        <div className="route-stop-topline"><span>{roleOf(index, total, tr)} · {tr(level === 'division' ? 'Division' : 'District')}</span><time dateTime={new Date(arrivalMs).toISOString()}>{formatBst(arrivalMs)}</time></div>
        <h3>{placeName(group, lang, tr)}</h3>
        <p className="route-stop-caption">{tr(level === 'division' ? '{n} districts on this stretch' : '{n} upazilas or thanas on this stretch', { n: number(children.length) })}</p>
        <p className="route-stop-places">{visible.join(' → ')}{children.length > visible.length && ` · ${tr('and {n} more', { n: number(children.length - visible.length) })}`}</p>
        <p className="route-weather-label">{tr('Weather along this stretch')}</p>
        <WeatherValues weather={weather} tr={tr} number={number} regional />
        <LightningValues stops={group.stops} lightningState={lightningState} tr={tr} number={number} />
      </article>
    </li>
  );
}

function RouteWeather({ parent, index, total, routeData, snapshot, catalogue, lightningState, lang, tr, number }) {
  const weather = cardWeather(parent, routeData, snapshot, catalogue, lang);
  const nearby = parent.places.filter((place) => place.id !== parent.endpointPlace?.id);
  return (
    <li className={`route-stop${index === 0 ? ' route-stop--start' : ''}${index === total - 1 ? ' route-stop--destination' : ''}`}>
      <span className="route-stop-marker" aria-hidden="true">{number(index + 1)}</span>
      <article className="route-stop-content">
        <div className="route-stop-topline"><span>{roleOf(index, total, tr)} · {tr('Upazila / thana')}</span><time dateTime={new Date(weather.arrivalMs).toISOString()}>{formatBst(weather.arrivalMs)}</time></div>
        <h3>{placeName(cardPlace(parent), lang, tr)}</h3>
        {parent.endpointPlace && parent.endpointPlace.name !== parent.name && <p className="route-stop-caption">{tr('Forecast from {name}', { name: placeName(parent, lang, tr) })}</p>}
        <p className="route-weather-label">{tr('Weather when you arrive')}</p>
        <WeatherValues weather={weather} tr={tr} number={number} />
        <LightningValues stops={[parent]} lightningState={lightningState} tr={tr} number={number} />
        {nearby.length > 0 && <p className="route-stop-places">{tr('Nearby places')}: {nearby.map((place) => placeName(place, lang, tr)).join(', ')}</p>}
      </article>
    </li>
  );
}

function destinationOutlook(card, daily, snapshot, catalogue, lang, nowMs = Date.now()) {
  if (!card || !daily?.days?.length) return null;
  const resolved = resolveSelection({ level: card.level ?? 'polygon', id: card.id }, snapshot, catalogue, lang);
  const pcode = resolved?.dailyPcode ?? resolved?.members?.[0]?.pcode;
  const values = pcode && daily.locations?.[pcode];
  if (!values) return null;
  const today = new Date(nowMs + BST_OFFSET_MS).toISOString().slice(0, 10);
  const days = daily.days.map((day, index) => ({ day, index }))
    .filter(({ day }) => day.slice(0, 10) > today).slice(0, OUTLOOK_DAYS)
    .map(({ day, index }) => ({ day, tmin: values.tmin?.[index] ?? null, tmax: values.tmax?.[index] ?? null, rf: values.rf?.[index] ?? null, ws: values.ws?.[index] ?? null }));
  return days.length ? { days, stale: daily.sources?.bmd?.status === 'stale' } : null;
}

function DestinationOutlook({ outlook, tr, number }) {
  if (!outlook) return null;
  return (
    <section className="route-outlook" aria-label={tr('Weather for the next 3 days')}>
      <h4>{tr('Weather for the next 3 days')}</h4>
      <ul>{outlook.days.map((day) => (
        <li key={day.day}>
          <Icon name={day.rf > 0 ? 'rain' : 'sun'} size={18} />
          <strong>{formatDay(toMs(day.day))}</strong>
          <span>{value(day.tmin, number, '°')} – {value(day.tmax, number, tr('°C'))}</span>
          <small>{tr('Rain')} {value(day.rf, number, ` ${tr('mm')}`, 1)} · {tr('Wind')} {value(day.ws, number, ` ${tr('km/h')}`)}</small>
        </li>
      ))}</ul>
      {outlook.stale && <small className="route-outlook-note">{tr('This daily forecast is stale.')}</small>}
    </section>
  );
}

function durationText(minutes, tr) {
  const hours = Math.floor(minutes / 60);
  return hours ? tr('{hours} h {minutes} min', { hours, minutes: minutes % 60 }) : tr('{minutes} min', { minutes });
}

function RouteSwitch({ shortest, alternative, showingAlternative, onToggle, tr, number }) {
  const shown = showingAlternative ? alternative : shortest;
  return (
    <section className="route-options panel" aria-label={tr('Alternative route')}>
      <header><strong>{tr(showingAlternative ? 'Alternative route' : 'Shortest route')}</strong><small>{number(shown.distanceKm.toFixed(1))} {tr('km')} · {durationText(shown.durationMinutes, tr)}</small></header>
      {alternative ? (
        <button type="button" className="route-alt-button" aria-pressed={showingAlternative} onClick={onToggle}>
          <Icon name="route" size={18} /><span>{tr(showingAlternative ? 'Back to shortest route' : 'Alternative route')}<small>{number((showingAlternative ? shortest : alternative).distanceKm.toFixed(1))} {tr('km')} · {durationText((showingAlternative ? shortest : alternative).durationMinutes, tr)}</small></span>
        </button>
      ) : <p className="route-options-note">{tr('Only one road route was found between these places.')}</p>}
    </section>
  );
}

export default function RoutePage() {
  const { tr, lang, number } = useLanguage(MAP);
  const [catalogue, setCatalogue] = useState(null);
  const [boundaries, setBoundaries] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState(null);
  const [showingAlternative, setShowingAlternative] = useState(false);
  const [level, setLevel] = useState('division');
  const resultRef = useRef(null);
  const alternative = useMemo(() => {
    const first = search?.result.alternatives?.[0];
    return first ? { ...first, start: search.result.start, end: search.result.end } : null;
  }, [search]);
  const routeData = useMemo(() => search
    ? { ...search, result: showingAlternative && alternative ? alternative : search.result }
    : null, [search, alternative, showingAlternative]);
  const snapshot = usePolled(weatherApi.snapshot, ROUTE_INTERVAL).data;
  const daily = usePolled(weatherApi.daily, DAILY_INTERVAL).data;
  const lightningState = usePolled(weatherApi.lightningSummaries, ROUTE_INTERVAL, { enabled: Boolean(routeData) });

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([loadCatalogue(controller.signal), fetchJson('/data/bd-upazila.geojson', controller.signal)])
      .then(([areas, upazilas]) => { setCatalogue(areas); setBoundaries(upazilas); })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (search && window.matchMedia('(max-width: 800px)').matches) {
      resultRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  }, [search]);

  const stops = useMemo(() => {
    if (!routeData || !boundaries || !catalogue) return [];
    const found = areasAlongRoute(routeData.result.coordinates, null, boundaries, catalogue, 0.1, placesFor(catalogue));
    return mergeEndpoints(found.upazilas, routeData, boundaries, catalogue);
  }, [routeData, boundaries, catalogue]);
  const regions = useMemo(() => catalogue && level !== 'upazila' ? routeRegions(stops, catalogue, level) : [], [stops, catalogue, level]);
  const shown = level === 'upazila' ? stops : regions;
  const outlook = routeData ? destinationOutlook(stops.at(-1), daily, snapshot, catalogue, lang) : null;
  const onRoute = (result, places) => { setShowingAlternative(false); setLevel('division'); setSearch(result ? { result, places } : null); };

  return (
    <div className="route-page" data-tone="light">
      <Navbar />
      <main className="route-page-main">
        <header className="route-page-heading">
          <p className="eyebrow"><Icon name="route" size={16} /> {tr('AkashSathi route planner')}</p>
          <h1>{tr('Plan your route')}</h1>
          <p className="route-page-intro">{tr('See your journey from division to district to upazila, with weather along the way.')}</p>
        </header>
        <div className="route-layout">
          <aside className="route-controls" aria-label={tr('Plan a route')}>
            <RoutePlanner catalogue={catalogue} onRoute={onRoute} />
            {search && <RouteSwitch shortest={search.result} alternative={alternative} showingAlternative={showingAlternative && Boolean(alternative)} onToggle={() => setShowingAlternative((value) => !value)} tr={tr} number={number} />}
          </aside>
          <section className="route-result" ref={resultRef} aria-label={tr('Your journey')}>
            <div className="route-result-hero">
              <p className="route-result-eyebrow"><Icon name="route" size={17} /> {tr('YOUR JOURNEY')}</p>
              {routeData ? (
                <>
                  <div className="route-ends">
                    <div className="route-end"><span className="route-end-mark route-end-mark--start" aria-hidden="true">A</span><div><small>{tr('Start')}</small><strong>{placeName(routeData.places.start, lang, tr)}</strong></div></div>
                    <span className="route-end-track" aria-hidden="true"><Icon name="arrow" size={20} /></span>
                    <div className="route-end"><span className="route-end-mark" aria-hidden="true">B</span><div><small>{tr('Destination')}</small><strong>{placeName(routeData.places.end, lang, tr)}</strong></div></div>
                  </div>
                  <p className="route-result-stats"><span><Icon name="route" size={16} /> {number(routeData.result.distanceKm.toFixed(1))} {tr('km')}</span><span><Icon name="clock" size={16} /> {durationText(routeData.result.durationMinutes, tr)}</span><span>{tr(showingAlternative && alternative ? 'Alternative route' : 'Shortest route')}</span></p>
                </>
              ) : (
                <div className="route-result-placeholder" role={loadError ? 'alert' : 'status'}>
                  <span className="route-placeholder-line" aria-hidden="true"><i /><i /><i /></span>
                  <h2>{tr('Your route, clearly laid out.')}</h2>
                  <p>{loadError || tr('Choose a start and destination. Your division-by-division journey will appear here.')}</p>
                </div>
              )}
            </div>
            {routeData && (
              <div className="route-result-body">
                <div className="route-level-heading">
                  <div><p className="route-section-label">{tr('Explore the route')}</p><h2>{tr('Places along your way')}</h2></div>
                  <span>{number(shown.length)} {tr(shown.length === 1 ? 'stop' : 'stops')}</span>
                </div>
                <div className="route-level-switch" role="group" aria-label={tr('Route detail level')}>
                  {['division', 'district', 'upazila'].map((choice) => (
                    <button key={choice} type="button" aria-pressed={level === choice} onClick={() => setLevel(choice)}>{tr(choice === 'upazila' ? 'Upazila / thana' : choice === 'district' ? 'District' : 'Division')}</button>
                  ))}
                </div>
                <p className="route-level-note">{tr('Weather can change. Lightning checks are not live.')}</p>
                {snapshot?.sources?.openMeteo?.status === 'stale' && <p className="route-level-note route-level-note--warning">{tr('The thunderstorm forecast is out of date.')}</p>}
                {shown.length ? (
                  <ol className="route-stop-list">
                    {level === 'upazila'
                      ? stops.map((parent, index) => <RouteWeather key={`${parent.id}-${index}`} parent={parent} index={index} total={stops.length} routeData={routeData} snapshot={snapshot} catalogue={catalogue} lightningState={lightningState} lang={lang} tr={tr} number={number} />)
                      : regions.map((group, index) => <RouteRegion key={`${group.id}-${index}`} group={group} index={index} total={regions.length} level={level} routeData={routeData} snapshot={snapshot} catalogue={catalogue} lightningState={lightningState} lang={lang} tr={tr} number={number} />)}
                  </ol>
                ) : <p className="route-empty-state" role="status">{!boundaries && !loadError ? tr('Finding places along your route…') : tr('No area boundary matched this part of the route.')}</p>}
                {stops.length > 0 && (
                  <section className="route-arrival" aria-label={tr('Destination weather')}>
                    <p className="route-section-label">{tr('At your destination')}</p>
                    <h3>{placeName(routeData.places.end, lang, tr)}</h3>
                    <p className="route-arrival-source">{tr('Estimated arrival: {time}', { time: formatBst(routeData.places.checkedAt + routeData.result.durationMinutes * 60_000) })} · {tr('Forecast from {name}', { name: placeName(stops.at(-1), lang, tr) })}</p>
                    <WeatherValues weather={cardWeather(stops.at(-1), routeData, snapshot, catalogue, lang)} tr={tr} number={number} />
                    <DestinationOutlook outlook={outlook} tr={tr} number={number} />
                  </section>
                )}
                <WeatherSummary route={routeData.result} />
                <p className="route-shortest-note">{tr('Other roads may be shorter.')}</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
