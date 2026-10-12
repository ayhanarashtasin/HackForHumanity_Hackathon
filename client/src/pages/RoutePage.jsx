import { useEffect, useMemo, useRef, useState } from 'react';
import { digits } from '../alert/format.js';
import { Icon } from '../components/Icon.jsx';
import { MapView } from '../components/MapView.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { RoutePlanner, WeatherSummary } from '../components/RoutePlanner.jsx';
import { usePolled } from '../hooks/usePolled.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { containsPoint } from '../lib/locate.js';
import { placesFor } from '../lib/neighbourhoods.js';
import { areasAlongRoute, routeParent } from '../lib/routeAreas.js';
import { resolveSelection } from '../lib/series.js';
import { formatBst, formatDay, stepIndexAt, toMs } from '../lib/time.js';
import { loadCatalogue, weatherApi } from '../services/weatherApi.js';
import '../pages/map-page.css';
import './route-page.css';

const ROUTE_INTERVAL = 5 * 60_000;
const DAILY_INTERVAL = 30 * 60_000;
// Street level, so a city route (Banasree → Farmgate) can be followed road by road when zoomed in.
const ROUTE_MAX_ZOOM = 16;
const NOOP = () => {};
const MAP_HANDLERS = { onSelect: NOOP, onHover: NOOP, onMoveEnd: NOOP, onLightningSelect: NOOP };

async function fetchJson(path, signal) {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`Could not load ${path}.`);
  return response.json();
}

// The card a start or destination belongs to, by the same rule as the route samples: the upazila it lies in, or its nearest thana
// inside a city corporation. A neighbourhood or local area therefore shows the weather of the upazila/thana it is part of.
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
  if (!routeData) return result;
  const endpoints = [
    { place: routeData.places.start, progress: 0 },
    { place: routeData.places.end, progress: 1 },
  ];
  const ids = [];
  for (const { place, progress } of endpoints) {
    const card = endpointCard(place, boundaries, catalogue, progress);
    ids.push(card?.id);
    if (!card) continue;
    const id = card.id;
    const existing = result.find((item) => item.id === id);
    const selectedArea = catalogue.areas?.find((area) => area.id === (place.id ?? place.pcode));
    const selectedPlace = place.level === 'neighbourhood' ? place : null;
    if (existing) {
      if (selectedPlace && !existing.places.some((item) => item.id === selectedPlace.id)) existing.places.push(selectedPlace);
      if (progress === 0) existing.progress = 0;
      if (progress === 1) existing.progress = 1;
      if (selectedArea && !existing.areas.some((areaId) => catalogue.areas.find((area) => area.id === areaId)?.name.toLowerCase() === selectedArea.name.toLowerCase())) {
        existing.areas.push(selectedArea.id);
      }
      continue;
    }
    if (selectedArea) card.areas.push(selectedArea.id);
    if (selectedPlace) card.places.push(selectedPlace);
    if (progress === 0) result.unshift(card);
    else result.push(card);
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
  // The first and last cards are titled with the place the traveller chose (Banani), not only the thana whose forecast they show
  // (Gulshan), and their map stop sits on that exact place.
  const mark = (card, place) => {
    if (!card || !place) return;
    card.endpointPlace = place;
    if (Number.isFinite(place.lon) && Number.isFinite(place.lat)) card.point = [place.lon, place.lat];
  };
  if (startId && sorted[0]?.id === startId) mark(sorted[0], routeData.places.start);
  if (endId && sorted.length > 1 && sorted.at(-1).id === endId) mark(sorted.at(-1), routeData.places.end);
  return sorted;
}

// What a card is called: the chosen start or destination, else its upazila/thana.
const cardPlace = (card) => card.endpointPlace ?? card;

function formatValue(value, number, suffix = '', decimals = 0) {
  return Number.isFinite(value) ? `${number(value.toFixed(decimals))}${suffix}` : '–';
}

// The forecast of a card's upazila/thana at the time the traveller is expected to reach it.
function cardWeather(parent, routeData, snapshot, catalogue, lang) {
  const resolved = resolveSelection({ level: parent.level ?? 'polygon', id: parent.id }, snapshot, catalogue, lang);
  const arrivalMs = routeData.places.checkedAt + routeData.result.durationMinutes * 60_000 * parent.progress;
  const weatherIndex = snapshot?.steps?.length ? stepIndexAt(snapshot.steps, arrivalMs) : -1;
  const at = (key) => (weatherIndex >= 0 ? resolved?.series?.[key]?.[weatherIndex] ?? null : null);
  return { arrivalMs, temp: at('temp'), hi: at('hi'), rf: at('rf'), wg: at('wg') };
}

