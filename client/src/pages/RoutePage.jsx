import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { RouteMap } from '../components/RouteMap.jsx';
import { RoutePlanner, WeatherSummary } from '../components/RoutePlanner.jsx';
import { usePolled } from '../hooks/usePolled.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { containsPoint } from '../lib/locate.js';
import { placesFor } from '../lib/neighbourhoods.js';
import { areasAlongRoute, routeParent } from '../lib/routeAreas.js';
import { regionWeather, routeLightning, routeRegions } from '../lib/routeHierarchy.js';
import { compactRoute, hospitalLabels, refreshRouteWeather, routeForecastIndex, routeForecastStatus, routeMapPoint, stopWeather } from '../lib/routeWeather.js';
import { resolveSelection } from '../lib/series.js';
import { formatBst, formatClock, formatDay, toMs } from '../lib/time.js';
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
  const location = catalogue.locations.find((item) => item.pcode === (place.weatherFrom?.id ?? place.pcode));
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
  // A boundary can first match at the exact endpoint too. Keep the selected endpoint last/first when progress ties.
  const endpointOrder = (card) => card.progress === 0 && card.id === startId ? -1 : card.progress === 1 && card.id === endId ? 1 : 0;
  const sorted = result.sort((a, b) => a.progress - b.progress || endpointOrder(a) - endpointOrder(b));
  if (startId && sorted[0]?.id === startId) sorted[0].endpointPlace = routeData.places.start;
  if (endId && sorted.length > 1 && sorted.at(-1).id === endId) sorted.at(-1).endpointPlace = routeData.places.end;
  return sorted;
}

const cardPlace = (card) => card.endpointPlace ?? card;
const placeName = (item, lang, tr) => lang === 'bn' ? item.nameBn || tr(item.name) : item.name;
const value = (amount, number, suffix = '', decimals = 0) => Number.isFinite(amount) ? `${number(amount.toFixed(decimals))}${suffix}` : '–';

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

