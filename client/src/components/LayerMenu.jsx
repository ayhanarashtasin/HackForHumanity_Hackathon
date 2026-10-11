import { SIGN_LAYERS, SIGN_ORDER, colorAt } from '../lib/scales.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

const SWATCH_VALUE = { temp: 32, heat: 39, rain: 5, wind: 30, thunder: 2 };

function StatusDot({ status }) {
  const { tr } = useLanguage(MAP);
  return <span className={`dot dot-${status ?? 'not-checked'}`} title={tr('Data status: {status}', { status: tr(status === 'ok' ? 'Fresh' : status === 'stale' ? 'Stale' : status === 'unavailable' ? 'Unavailable' : 'Not checked yet') })} aria-hidden="true" />;
}

export function LayerMenu({
  open, onToggleOpen, signLayer, onSignLayer, overlays, onToggleOverlay, satelliteLayer, onSatelliteLayer, statuses,
}) {
  const { tr } = useLanguage(MAP);
  const baseStatus = statuses?.bmd?.status === 'ok' || !statuses?.openMeteo ? statuses?.bmd?.status : statuses?.openMeteo?.status;

  return (
    <nav className="layer-menu panel" aria-label={tr('Map layers')}>
      <button type="button" className="panel-title" onClick={onToggleOpen} aria-expanded={open} aria-controls="map-layer-options">
        <span className="layer-title"><Icon name="layers" size={19} /> {tr('Map layers')}</span>
        <span className={open ? 'chevron-open' : ''}><Icon name="chevron" size={17} /></span>
      </button>

      {open && (
        <div id="map-layer-options">
          <h2 className="menu-heading">{tr('Weather by district & upazila')}</h2>
          <div role="radiogroup" aria-label={tr('Weather sign')} className="menu-group">
            {SIGN_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={signLayer === id}
                className={`menu-item${signLayer === id ? ' active' : ''}`}
                onClick={() => onSignLayer(id)}
              >
                <span className="swatch" style={{ background: colorAt(SIGN_LAYERS[id].scale, SWATCH_VALUE[id]) }} aria-hidden="true" />
                <span className="menu-label">{tr(SIGN_LAYERS[id].label)}</span>
                {signLayer === id && <StatusDot status={id === 'thunder' ? statuses?.openMeteo?.status : baseStatus} />}
              </button>
            ))}
          </div>

          <h2 className="menu-heading">{tr('Overlays')}</h2>
          <div className="menu-group">
            <label className={`menu-item${overlays.radar ? ' active' : ''}`}>
              <input type="checkbox" checked={overlays.radar} onChange={() => onToggleOverlay('radar')} />
              <span className="menu-label">{tr('Radar')}</span>
              <StatusDot status={statuses?.radar?.status} />
            </label>
            <label className={`menu-item${overlays.satellite ? ' active' : ''}`}>
              <input type="checkbox" checked={overlays.satellite} onChange={() => onToggleOverlay('satellite')} />
              <span className="menu-label">{tr('Satellite')}</span>
              <StatusDot status={statuses?.satellite?.status} />
            </label>
            {overlays.satellite && (
              <div className="sub-choice" role="radiogroup" aria-label={tr('Satellite band')}>
                {[['ir', 'Infrared'], ['visible', 'Visible']].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={satelliteLayer === key}
                    className={satelliteLayer === key ? 'chip active' : 'chip'}
                    onClick={() => onSatelliteLayer(key)}
                  >
                    {tr(label)}
                  </button>
                ))}
              </div>
            )}
            <label className={`menu-item${overlays.lightning ? ' active' : ''}`}>
              <input type="checkbox" checked={overlays.lightning} onChange={() => onToggleOverlay('lightning')} />
              <span className="menu-label">{tr('Lightning summaries')}</span>
            </label>
          </div>
        </div>
      )}
    </nav>
  );
}
