import { useState } from 'react';
import { WMO_LABELS } from '../lib/scales.js';
import { STEP_MS, formatBst, formatClock, formatDay, formatRange, toMs } from '../lib/time.js';
import { Chart } from './Chart.jsx';
import { Icon } from './Icon.jsx';
import { useLanguage, translate } from '../i18n/index.js';
import { getLanguage } from '../i18n/language.js';
import { digits as localDigits } from '../alert/format.js';
import { MAP } from '../i18n/map.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (degrees) => (Number.isFinite(degrees) ? COMPASS[Math.round(degrees / 45) % 8] : null);
const THUNDER = ['None', 'Low', 'Moderate', 'High'];
const LIGHTNING_STATE = {
  reported: 'Lightning reported in the sampled window',
  none: 'No lightning records in the sampled window',
  stale: 'Stale (older than one refresh interval)',
  unavailable: 'Unavailable',
  'not-checked': 'Not checked yet',
};

const fmt = (value, places = 0, suffix = '') => Number.isFinite(value)
  ? localDigits(`${value.toFixed(places)}${suffix.startsWith(' ') ? ' ' : ''}${translate(getLanguage(), suffix.trim(), {}, MAP)}`, getLanguage()) : '–';

function weatherIcon(code) {
  if (code >= 95) return 'bolt';
  if (code >= 51) return 'rain';
  if (code === 0 || code === 1) return 'sun';
  return 'cloud';
}