function RouteStop({ point, total, level, selected, onSelect, lightningState, lang, tr, number }) {
  const { item, index, weather } = point;
  const regional = level !== 'upazila';
  const children = regional ? item.children : item.places.filter(place => place.id !== item.endpointPlace?.id);
  return (
    <li className={`route-stop${selected ? ' is-selected' : ''}`}>
      <button type="button" className="route-stop-toggle" aria-expanded={selected} aria-controls={`route-stop-detail-${index}`} onClick={() => onSelect(selected ? null : index)}>
        <span className="route-stop-marker" aria-hidden="true">{number(index + 1)}</span>
        <span className="route-stop-title"><strong>{point.name}</strong><small>{roleOf(index, total, tr)} · {formatClock(weather.arrivalMs)}</small></span>
        <span className="route-stop-temp">{value(weather.temp, number, '°', 0)}</span><Icon name="chevron" size={16} />
      </button>
      <div className="route-stop-content" id={`route-stop-detail-${index}`} hidden={!selected}>
        <p className="route-weather-label">{tr(regional ? 'Weather along this stretch' : 'Weather when you arrive')}</p>
        <p className="route-stop-caption">{formatBst(weather.arrivalMs)} · {tr(regional ? 'Regional summary, not a point forecast.' : 'Forecast from {name}', { name: placeName(item, lang, tr) })}</p>
        <WeatherValues weather={weather} tr={tr} number={number} regional={regional} />
        <LightningValues stops={regional ? item.stops : [item]} lightningState={lightningState} tr={tr} number={number} />
        {children.length > 0 && <p className="route-stop-places">{children.slice(0, 6).map(place => placeName(place, lang, tr)).join(' → ')}{children.length > 6 && ` · ${tr('and {n} more', { n: number(children.length - 6) })}`}</p>}
      </div>
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

const isGovSite = (url) => {
  try { return new URL(url).hostname.endsWith('.gov.bd'); } catch { return false; }
};

function HospitalCard({ hospital, lang, tr, number }) {
  const labels = hospitalLabels(hospital, lang);
  const name = labels.name || tr('Name not available');
  const address = hospital.address || labels.area || tr('Address not available');
  return (
    <li className="route-hospital-card">
      <div className="route-hospital-head"><Icon name="hospital" size={18} /><strong>{name}</strong><span>{tr('After ~{n} km', { n: number(Math.round(hospital.alongKm ?? 0)) })} · {number(hospital.distanceFromRouteKm.toFixed(1))} {tr('km from route')}</span></div>
      <p className="route-hospital-address">{address}</p>
      <div className="route-hospital-actions">
        {hospital.phoneDial
          ? <a className="route-hospital-call" href={`tel:${hospital.phoneDial}`}><Icon name="phone" size={14} />{hospital.phone}{hospital.phoneEmergency && ` · ${tr('Emergency department')}`}</a>
          : <span className="route-hospital-nophone">{tr('Contact not available')}</span>}
        {!hospital.phoneDial && hospital.searchUrl && <a className="route-hospital-google" href={hospital.searchUrl} target="_blank" rel="noreferrer"><Icon name="search" size={14} />{tr('See the number on Google Maps')}</a>}
        {hospital.website && <a href={hospital.website} target="_blank" rel="noreferrer"><Icon name="arrow" size={14} />{tr(isGovSite(hospital.website) ? 'Official website' : 'Website')}</a>}
        {hospital.email && <a href={`mailto:${hospital.email}`}><Icon name="send" size={14} />{tr('Email')}</a>}
        <a className="route-hospital-directions" href={hospital.mapsUrl} target="_blank" rel="noreferrer"><Icon name="route" size={14} />{tr('Directions')}</a>
      </div>
      {hospital.phoneDial && hospital.phoneSource && <small className="route-hospital-source">{tr('Number from')} <a href={hospital.phoneSource} target="_blank" rel="noreferrer">{tr(isGovSite(hospital.phoneSource) ? 'the official government website' : 'OpenStreetMap')}</a></small>}
    </li>
  );
}

function HospitalsSection({ state, lang, tr, number }) {
  if (state.disabled) return null;
  return (
    <section className="route-hospitals" aria-label={tr('Hospitals along your route')}>
      <p className="route-section-label">{tr('EMERGENCY')}</p>
      <h3><Icon name="hospital" size={19} />{tr('Hospitals along your route')}</h3>
      {state.loading && <p className="route-hospitals-status" role="status">{tr('Looking for hospitals near your route…')}</p>}
      {!state.loading && state.error && <p className="route-hospitals-status">{tr('Hospital search is unavailable right now.')}</p>}
      {!state.loading && !state.error && state.data?.length === 0 && <p className="route-hospitals-status">{tr('No mapped hospital found near this road.')}</p>}
      {!state.loading && !state.error && state.data?.length > 0 && (
        <ul className="route-hospital-list">
          {state.data.map((hospital) => <HospitalCard key={hospital.id} hospital={hospital} lang={lang} tr={tr} number={number} />)}
        </ul>
      )}
      <p className="route-hospitals-note">{tr('From OpenStreetMap. Not verified for opening hours or emergency capacity. Call ahead.')}</p>
      {state.data?.some((hospital) => !hospital.phoneDial && hospital.searchUrl) && <p className="route-hospitals-note">{tr('The Google Maps button searches for the hospital by name; check that the address matches before you call.')}</p>}
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
    <section className="route-options" aria-label={tr('Alternative route')}>
      <header><strong>{tr(showingAlternative ? 'Alternative route' : 'Shortest route')}</strong><small>{number(shown.distanceKm.toFixed(1))} {tr('km')} · {durationText(shown.durationMinutes, tr)}</small></header>
      {alternative ? (
        <button type="button" className="route-alt-button" aria-pressed={showingAlternative} onClick={onToggle}>
          <Icon name="route" size={18} /><span>{tr(showingAlternative ? 'Back to shortest route' : 'Alternative route')}<small>{number((showingAlternative ? shortest : alternative).distanceKm.toFixed(1))} {tr('km')} · {durationText((showingAlternative ? shortest : alternative).durationMinutes, tr)}</small></span>
        </button>
      ) : <p className="route-options-note">{tr('Only one road route was found between these places.')}</p>}
      <p className="route-shortest-note">{tr('Other roads may be shorter.')}</p>
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
  const [level, setLevel] = useState('district');
  const [selected, setSelected] = useState(0);
  const [focusRequest, setFocusRequest] = useState(null);
  const resultRef = useRef(null);
  const stopsRef = useRef(null);
  const alternative = useMemo(() => {
    const first = search?.result.alternatives?.[0];
    return first ? { ...first, start: search.result.start, end: search.result.end } : null;
  }, [search]);
  const routeData = useMemo(() => search
    ? { ...search, result: showingAlternative && alternative ? alternative : search.result }
    : null, [search, alternative, showingAlternative]);
  const snapshotState = usePolled(weatherApi.snapshot, ROUTE_INTERVAL);
  const snapshot = snapshotState.data;
  const dailyState = usePolled(weatherApi.daily, DAILY_INTERVAL);
  const daily = dailyState.data;
  const lightningState = usePolled(weatherApi.lightningSummaries, ROUTE_INTERVAL, { enabled: Boolean(routeData) });
  const [hospitalsState, setHospitalsState] = useState({ loading: false, error: false, data: null });

  // Hospitals are fetched once per route (not polled): the road does not change while the forecast keeps refreshing. A failed or slow
  // lookup only clears the hospital section; it must never block or retry the route itself.
  useEffect(() => {
    const coordinates = routeData?.result?.coordinates;
    if (!coordinates) { setHospitalsState({ loading: false, error: false, data: null }); return undefined; }
    const controller = new AbortController();
    setHospitalsState({ loading: true, error: false, data: null });
    weatherApi.routeHospitals(compactRoute(coordinates), controller.signal)
      .then((payload) => setHospitalsState(payload?.disabled
        ? { loading: false, error: false, data: null, disabled: true }
        : { loading: false, error: false, data: payload?.hospitals ?? [] }))
      .catch((error) => { if (error.name !== 'AbortError') setHospitalsState({ loading: false, error: true, data: null }); });
    return () => controller.abort();
  }, [routeData]);

  useEffect(() => {
    const controller = new AbortController();
    loadCatalogue(controller.signal).then(setCatalogue)
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    fetchJson('/data/bd-upazila.geojson', controller.signal).then(setBoundaries)
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
  const points = useMemo(() => shown.map((item, index) => {
    const arrivalMs = routeData.places.checkedAt + routeData.result.durationMinutes * 60_000 * item.progress;
    const regionalSnapshot = routeForecastIndex(snapshot?.steps, arrivalMs) < 0 ? null : snapshot;
    const weather = level === 'upazila' ? stopWeather(item, routeData, snapshot, catalogue, lang)
      : { ...regionWeather(item, level, regionalSnapshot, catalogue, arrivalMs), arrivalMs };
    return { item, index, regional: level !== 'upazila', name: placeName(level === 'upazila' ? cardPlace(item) : item, lang, tr), weather, temp: weather.temp, coordinates: routeMapPoint(item, index, shown.length, routeData.result.coordinates) };
  }), [shown, level, routeData, snapshot, catalogue, lang, tr]);
  const refreshedRoute = useMemo(() => refreshRouteWeather(routeData?.result, snapshot), [routeData, snapshot]);
  const onRoute = (result, places) => { setShowingAlternative(false); setLevel('district'); setSelected(0); setFocusRequest(null); setSearch(result ? { result, places } : null); };
  const toggleAlternative = () => { setShowingAlternative(value => !value); setSelected(0); setFocusRequest(null); };
  const selectPoint = (index, fromMap = false) => {
    setSelected(index);
    if (index !== null && !fromMap) setFocusRequest({ index });
    if (fromMap && stopsRef.current) {
      const row = stopsRef.current.children[index];
      if (row) stopsRef.current.scrollTo({ top: row.offsetTop - stopsRef.current.offsetTop, behavior: 'instant' });
    }
  };
  const forecastWarning = snapshotState.error || routeForecastStatus(snapshot) !== 'ok';
  const forecastSource = snapshot?.sources?.[snapshot.base === 'open-meteo' ? 'openMeteo' : 'bmd'];
  const updatedAt = forecastSource?.dataTime ?? forecastSource?.fetchedAt;

  return (
    <div className="route-page" data-tone="light">
      <Navbar />
      <main className="route-page-main">
        <header className="route-page-heading">
          <p className="eyebrow"><Icon name="route" size={16} /> {tr('AkashSathi route planner')}</p>
          <div className="route-heading-row"><div><h1>{tr('Plan your route')}</h1>
            <p className="route-page-intro">{tr('From your first turn to your destination, see the road ahead and the weather along it.')}</p></div>
            <div className={`route-update${forecastWarning ? ' has-warning' : ''}`}>
              <span role="status"><Icon name={forecastWarning ? 'info' : 'refresh'} size={15} />{tr(snapshotState.loading ? 'Updating forecast…' : forecastWarning ? 'Forecast may be incomplete or out of date.' : 'Forecast refreshes every 5 min')}</span>
              <button type="button" onClick={snapshotState.reload} disabled={snapshotState.loading} aria-label={tr('Refresh forecast')}><Icon name="refresh" size={16} /></button>
              {updatedAt && Number.isFinite(toMs(updatedAt)) && <small>{tr('Forecast updated: {time}', { time: formatBst(toMs(updatedAt)) })}</small>}
            </div>
          </div>
        </header>
        <div className="route-layout">
          <aside className="route-controls" aria-label={tr('Plan a route')}>
            <RoutePlanner catalogue={catalogue} onRoute={onRoute} />
            {loadError && <p className="route-error" role="alert">{loadError}</p>}
            {search && <RouteSwitch shortest={search.result} alternative={alternative} showingAlternative={showingAlternative && Boolean(alternative)} onToggle={toggleAlternative} tr={tr} number={number} />}
            {refreshedRoute ? <details className="route-overview"><summary><Icon name="cloud" size={18} />{tr('Route weather summary')}<Icon name="chevron" size={16} /></summary><WeatherSummary route={refreshedRoute} /></details>
              : <div className="route-planner-hint"><Icon name="layers" size={21} /><strong>{tr('A clearer view of the road ahead')}</strong><p>{tr('Explore your route on the map, then open a stop for its arrival forecast.')}</p><span>{tr('Road route')}<i />{tr('Arrival weather')}<i />{tr('3-day outlook')}</span></div>}
          </aside>
          <section className="route-result" ref={resultRef} aria-label={tr('Your journey')}>
            <div className="route-map-heading"><div><p className="route-section-label">{tr('YOUR JOURNEY')}</p><h2><Icon name="map" size={19} />{tr('Your journey on the map')}</h2></div><span className="route-map-tag">{tr(routeData ? 'Road route' : 'Bangladesh')}</span></div>
            <div className="route-result-hero">
              {routeData ? (
                <>
                  <p className="route-ends"><strong>{placeName(routeData.places.start, lang, tr)}</strong><Icon name="arrow" size={17} /><strong>{placeName(routeData.places.end, lang, tr)}</strong></p>
                  <p className="route-result-stats"><span><Icon name="route" size={15} />{number(routeData.result.distanceKm.toFixed(1))} {tr('km')}</span><span><Icon name="clock" size={15} />{durationText(routeData.result.durationMinutes, tr)}</span><span>{tr('Estimated arrival: {time}', { time: formatClock(routeData.places.checkedAt + routeData.result.durationMinutes * 60_000) })}</span></p>
                </>
              ) : (
                <p className="route-map-intro">{tr('Choose two places to see your road route and weather.')}</p>
              )}
            </div>
            <RouteMap route={routeData?.result} otherRoute={search && alternative ? (showingAlternative ? search.result : alternative) : null} points={points} selected={selected} onSelect={index => selectPoint(index, true)} onAlternative={toggleAlternative} focusRequest={focusRequest} hospitals={hospitalsState.data} />
            {points[selected] && <div className="route-map-weather" aria-live="polite">
              <div className="route-map-weather-place"><span className="route-section-label">{tr(level === 'upazila' ? 'Weather when you arrive' : 'Weather along this stretch')}</span><strong>{points[selected].name}</strong><small>{formatBst(points[selected].weather.arrivalMs)}</small></div>
              <dl><div><dt><Icon name="thermometer" size={15} />{tr(level === 'upazila' ? 'Temperature' : 'Average temperature')}</dt><dd>{value(points[selected].weather.temp, number, tr('°C'), 1)}</dd></div><div><dt><Icon name="rain" size={15} />{tr(level === 'upazila' ? 'Rainfall' : 'Peak rain')}</dt><dd>{value(points[selected].weather.rf, number, ` ${tr('mm')}`, 1)}</dd></div><div><dt><Icon name="wind" size={15} />{tr(level === 'upazila' ? 'Wind' : 'Strongest wind')}</dt><dd>{value(points[selected].weather.wg, number, ` ${tr('km/h')}`)}</dd></div></dl>
            </div>}
            {routeData && snapshot?.base === 'bmd' && <p className="route-map-weather-note">{tr('BMD rainfall units have not been verified.')}</p>}
            <p className="route-map-caption"><Icon name="info" size={15} />{tr(routeData ? 'Tap a stop for weather · Scroll or pinch to zoom' : 'Scroll or pinch to zoom · Drag to explore')}<span>{tr('Forecast, not live observations')}</span></p>
          </section>
        </div>
        {routeData && (
          <div className="route-result-body" aria-label={tr('Route weather')}>
            <section className="route-journey-panel">
              <div className="route-level-heading">
                <div><p className="route-section-label">{tr('Explore the route')}</p><h2>{tr('Places along your way')}</h2></div>
                <span>{number(shown.length)} {tr(shown.length === 1 ? 'stop' : 'stops')}</span>
              </div>
              <div className="route-level-switch" role="group" aria-label={tr('Route detail level')}>
                {['division', 'district', 'upazila'].map((choice) => (
                  <button key={choice} type="button" aria-pressed={level === choice} onClick={() => { setLevel(choice); setSelected(0); setFocusRequest(null); }}>{tr(choice === 'upazila' ? 'Upazila / thana' : choice === 'district' ? 'District' : 'Division')}</button>
                ))}
              </div>
              <p className="route-level-note">{tr('Weather can change. Lightning checks are not live.')}</p>
              {snapshot?.sources?.openMeteo?.status === 'stale' && <p className="route-level-note route-level-note--warning">{tr('The thunderstorm forecast is out of date.')}</p>}
              {shown.length ? (
                <ol className="route-stop-list" ref={stopsRef}>
                  {points.map(point => <RouteStop key={`${point.item.id}-${point.index}`} point={point} total={points.length} level={level} selected={selected === point.index} onSelect={selectPoint} lightningState={lightningState} lang={lang} tr={tr} number={number} />)}
                </ol>
              ) : <p className="route-empty-state" role="status">{!boundaries && !loadError ? tr('Finding places along your route…') : tr('No area boundary matched this part of the route.')}</p>}
            </section>
            {stops.length > 0 && (
              <section className="route-arrival" aria-label={tr('Destination weather')}>
                <p className="route-section-label">{tr('At your destination')}</p>
                <h3>{placeName(routeData.places.end, lang, tr)}</h3>
                <p className="route-arrival-source">{tr('Estimated arrival: {time}', { time: formatBst(routeData.places.checkedAt + routeData.result.durationMinutes * 60_000) })} · {tr('Forecast from {name}', { name: placeName(stops.at(-1), lang, tr) })}</p>
                <WeatherValues weather={stopWeather(stops.at(-1), routeData, snapshot, catalogue, lang)} tr={tr} number={number} />
                <DestinationOutlook outlook={outlook} tr={tr} number={number} />
                {outlook && dailyState.error && <p className="route-level-note">{tr('The latest daily forecast refresh failed. Saved outlook is shown.')}</p>}
                {!outlook && <p className="route-level-note">{tr('The destination outlook is not available right now.')}</p>}
                <p className="route-shortest-note">{tr('Model forecast, not station readings. Weather between sampled locations may differ. Route and ETA are estimates.')}</p>
              </section>
            )}
            <HospitalsSection state={hospitalsState} lang={lang} tr={tr} number={number} />
          </div>
        )}
      </main>
    </div>
  );
}
