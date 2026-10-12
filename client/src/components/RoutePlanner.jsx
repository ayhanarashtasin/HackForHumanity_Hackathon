import { useMemo, useState } from 'react';
import { Icon } from './Icon.jsx';
import { errorText, useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { weatherApi } from '../services/weatherApi.js';

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
    ].map((place) => ({ ...place, search: `${place.name} ${place.nameBn ?? ''}`.toLowerCase() }));
  }, [catalogue, name, tr]);
  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (text.length < 2) return [];
    return index.filter((place) => place.search.includes(text)).slice(0, 6);
  }, [index, query]);
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
        value={value ? `${name(value)}${value.parent ? `, ${value.parent}` : ''}` : query}
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

function WeatherSummary({ route }) {
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

export function RoutePlanner({ catalogue, onRoute, onInteraction }) {
  const { tr, lang } = useLanguage(MAP);
  const [expanded, setExpanded] = useState(false);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [route, setRoute] = useState(null);
  const updateStart = (value) => { setStart(value); setRoute(null); setError(''); onRoute(null); };
  const updateEnd = (value) => { setEnd(value); setRoute(null); setError(''); onRoute(null); };

  const submit = async (event) => {
    event.preventDefault();
    if (!start || !end || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await weatherApi.route(
        { name: start.name, lat: start.lat, lon: start.lon },
        { name: end.name, lat: end.lat, lon: end.lon },
      );
      setRoute(result);
      onRoute(result);
    } catch (requestError) {
      setRoute(null);
      onRoute(null);
      setError(errorText(requestError.message, lang, MAP));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="route-planner" onPointerEnter={onInteraction}>
      <button type="button" className="route-toggle panel" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <Icon name="map" size={18} /> {tr('Route')}
      </button>
      {expanded && (
        <section className="route-panel panel" aria-label={tr('Plan a route')}>
          <header><div><strong>{tr('Route weather')}</strong><small>{tr('Fastest driving route')}</small></div><button type="button" className="route-close" aria-label={tr('Close route planner')} onClick={() => setExpanded(false)}>×</button></header>
          <form onSubmit={submit}>
            <PlaceField field="start" label={tr('Start')} catalogue={catalogue} value={start} onChange={updateStart} onSelect={updateStart} />
            <PlaceField field="end" label={tr('Destination')} catalogue={catalogue} value={end} onChange={updateEnd} onSelect={updateEnd} />
            <button type="submit" className="route-submit" disabled={!start || !end || loading}>
              {loading ? tr('Finding route…') : tr('Show route weather')}
            </button>
          </form>
          {error && <p className="route-error" role="alert">{error}</p>}
          {route && <WeatherSummary route={route} />}
          <p className="route-provider-note">{tr('Road route by OSRM. The routing service receives the selected coordinates.')}</p>
        </section>
      )}
    </div>
  );
}