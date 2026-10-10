import { SCALES, SIGN_LAYERS, WMO_LABELS } from '../lib/scales.js';
import { formatBst } from '../lib/time.js';

const THUNDER_LABELS = ['Low', 'Moderate', 'High'];

export function Legend({ signLayer, baseStatus, baseLabel, overlays, radarTime, satelliteTime, satelliteLayer, mode }) {
  const layer = SIGN_LAYERS[signLayer];
  const stops = SCALES[layer.scale].stops;
  const problem = baseStatus === 'stale' || baseStatus === 'unavailable' || baseStatus === 'not-checked';

  return (
    <aside className="legend panel" aria-label="Legend">
      <div className="legend-title">
        <strong>{layer.label}</strong>
        <span>{layer.unit}</span>
      </div>

      <div className="legend-bar">
        {stops.map(([value, color], i) => (
          <div key={value} className="legend-stop">
            <span style={{ background: color }} />
            <small>{signLayer === 'thunder' ? THUNDER_LABELS[i] : value}</small>
          </div>
        ))}
      </div>

      {problem && (
        <p className={`legend-warning legend-${baseStatus}`} role="status">
          {baseStatus === 'stale' && `${baseLabel ?? 'Forecast'} data is stale: colors are muted.`}
          {baseStatus === 'unavailable' && 'Weather data is unavailable right now. Grey dots mean no data, not calm weather.'}
          {baseStatus === 'not-checked' && 'Loading weather data...'}
        </p>
      )}

      <details className="legend-details">
        <summary>About this layer</summary>
        <p className="legend-note">{layer.note}</p>
        {signLayer === 'thunder' && <p className="legend-note">Weather text such as “{WMO_LABELS[95]}” comes from Open-Meteo.</p>}
      </details>

      {mode === 'live' && overlays.radar && (
        <p className="legend-overlay"><b>Radar</b> BMD surface rain rate{radarTime ? ` · ${formatBst(radarTime)}` : ''}</p>
      )}
      {mode === 'live' && overlays.satellite && (
        <p className="legend-overlay"><b>Satellite</b> Himawari-9 {satelliteLayer === 'ir' ? 'infrared' : 'visible'}{satelliteTime ? ` · ${formatBst(satelliteTime)}` : ''}</p>
      )}
      {mode === 'forecast' && (overlays.radar || overlays.satellite) && (
        <p className="legend-overlay">Radar and satellite show observations only. Switch to Live to see them.</p>
      )}
    </aside>
  );
}