function Stat({ icon, label, value, sub }) {
  return (
    <div className="stat">
      <dt><Icon name={icon} size={16} />{label}</dt>
      <dd>{value}</dd>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function DailyTable({ daily, pcode, loading, error }) {
  const { tr } = useLanguage(MAP);
  const data = daily?.locations?.[pcode];
  if (!data || !daily.days?.length) {
    return <p className="forecast-empty" role="status">{tr(loading ? 'Loading the 10-day forecast…' : error ? 'The 10-day forecast could not be loaded. Please try again later.' : 'A 10-day forecast is not available for this area right now.')}</p>;
  }

  return (
    <section className="daily-outlook">
      <h3>{tr('The days ahead')}</h3>
      <p className="section-description">{tr('Daily temperature range, rainfall and wind.')}</p>
      {daily.sources?.bmd?.status === 'stale' && <p className="note-warning">{tr('This daily forecast is stale.')}</p>}
      <div className="table-scroll">
        <table>
          <caption className="sr-only">{tr('10-day weather forecast')}</caption>
          <thead>
            <tr>{['Day', 'Min', 'Max', 'Rain', 'Wind'].map((label) => <th key={label}>{tr(label)}</th>)}</tr>
          </thead>
          <tbody>
            {daily.days.map((day, i) => (
              <tr key={day}>
                <td>{formatDay(toMs(day))}</td>
                <td>{fmt(data.tmin?.[i], 0, '°')}</td>
                <td>{fmt(data.tmax?.[i], 0, '°')}</td>
                <td>{fmt(data.rf?.[i], 1, ' mm')}</td>
                <td>{fmt(data.ws?.[i], 0, ' km/h')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="muted">{tr('BMD daily values cover 00:00–24:00 UTC (06:00–06:00 BST).')}</small>
    </section>
  );
}

function LightningBlock({ info }) {
  const { tr, lang, number } = useLanguage(MAP);
  if (!info) return null;
  const note = lang === 'bn' && info.noteBn ? number(info.noteBn) : tr(info.note);

  return (
    <section className="panel-section">
      <h3>{tr('Lightning near this location')}</h3>
      {info.items.length === 0 && <p className="muted">{note}</p>}
      {info.items.map((item) => (
        <div key={item.id} className={`lightning-item state-${item.state}`}>
          <strong>{item.kind === 'circle' ? tr('Circle {id} ({radius} km radius)', { id: item.id, radius: item.radiusKm }) : tr('Lightning near this upazila ({radius} km)', { radius: item.radiusKm })}</strong>
          <span>{tr(LIGHTNING_STATE[item.state])}</span>
          {item.count !== null && item.count !== undefined && <span>{tr('Count in the 5-minute window: {n}', { n: item.count })}</span>}
          {item.window && <small>{tr('Window {from} to {to}', { from: formatBst(toMs(item.window.from)), to: formatBst(toMs(item.window.to)) })}</small>}
            {item.detail && <small>{lang === 'bn' && tr(item.detail) === item.detail ? tr('A source or collection warning was recorded. Check the sample time and data status; these records are not live monitoring.') : tr(item.detail)}</small>}
        </div>
      ))}
      {info.items.length > 0 && <small className="muted">{note}</small>}
    </section>
  );
}

export function LocationPanel({ resolved, snapshot, stepIndex, dailyState, lightningInfo, onClose, isUserLocation, location, onStep, baseStatus, loading }) {
  const { tr, lang } = useLanguage(MAP);
  const [tab, setTab] = useState('overview');
  if (!resolved) return null;

  const steps = snapshot?.steps ?? [];
  const times = steps.map(toMs);
  const s = resolved.series;
  const at = (key) => s?.[key]?.[stepIndex] ?? null;
  const isDistrict = resolved.level === 'district';
  const gust = at('wg');
  const speed = at('ws');
  const code = at('wmo');
  const ts = at('ts');
  const direction = compass(at('wd'));
  const temperature = at('temp');
  const available = s && steps.length;
  const tabs = [['overview', 'Overview'], ['trends', '4-day trends'], ['daily', '10 days']];
  const dailyPcode = resolved.dailyPcode;
  const accuracy = location?.position?.accuracy;

  return (
    <section className="location-panel" aria-label={tr('Weather for {name}', { name: resolved.name })}>
      <header className="panel-header">
        <div>
          <p className="map-eyebrow"><Icon name="pin" size={14} />{tr(isUserLocation ? 'Your location' : 'Selected area')}</p>
          <h2>{resolved.name}</h2>
          {lang === 'en' && resolved.nameBn && <p className="bn" lang="bn">{resolved.nameBn}</p>}
          <p className="location-parent">{tr(resolved.kind)} · {resolved.parent}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={tr('Close weather details')}><Icon name="close" size={18} /></button>
      </header>

      {isUserLocation && <p className="location-confirmation" role="status"><Icon name="check" size={15} /> {location.match.note ? tr('Area found · nearest local forecast') : tr('{name} upazila identified from your location', { name: resolved.name })}</p>}
      {isUserLocation && location.match.note && <p className="note">{lang === 'bn' && location.match.noteBn ? location.match.noteBn : tr(location.match.note)}</p>}
      {isUserLocation && accuracy > 1000 && <p className="note">{tr('Your device’s location accuracy is about {km} km. Near a boundary, search to confirm your area.', { km: fmt(accuracy / 1000, 1) })}</p>}
      {resolved.note && <p className="note">{resolved.note}</p>}
      {baseStatus === 'stale' && <p className="note-warning">{tr('This forecast is stale. Check the data status for its last update.')}</p>}

      {!available ? (
        <div className="forecast-empty" role="status"><Icon name="cloud" size={36} /><h3>{tr(loading ? 'Loading your local weather…' : 'Weather is unavailable')}</h3><p>{tr(loading ? 'Your area is ready. The latest forecast will appear here automatically.' : 'We have found this area, but its forecast is not available right now. Missing data does not mean calm weather.')}</p></div>
      ) : (
        <section className="weather-hero">
          <div className="weather-hero-main"><div><span className="weather-temperature">{fmt(temperature)}<span>°C</span></span><p>{tr(WMO_LABELS[code] ?? 'Local forecast')}</p></div><span className="weather-symbol"><Icon name={weatherIcon(code)} size={60} /></span></div>
          <div className="weather-hero-footer"><span><Icon name="clock" size={14} /> {formatRange(times[stepIndex], times[stepIndex] + STEP_MS)}</span><small>{tr(snapshot?.baseLabel ?? 'Forecast')} · {tr(baseStatus === 'stale' ? 'Stale forecast' : 'Model forecast')}</small></div>
        </section>
      )}

      <div className="weather-tabs" role="group" aria-label={tr('Weather detail view')}>
        {tabs.map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)} className={tab === id ? 'active' : ''}>{tr(label)}</button>)}
      </div>

      {tab === 'overview' && available && (
        <>
          <div className="section-heading"><h3>{tr('Your forecast, at a glance')}</h3><span>{tr('Selected 3-hour step')}</span></div>
          <dl className="stats">
            <Stat icon="thermometer" label={tr('Temperature')} value={fmt(temperature, 1, '°C')} sub={isDistrict ? tr('hottest {value}', { value: fmt(at('tempMax'), 1, '°C') }) : tr('Model forecast')} />
            <Stat icon="sun" label={tr('Heat index')} value={fmt(at('hi'), 1, '°C')} sub={isDistrict ? tr('highest {value}', { value: fmt(at('hiMax'), 1, '°C') }) : tr('Computed from heat + humidity')} />
            <Stat icon="rain" label={tr('Rainfall')} value={fmt(at('rf'), 1, ' mm')} sub={isDistrict ? tr('wettest {value}', { value: fmt(at('rfMax'), 1, ' mm') }) : tr('Over this 3-hour step')} />
            <Stat icon="drop" label={tr('Humidity')} value={fmt(at('rh'), 0, '%')} sub={tr('Relative humidity')} />
            <Stat icon="wind" label={tr('Wind')} value={fmt(speed, 0, ' km/h')} sub={`${direction ? tr('From {direction}', { direction: tr(direction) }) : tr('Direction unavailable')}${gust !== null && speed !== null && gust > speed ? ` · ${tr('gusts {value}', { value: fmt(gust, 0, ' km/h') })}` : ''}`} />
            <Stat icon="cloud" label={tr('Cloud cover')} value={fmt(at('cc'), 1, ' / 8')} sub={tr('Sky covered in oktas')} />
            <Stat icon="bolt" label={tr('Thunder potential')} value={ts === null ? '–' : tr(THUNDER[Math.round(ts)] ?? '–')} sub={tr(snapshot.thunderSource ? 'Open-Meteo · not a strike report' : 'Data not available')} />
            <Stat icon="rain" label={tr('Rain chance')} value={fmt(at('pop'), 0, '%')} sub={tr('Open-Meteo probability')} />
          </dl>
          <section className="panel-section">
            <div className="section-heading"><h3>{tr('The next 24 hours')}</h3><span>{tr('Every 3 hours')}</span></div>
            <div className="hourly-strip" aria-label={tr('Upcoming forecast steps')}>
              {times.slice(stepIndex, stepIndex + 8).map((time, i) => (
                <button key={time} type="button" onClick={() => onStep(stepIndex + i)} aria-pressed={i === 0} aria-label={tr('{time}, {temp} degrees, rain {rain} millimetres', { time: formatBst(time), temp: fmt(s.temp?.[stepIndex + i]), rain: fmt(s.rf?.[stepIndex + i], 1) })}>
                  <small>{i === 0 ? tr('Selected') : formatClock(time)}</small><Icon name={weatherIcon(s.wmo?.[stepIndex + i])} size={22} /><strong>{fmt(s.temp?.[stepIndex + i], 0, '°')}</strong><span>{fmt(s.rf?.[stepIndex + i], 1, ' mm')}</span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {tab === 'trends' && available && (
          <section className="weather-trends">
            <h3>{tr('A four-day view')}</h3><p className="section-description">{tr('Temperature, rainfall and wind in 3-hour steps.')}</p>
            <Chart
              title="Temperature and heat index"
              unit="°C"
              times={times}
              selectedIndex={stepIndex}
              series={[
                { label: 'Temperature', color: '#E0662F', values: s.temp ?? [] },
                { label: 'Heat index', color: '#B8312B', dash: '4 3', values: s.hi ?? [] },
              ]}
            />
            <Chart
              title="Rain"
              unit="mm"
              times={times}
              selectedIndex={stepIndex}
              maxFloor={1}
              decimals={1}
              series={[{ label: isDistrict ? 'District mean' : 'Forecast', color: '#3B86C6', type: 'bar', values: s.rf ?? [] }]}
            />
            <Chart
              title="Wind"
              unit="km/h"
              times={times}
              selectedIndex={stepIndex}
              zeroBase
              series={[
                { label: 'Speed', color: '#2E3D28', values: s.ws ?? [] },
                { label: 'Gust', color: '#6F8A4B', dash: '4 3', values: s.wg ?? [] },
              ]}
            />
            {s.ts && (
              <Chart
                title="Thunderstorm potential"
                unit="0–3"
                times={times}
                selectedIndex={stepIndex}
                maxFloor={3}
                series={[{ label: 'Level', color: '#D9480F', type: 'bar', values: s.ts }]}
              />
            )}
          </section>
      )}

      {tab === 'daily' && (dailyPcode ? <DailyTable daily={dailyState.data} pcode={dailyPcode} loading={dailyState.loading} error={dailyState.error} /> : <p className="forecast-empty">{tr('Search for an individual upazila or city thana to see its 10-day forecast.')}</p>)}
      {dailyPcode && <LightningBlock info={lightningInfo} />}

      <footer className="panel-footer">
        <small>
          {tr('{source}: model forecast, not an observation or an official warning.', { source: tr(snapshot?.baseLabel ?? 'Forecast') })}
          {snapshot?.thunderSource ? ` ${tr('Thunderstorm potential and weather text: Open-Meteo.')}` : ''}
        </small>
      </footer>
    </section>
  );
}
