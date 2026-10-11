import { SCALES, SIGN_LAYERS, WMO_LABELS } from '../lib/scales.js';
import { formatBst } from '../lib/time.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

const THUNDER_LABELS = ['Low', 'Moderate', 'High'];

export function Legend({ signLayer, baseStatus, baseLabel, overlays, radarTime, satelliteTime, satelliteLayer, mode }) {
  const { tr, number } = useLanguage(MAP);
  const layer = SIGN_LAYERS[signLayer];
  const stops = SCALES[layer.scale].stops;
  const problem = baseStatus === 'stale' || baseStatus === 'unavailable' || baseStatus === 'not-checked';

  return (
    <aside className="legend panel" aria-label={tr('Legend')}>
      <div className="legend-title">
        <strong>{tr(layer.label)}</strong>
        <span>{tr(layer.unit)}</span>
      </div>

      <div className="legend-bar">
        {stops.map(([value, color], i) => (
          <div key={value} className="legend-stop">
            <span style={{ background: color }} />
            <small>{signLayer === 'thunder' ? tr(THUNDER_LABELS[i]) : number(value)}</small>
          </div>
        ))}
      </div>

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