// Mapped local areas first, then neighbourhoods that are not already one of them by name. Each has a point for its dot on the map.
function cardAreas(parent, catalogue, areaPoints) {
  const mapped = parent.areas.map((id) => catalogue.areas?.find((item) => item.id === id)).filter(Boolean)
    .map((area) => ({ ...area, point: areaPoints.get(area.id) ?? [area.lon, area.lat] }));
  return [
    ...mapped,
    ...parent.places
      .filter((place) => !mapped.some((area) => area.name.toLowerCase() === place.name.toLowerCase()))
      .map((place) => ({ ...place, point: [place.lon, place.lat] })),
  ];
}

function roleOf(index, total, tr) {
  if (total === 1) return `${tr('Start')} · ${tr('Destination')}`;
  return index === 0 ? tr('Start') : index === total - 1 ? tr('Destination') : tr('On the way');
}

function WeatherValues({ weather, tr, number }) {
  return (
    <dl className="route-weather-values">
      <div><dt>{tr('Temperature')}</dt><dd>{formatValue(weather.temp, number, tr('°C'), 1)}</dd></div>
      <div><dt>{tr('Heat index')}</dt><dd>{formatValue(weather.hi, number, tr('°C'), 1)}</dd></div>
      <div><dt>{tr('Rainfall')}</dt><dd>{formatValue(weather.rf, number, ` ${tr('mm')}`, 1)}</dd></div>
      <div><dt>{tr('Wind')}</dt><dd>{formatValue(weather.wg, number, ` ${tr('km/h')}`)}</dd></div>
    </dl>
  );
}

// Shown while the pointer is over a numbered stop or an area dot (or after a tap on a touch screen).
function RouteTooltip({ hover, entry, outlook, tr, number, placeName }) {
  if (!hover || !entry) return null;
  const { card, area, index, total, weather } = entry;
  const isDestination = !area && index === total - 1;
  // Opens toward the side with room, so it is not clipped at the map's right or bottom edge.
  // It sits beside the pointer and slides up just enough to stay inside the map; the destination's tooltip is taller because it
  // also carries the 3-day outlook.
  const height = isDestination && outlook ? 390 : 180;
  const top = Number.isFinite(hover.height) ? Math.max(8, Math.min(hover.y + 14, hover.height - height - 8)) : hover.y + 14;
  const style = {
    ...(hover.x > (hover.width ?? Infinity) / 2 ? { right: hover.width - hover.x + 14 } : { left: hover.x + 14 }),
    top,
  };
  return (
    <div className="tooltip route-tooltip" style={style} role="tooltip">
      <strong>{area ? placeName(area) : `${number(String(index + 1).padStart(2, '0'))} · ${placeName(cardPlace(card))}`}</strong>
      <small>{roleOf(index, total, tr)} · {formatBst(weather.arrivalMs)}</small>
      <WeatherValues weather={weather} tr={tr} number={number} />
      {isDestination && <DestinationOutlook outlook={outlook} tr={tr} number={number} compact />}
    </div>
  );
}

function RouteWeather({ parent, index, total, routeData, snapshot, catalogue, areaPoints, outlook, lang, tr, number }) {
  const weather = cardWeather(parent, routeData, snapshot, catalogue, lang);
  const { arrivalMs } = weather;
  const areas = cardAreas(parent, catalogue, areaPoints);
  const role = roleOf(index, total, tr);
  const placeName = (item) => (lang === 'bn' ? item.nameBn || tr(item.name) : item.name);

  return (
    <article className="route-weather-card">
      <div className="route-weather-heading">
        <span className="route-step-number">{number(String(index + 1).padStart(2, '0'))}</span>
        <div>
          <small>{role}</small>
          <h3>{placeName(cardPlace(parent))}</h3>
        </div>
        <time>{formatBst(arrivalMs)}</time>
      </div>
      {areas.length > 0 ? (
        <p className="route-crossed-areas">{tr('Areas along the route')}: {areas.map((area) => lang === 'bn' ? (area.nameBn || tr(area.name)) : area.name).join(', ')}</p>
      ) : <p className="route-crossed-areas">{tr('No area boundary matched this part of the route.')}</p>}
      <WeatherValues weather={weather} tr={tr} number={number} />
      <p className="route-weather-eta">{tr('Weather at estimated arrival')}</p>
      <DestinationOutlook outlook={outlook} tr={tr} number={number} />
    </article>
  );
}

