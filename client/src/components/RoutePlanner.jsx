import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { errorText, useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { requestUserLocation } from '../lib/userLocation.js';
import { placesFor } from '../lib/neighbourhoods.js';
import { weatherApi } from '../services/weatherApi.js';

// The start can be the device position. The upazila it falls in is looked up only to label the field; the route uses the exact point.
async function currentPlace() {
  const location = await requestUserLocation();
  if (location.status !== 'ready') throw new Error(location.message);
  return { level: 'current', pcode: 'current-location', name: 'My location', nameBn: 'আমার অবস্থান', ...location.position };
}

function PlaceField({ field, label, catalogue, value, onChange, onSelect }) {
  const { tr, name, lang } = useLanguage(MAP);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const index = useMemo(() => {
    if (!catalogue) return [];
    const districts = new Map(catalogue.districts.map((district) => [district.pcode, district]));
    return [
      ...catalogue.districts.map((district) => ({ ...district, level: 'district', kind: tr('District'), parent: tr(district.division) })),
      ...catalogue.locations.map((location) => ({
        ...location, level: 'upazila', kind: tr(location.kind === 'thana' ? 'City thana' : 'Upazila'), parent: name(districts.get(location.district)),
      })),
      ...(catalogue.areas ?? []).map((area) => ({
        ...area, pcode: area.id, level: 'area', kind: tr('Local area'), parent: name({ name: area.parentName }),
      })),
      ...placesFor(catalogue).map((place) => ({
        ...place, pcode: place.id, level: 'neighbourhood', kind: tr('Neighbourhood'), parent: tr(place.city),
      })),
    ].map((place) => ({ ...place, search: `${place.name} ${place.nameBn ?? ''}`.toLowerCase() }));
  }, [catalogue, name, tr]);
  // An empty field lists every district so a place can be chosen without typing; typing narrows to districts, upazilas, areas and
  // neighbourhoods, names that start with the text first ("ban" → Banasree, Banani before Bandarban's unions).
  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return index.filter((place) => place.level === 'district').sort((a, b) => a.name.localeCompare(b.name));
    const starts = (place) => place.name.toLowerCase().startsWith(text) || (place.nameBn ?? '').startsWith(text);
    const matches = index.filter((place) => place.search.includes(text));
    return [...matches.filter(starts), ...matches.filter((place) => !starts(place))].slice(0, 8);
  }, [index, query]);
  useEffect(() => {
    if (open) document.getElementById(`route-${field}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, field, open]);
  const choose = (place) => {
    onSelect({ ...place, name: place.name, lat: place.lat, lon: place.lon });
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="route-field">
      <label htmlFor={`route-${field}`}>{label}</label>
      <input
        id={`route-${field}`}
        type="search"
        role="combobox"
        value={value ? [name(value), value.parent ?? (value.area && name(value.area))].filter(Boolean).join(', ') : query}
        placeholder={tr('Search English or বাংলা')}
        aria-expanded={open && results.length > 0}
        aria-controls={`route-${field}-results`}
        aria-autocomplete="list"
        aria-activedescendant={open && results.length ? `route-${field}-option-${active}` : undefined}
        autoComplete="off"
        onFocus={() => { setQuery(''); setOpen(true); }}
        onChange={(event) => { onChange(null); setQuery(event.target.value); setActive(0); setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (!results.length) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => (value + 1) % results.length); setOpen(true); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => (value - 1 + results.length) % results.length); setOpen(true); }
          if (event.key === 'Enter' && open) { event.preventDefault(); choose(results[active] ?? results[0]); }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul id={`route-${field}-results`} className="route-results" role="listbox">
          {results.map((place) => (
            <li key={`${place.level}-${place.pcode}`} role="none">
              <button id={`route-${field}-option-${results.indexOf(place)}`} type="button" role="option" aria-selected={active === results.indexOf(place)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(place)}>
                <span>{name(place)}{lang !== 'bn' && place.nameBn ? <em lang="bn"> · {place.nameBn}</em> : null}</span>
                <small>{place.kind}{place.parent ? ` · ${place.parent}` : ''}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const shown = (value, unit, tr, number, decimals = 1) => Number.isFinite(value) ? `${number(value.toFixed(decimals))}${unit}` : tr('Not available');

export function WeatherSummary({ route }) {
  const { tr, number } = useLanguage(MAP);
  const { summary } = route;
  const hours = Math.floor(route.durationMinutes / 60);
  const minutes = route.durationMinutes % 60;
  const duration = hours ? tr('{hours} h {minutes} min', { hours, minutes }) : tr('{minutes} min', { minutes });
  return (
    <section className="route-summary" aria-label={tr('Route weather summary')}>
      <p className="route-stats">{tr('{distance} km · about {duration}', { distance: number(route.distanceKm.toFixed(1)), duration })}</p>
      <dl>
        <div><dt>{tr('Peak heat index')}</dt><dd>{shown(summary.maxHeatIndexC, tr('°C'), tr, number)}</dd></div>
        <div><dt>{tr('Peak rain')}</dt><dd>{shown(summary.maxRainMm, tr('mm'), tr, number)}</dd></div>
        <div><dt>{tr('Rain chance')}</dt><dd>{shown(summary.maxRainChancePct, '%', tr, number, 0)}</dd></div>
        <div><dt>{tr('Strongest wind')}</dt><dd>{shown(summary.maxWindKph, tr('km/h'), tr, number)}</dd></div>
        <div><dt>{tr('Thunderstorm potential')}</dt><dd>{shown(summary.maxThunderPotential, ' / 3', tr, number, 0)}</dd></div>
      </dl>
      <p className="route-coverage" role="status">
        {tr('Forecast coverage: {covered} of {total} route samples.', { covered: number(summary.coveredCount), total: number(summary.sampleCount) })}
      </p>
      {summary.forecastStatus !== 'ok' && <p className="route-coverage">{tr('Some route weather data is stale or unavailable.')}</p>}
      {summary.rainUnitUnverified && <p className="route-coverage">{tr('BMD rainfall units have not been verified.')}</p>}
      <p className="route-disclaimer">{tr('Model forecast, not station readings. Weather between sampled locations may differ. Route and ETA are estimates.')}</p>
    </section>
  );
}

// The start/destination form of the route page; the page draws the result.
export function RoutePlanner({ catalogue, onRoute }) {
  const { tr, lang } = useLanguage(MAP);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const updateStart = (value) => { setStart(value); setError(''); onRoute(null); };
  const updateEnd = (value) => { setEnd(value); setError(''); onRoute(null); };
  const swap = () => { setStart(end); setEnd(start); setError(''); onRoute(null); };
  const locate = async () => {
    setLocating(true);
    setError('');
    try {
      updateStart(await currentPlace());
    } catch (locationError) {
      setError(errorText(locationError.message, lang, MAP));
    } finally {
      setLocating(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!start || !end || loading) return;
    setLoading(true);
    setError('');
    try {
      const checkedAt = Date.now();
      const result = await weatherApi.route(
        { name: start.name, lat: start.lat, lon: start.lon },
        { name: end.name, lat: end.lat, lon: end.lon },
      );
      onRoute(result, { start, end, checkedAt });
    } catch (requestError) {
      onRoute(null);
      setError(errorText(requestError.message, lang, MAP));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="route-planner route-planner--page">
      <section className="route-panel panel" aria-label={tr('Plan a route')}>
        <header><div><strong>{tr('Where are you going?')}</strong><small>{tr('Choose two places to see your road route and weather.')}</small></div></header>
        <form onSubmit={submit}>
          <div className="route-journey-inputs">
            <div className="route-input-stop route-input-stop--start">
              <span className="route-input-marker" aria-hidden="true" />
              <PlaceField field="start" label={tr('Start')} catalogue={catalogue} value={start} onChange={updateStart} onSelect={updateStart} />
            </div>
            <div className="route-field-actions">
              <button type="button" className="route-secondary" onClick={locate} disabled={!catalogue || locating}>
                <Icon name="locate" size={16} /> {locating ? tr('Finding your location…') : tr('Use my location as start')}
              </button>
              <button type="button" className="route-secondary route-swap" onClick={swap} disabled={!start && !end} aria-label={tr('Swap start and destination')}>
                <Icon name="refresh" size={16} /> {tr('Swap')}
              </button>
            </div>
            <div className="route-input-stop route-input-stop--end">
              <span className="route-input-marker" aria-hidden="true" />
              <PlaceField field="end" label={tr('Destination')} catalogue={catalogue} value={end} onChange={updateEnd} onSelect={updateEnd} />
            </div>
          </div>
          <button type="submit" className="route-submit" disabled={!start || !end || loading}>
            <Icon name="route" size={18} /> {loading ? tr('Finding route…') : tr('Show my route')}
          </button>
        </form>
        {error && <p className="route-error" role="alert">{error}</p>}
        <p className="route-provider-note">{tr('Road route by OSRM. The routing service receives the selected coordinates.')}</p>
      </section>
    </div>
  );
}
