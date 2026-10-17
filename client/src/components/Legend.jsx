import { SCALES, SIGN_LAYERS, WMO_LABELS } from '../lib/scales.js';
import { formatBst } from '../lib/time.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { STORM_COLORS, STORM_INTENSITY, STORM_STEPS } from '../lib/stormMap.js';

const THUNDER_LABELS = ['Low', 'Moderate', 'High'];

function WeatherScale({ id }) {
  const { tr, number } = useLanguage(MAP);
  return <div className="legend-bar">{SCALES[SIGN_LAYERS[id].scale].stops.map(([value, color], i) => <div className="legend-stop" key={value}><span style={{ background: color }} /><small>{id === 'thunder' ? tr(THUNDER_LABELS[i]) : number(value)}</small></div>)}</div>;
}

export function MapKey({ signLayer, signLayers = [signLayer], overlays, storms, lightning, onInspect }) {
  const { tr, number } = useLanguage(MAP);
  const snapshot = storms?.visible ? storms.snapshot : null;
  return (
    <details className="map-key panel">
      <summary>{tr('Map key & indicator details')}</summary>
      <div className="map-key-content">
        <p>{tr('Hover or tap a symbol or outline to learn what it means.')}</p>
        {signLayers.map(id => <section className="key-weather-scale" key={id}>
          <strong>{tr(SIGN_LAYERS[id].label)} ({tr(SIGN_LAYERS[id].unit)}) · {tr(id === signLayer ? 'Map colors' : 'Symbols only')}</strong>
          <WeatherScale id={id} />
        </section>)}
        <p>{tr(signLayers.length ? 'Colors follow the selected weather scale, not a general safe-to-danger rating.' : 'Weather layers are hidden. Active overlays are unchanged.')}</p>
        {signLayers.length > 1 && <p>{tr('Zoom in to separate nearby symbols. Hover an area to compare all selected values.')}</p>}
        {overlays.storms && <>
          <strong>{tr('Storm cloud-top intensity · experimental')}</strong>
          <ul>{Object.entries(STORM_COLORS).map(([intensity, color]) => <li key={intensity}><i className="key-cell" style={{ background: color }} aria-hidden="true" />{tr(STORM_INTENSITY[intensity])}</li>)}
            <li><i className="key-ring" aria-hidden="true" />{tr('Dashed circles: positions at +30 / +60 / +90 min')}</li>
            <li><i className="key-track" aria-hidden="true" />{tr('White arrows: storm movement direction')}</li>
            <li><i className="key-arrival" aria-hidden="true" />{tr('Amber areas: possible arrival within 30 or 60 min')}</li>
          </ul>
        </>}
        {(overlays.storms || overlays.satellite || overlays.radar) && <p>{tr('Weather colors and image colors are different layers. Green does not automatically mean safe; image pixels have no exact reading here.')}</p>}
        {overlays.lightning && <p>{tr('Lightning circles show sampled search areas, not individual strikes. Green means no records in that sample, not safe weather.')}</p>}
        {((snapshot?.cells?.length ?? 0) > 0 || (lightning?.visible && lightning.items.length > 0)) && <label className="map-key-select">{tr('Inspect a map indicator')}
          <select value="" onChange={event => { if (event.target.value) onInspect(JSON.parse(event.target.value)); }}>
            <option value="">{tr('Choose an indicator…')}</option>
            {snapshot?.cells?.map((cell, index) => <optgroup key={cell.id} label={tr('Storm {n} · {intensity}', { n: number(index + 1), intensity: tr(STORM_INTENSITY[cell.intensity] ?? 'Strong') })}>
              <option value={JSON.stringify({ type: 'storm', id: cell.id, kind: 'cell' })}>{tr('Storm cell')}</option>
              {cell.motion && cell.forecast?.filter(step => STORM_STEPS.includes(step.minutes)).map(step => <option key={step.minutes} value={JSON.stringify({ type: 'storm', id: cell.id, kind: 'ring', minutes: step.minutes })}>{tr('Predicted position · +{n} min', { n: number(step.minutes) })}</option>)}
            </optgroup>)}
            {lightning?.visible && lightning.items.map(item => <option key={item.id} value={JSON.stringify({ type: 'lightning', id: item.id })}>{tr('Lightning')}: {item.name ?? tr('Circle {id}', { id: item.id })}</option>)}
          </select>
        </label>}
        <p>{tr('This is not an official warning. Follow BMD warnings and local guidance.')}</p>
      </div>
    </details>
  );
}

export function Legend({ signLayer, signLayers = [signLayer], baseStatus, baseLabel, overlays, radarTime, satelliteTime, satelliteLayer, mode }) {
  const { tr } = useLanguage(MAP);
  const layer = SIGN_LAYERS[signLayer];
  if (!layer) return null;
  const problem = baseStatus === 'stale' || baseStatus === 'unavailable' || baseStatus === 'not-checked';

  return (
    <aside className="legend panel" aria-label={tr('Legend')}>
      <div className="legend-title">
        <strong>{signLayers.length > 1 ? tr('Map colors: {layer}', { layer: tr(layer.label) }) : tr(layer.label)}</strong>
        <span>{tr(layer.unit)}</span>
      </div>

      <WeatherScale id={signLayer} />
      {signLayers.length > 1 && <p className="legend-selected">{tr('Also showing: {layers}', { layers: signLayers.filter(id => id !== signLayer).map(id => tr(SIGN_LAYERS[id].label)).join(' · ') })}</p>}

      {problem && (
        <p className={`legend-warning legend-${baseStatus}`} role="status">
          {baseStatus === 'stale' && tr('{source} data is stale: colors are muted.', { source: tr(baseLabel ?? 'Forecast') })}
          {baseStatus === 'unavailable' && tr('Weather data is unavailable right now. Grey dots mean no data, not calm weather.')}
          {baseStatus === 'not-checked' && tr('Loading weather data...')}
        </p>
      )}

      <details className="legend-details">
        <summary>{tr('About this layer')}</summary>
        <p className="legend-note">{tr(layer.note)}</p>
        {signLayer === 'thunder' && <p className="legend-note">{tr('Weather text such as “{weather}” comes from Open-Meteo.', { weather: tr(WMO_LABELS[95]) })}</p>}
      </details>

      {mode === 'live' && overlays.radar && (
        <p className="legend-overlay"><b>{tr('Radar')}</b> {tr('BMD surface rain rate')}{radarTime ? ` · ${formatBst(radarTime)}` : ''}</p>
      )}
      {mode === 'live' && overlays.satellite && (
        <p className="legend-overlay"><b>{tr('Satellite')}</b> Himawari-9 {tr(satelliteLayer === 'ir' ? 'Infrared' : 'Visible')}{satelliteTime ? ` · ${formatBst(satelliteTime)}` : ''}</p>
      )}
      {mode === 'forecast' && (overlays.radar || overlays.satellite) && (
        <p className="legend-overlay">{tr('Radar and satellite show observations only. Switch to Live to see them.')}</p>
      )}
    </aside>
  );
}