const OUTLOOK_DAYS = 3;
const BST_OFFSET_MS = 6 * 60 * 60_000;

// The next three days at the destination, from the BMD daily forecast of the upazila/thana it lies in. BMD days run 00–24 UTC
// (06:00–06:00 BST) and are labelled by their date, so "tomorrow" is the first day dated after today's date in Bangladesh.
function destinationOutlook(card, daily, snapshot, catalogue, lang, nowMs = Date.now()) {
  if (!card || !daily?.days?.length) return null;
  const resolved = resolveSelection({ level: card.level ?? 'polygon', id: card.id }, snapshot, catalogue, lang);
  const pcode = resolved?.dailyPcode ?? resolved?.members?.[0]?.pcode;
  const values = pcode && daily.locations?.[pcode];
  if (!values) return null;
  const today = new Date(nowMs + BST_OFFSET_MS).toISOString().slice(0, 10);
  const days = daily.days
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => day.slice(0, 10) > today)
    .slice(0, OUTLOOK_DAYS)
    .map(({ day, index }) => ({
      day,
      tmin: values.tmin?.[index] ?? null,
      tmax: values.tmax?.[index] ?? null,
      rf: values.rf?.[index] ?? null,
      ws: values.ws?.[index] ?? null,
    }));
  return days.length ? { card, days, stale: daily.sources?.bmd?.status === 'stale' } : null;
}

// Part of the destination's card in the list and of its hover tooltip on the map; both are already titled with the destination.
function DestinationOutlook({ outlook, tr, number, compact = false }) {
  if (!outlook) return null;
  const value = (v, decimals, suffix) => (Number.isFinite(v) ? `${number(v.toFixed(decimals))}${suffix}` : '–');
  return (
    <section className={`route-outlook ${compact ? 'route-outlook--tooltip' : 'route-outlook--card'}`} aria-label={tr('Weather for the next 3 days')}>
      <header><strong>{tr('Weather for the next 3 days')}</strong></header>
      <ul>
        {outlook.days.map((day) => (
          <li key={day.day}>
            <Icon name={day.rf > 0 ? 'rain' : 'sun'} size={compact ? 16 : 18} />
            <span className="route-outlook-day">{formatDay(toMs(day.day))}</span>
            <span className="route-outlook-temp">{value(day.tmin, 0, '°')} – {value(day.tmax, 0, tr('°C'))}</span>
            <span className="route-outlook-rain">{tr('Rain')} {value(day.rf, 1, ` ${tr('mm')}`)}</span>
            {!compact && <span className="route-outlook-wind">{tr('Wind')} {value(day.ws, 0, ` ${tr('km/h')}`)}</span>}
          </li>
        ))}
      </ul>
      {outlook.stale && <small className="route-outlook-note">{tr('This daily forecast is stale.')}</small>}
    </section>
  );
}

function durationText(minutes, tr) {
  const hours = Math.floor(minutes / 60);
  return hours ? tr('{hours} h {minutes} min', { hours, minutes: minutes % 60 }) : tr('{minutes} min', { minutes });
}

// The shortest route is shown first. One button swaps it for an alternative road (and back); the map, stops, cards and summary then
// describe whichever route is showing, in the same way.
function RouteSwitch({ shortest, alternative, showingAlternative, onToggle, tr, number }) {
  const shown = showingAlternative ? alternative : shortest;
  return (
    <section className="route-options panel" aria-label={tr('Alternative route')}>
      <header>
        <strong>{tr(showingAlternative ? 'Alternative route' : 'Shortest route')}</strong>
        <small>{number(shown.distanceKm.toFixed(1))} {tr('km')} · {durationText(shown.durationMinutes, tr)}</small>
      </header>
      {alternative ? (
        <button type="button" className="route-alt-button" aria-pressed={showingAlternative} onClick={onToggle}>
          <Icon name="route" size={18} />
          <span>
            {tr(showingAlternative ? 'Back to shortest route' : 'Alternative route')}
            <small>
              {showingAlternative
                ? `${number(shortest.distanceKm.toFixed(1))} ${tr('km')} · ${durationText(shortest.durationMinutes, tr)}`
                : `${number(alternative.distanceKm.toFixed(1))} ${tr('km')} · ${durationText(alternative.durationMinutes, tr)}`}
            </small>
          </span>
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
  // The last search and whether its alternative road is showing instead of the shortest one. `routeData` is always the route on show,
  // so the map, cards, stops and tooltips follow the switch.
  const [search, setSearch] = useState(null);
  const [showingAlternative, setShowingAlternative] = useState(false);
  const alternative = useMemo(() => {
    const first = search?.result.alternatives?.[0];
    return first ? { ...first, start: search.result.start, end: search.result.end } : null;
  }, [search]);
  const routeData = useMemo(() => (search
    ? { ...search, result: showingAlternative && alternative ? alternative : search.result }
    : null), [search, alternative, showingAlternative]);
  const snapshotState = usePolled(weatherApi.snapshot, ROUTE_INTERVAL);
  const snapshot = snapshotState.data;
  const dailyState = usePolled(weatherApi.daily, DAILY_INTERVAL);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      loadCatalogue(controller.signal),
      fetchJson('/data/bd-admin4.geojson', controller.signal),
      fetchJson('/data/bd-upazila.geojson', controller.signal),
    ])
      .then(([areas, admin4, upazilas]) => {
        setCatalogue(areas);
        setBoundaries({ areas: admin4, upazilas });
      })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    return () => controller.abort();
  }, []);

  const crossed = useMemo(() => {
    if (!routeData || !boundaries || !catalogue) return { areas: [], upazilas: [] };
    const found = areasAlongRoute(routeData.result.coordinates, boundaries.areas, boundaries.upazilas, catalogue, 0.1, placesFor(catalogue));
    return { ...found, upazilas: mergeEndpoints(found.upazilas, routeData, boundaries.upazilas, catalogue) };
  }, [routeData, boundaries, catalogue]);
  const areaPoints = useMemo(() => new Map(crossed.areas.map((area) => [area.id, area.point])), [crossed]);

  // What the map draws on top of the route: a numbered stop per card, a dot per area, and the crossed boundaries outlined.
  // `entries` maps each map feature id back to its card (and area) for the hover tooltip.
  const routeMap = useMemo(() => {
    if (!routeData || !catalogue || !crossed.upazilas.length) return { details: null, entries: new Map() };
    const placeName = (item) => (lang === 'bn' ? item.nameBn || tr(item.name) : item.name);
    const total = crossed.upazilas.length;
    const stops = [];
    const entries = new Map();
    crossed.upazilas.forEach((card, index) => {
      const id = `stop-${index}`;
      const [lon, lat] = card.point ?? [];
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        stops.push({ id, type: 'stop', number: digits(index + 1, lang), label: placeName(cardPlace(card)), lon, lat });
        entries.set(id, { card, index, total });
      }
      cardAreas(card, catalogue, areaPoints).forEach((area, areaIndex) => {
        const areaId = `area-${index}-${areaIndex}`;
        stops.push({ id: areaId, type: 'area', label: placeName(area), lon: area.point[0], lat: area.point[1] });
        entries.set(areaId, { card, area, index, total });
      });
    });
    // City corporations are left unshaded: tinting all of Dhaka for one thana would say the route covers the whole city.
    const upazilaPids = [...new Set(crossed.upazilas
      .filter((card) => card.kind === 'upazila' && card.polygonPid)
      .map((card) => card.polygonPid))];
    return { details: { stops, upazilaPids, areaPids: crossed.areas.map((area) => area.id) }, entries };
  }, [routeData, catalogue, crossed, areaPoints, lang, tr]);

  const shellRef = useRef(null);
  const [routeHover, setRouteHover] = useState(null);
  useEffect(() => setRouteHover(null), [routeData]);
  const mapHandlers = useMemo(() => ({
    ...MAP_HANDLERS,
    onRouteHover: (id, point) => setRouteHover((current) => {
      if (!id) return null;
      return current?.id === id && current.x === point?.x && current.y === point?.y ? current : { id, ...point };
    }),
  }), []);
  const hoverEntry = routeHover && routeMap.entries.get(routeHover.id);
  const placeName = (item) => (lang === 'bn' ? item.nameBn || tr(item.name) : item.name);
  const outlook = routeData
    ? destinationOutlook(crossed.upazilas.at(-1), dailyState.data, snapshot, catalogue, lang)
    : null;

  const mapStep = snapshot?.steps?.length ? stepIndexAt(snapshot.steps, Date.now()) : 0;
  const baseStatus = snapshot?.base ? snapshot.sources?.[snapshot.base]?.status ?? 'not-checked' : 'not-checked';

  return (
    <div className="route-page weather-app" data-tone="light">
      <Navbar />
      <main className="route-page-main">
        <header className="route-page-heading">
          <p className="eyebrow">{tr('AkashSathi route planner')}</p>
          <h1>{tr('Plan your route')}</h1>
        </header>
        <div className="route-layout">
          <section className="route-map-column" aria-label={tr('Route map')}>
            <div className="route-map-shell" ref={shellRef}>
              {catalogue ? (
                <MapView
                  catalogue={catalogue}
                  signLayer="temp"
                  snapshot={snapshot}
                  stepIndex={mapStep}
                  baseStatus={baseStatus}
                  radarItems={[]}
                  satelliteSpec={null}
                  lightning={{ visible: false, items: [] }}
                  route={routeData?.result ?? null}
                  routeDetails={routeMap.details}
                  maxZoom={ROUTE_MAX_ZOOM}
                  selection={null}
                  flyRequest={null}
                  userPosition={null}
                  handlers={mapHandlers}
                />
              ) : <div className="splash" role={loadError ? 'alert' : 'status'}>{loadError || tr('Loading route map…')}</div>}
              {hoverEntry && (
                <RouteTooltip
                  hover={{ ...routeHover, width: shellRef.current?.clientWidth, height: shellRef.current?.clientHeight }}
                  entry={{ ...hoverEntry, weather: cardWeather(hoverEntry.card, routeData, snapshot, catalogue, lang) }}
                  tr={tr}
                  number={number}
                  outlook={outlook}
                  placeName={placeName}
                />
              )}
            </div>
            {routeData && (
              <div className="route-result-line">
                <strong>{lang === 'bn' ? (routeData.places.start.nameBn ?? tr(routeData.places.start.name)) : routeData.places.start.name} → {lang === 'bn' ? (routeData.places.end.nameBn ?? tr(routeData.places.end.name)) : routeData.places.end.name}</strong>
                <span>{number(routeData.result.distanceKm.toFixed(1))} {tr('km')} · {number(routeData.result.durationMinutes)} {tr('min')}</span>
                <small>{tr(showingAlternative && alternative ? 'Alternative route' : 'Shortest route')}</small>
                {routeMap.details && <small>{tr('Point to a numbered stop or a dot on the route to see its weather. Numbers match the list.')}</small>}
              </div>
            )}
            <p className="route-shortest-note">{tr('OSRM alternatives are not guaranteed to include the globally shortest road route.')}</p>
          </section>
          <aside className="route-sidebar" aria-label={tr('Route weather summary')}>
            <RoutePlanner
              fullPage
              catalogue={catalogue}
              onRoute={(result, places) => { setShowingAlternative(false); setSearch(result ? { result, places } : null); }}
            />
            {search && (
              <RouteSwitch
                shortest={search.result}
                alternative={alternative}
                showingAlternative={showingAlternative && Boolean(alternative)}
                onToggle={() => setShowingAlternative((value) => !value)}
                tr={tr}
                number={number}
              />
            )}
            {routeData && <WeatherSummary route={routeData.result} />}
            {routeData && crossed.upazilas.length > 0 && (
              <section className="route-weather-list" aria-label={tr('Areas along the route')}>
                {crossed.upazilas.map((parent, index) => (
                  <RouteWeather
                    key={`${parent.id}-${index}`}
                    parent={parent}
                    index={index}
                    total={crossed.upazilas.length}
                    routeData={routeData}
                    snapshot={snapshot}
                    catalogue={catalogue}
                    areaPoints={areaPoints}
                    outlook={index === crossed.upazilas.length - 1 ? outlook : null}
                    lang={lang}
                    tr={tr}
                    number={number}
                  />
                ))}
              </section>
            )}
            {!routeData && <p className="route-empty-state" role="status">{tr('Route results appear here after you check a route.')}</p>}
            {routeData && crossed.upazilas.length === 0 && <p className="route-empty-state" role="status">{tr('No area boundary matched this part of the route.')}</p>}
          </aside>
        </div>
      </main>
    </div>
  );
}