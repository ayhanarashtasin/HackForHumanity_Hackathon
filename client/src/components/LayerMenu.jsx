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
  open, onToggleOpen, signLayer, signLayers, onToggleSignLayer, onClearSignLayers, onSignLayer, overlays, onToggleOverlay, satelliteLayer, onSatelliteLayer, stormMode, onStormMode, statuses,
}) {
  const { tr } = useLanguage(MAP);
  const baseStatus = statuses?.bmd?.status === 'ok' || !statuses?.openMeteo ? statuses?.bmd?.status : statuses?.openMeteo?.status;

  return (
    <nav className={`layer-menu panel${open ? ' is-open' : ''}`} aria-label={tr('Map layers')}>
      <button id="map-layers-toggle" type="button" className="panel-title" onClick={onToggleOpen} aria-expanded={open} aria-controls="map-layer-options">
        <span className="layer-title"><Icon name="layers" size={19} /> {tr('Map layers')}</span>
        <span className={open ? 'chevron-open' : ''}><Icon name="chevron" size={17} /></span>
      </button>

      {open && (
        <div id="map-layer-options">
          <h2 className="menu-heading">{tr('Weather by district & upazila')}</h2>
          <p id="weather-layer-hint" className="layer-hint">{tr('Select multiple layers, or choose None to hide weather layers.')}</p>
          <div role="group" aria-label={tr('Weather layers')} aria-describedby="weather-layer-hint" className="menu-group">
            <button type="button" className={`menu-item${!signLayers.length ? ' active' : ''}`} aria-pressed={!signLayers.length} onClick={onClearSignLayers}>
              <Icon name="close" size={16} /><span className="menu-label">{tr('None')}</span>
            </button>
            {SIGN_ORDER.map((id) => (
              <label
                key={id}
                className={`menu-item${signLayers.includes(id) ? ' active' : ''}`}
              >
                <input type="checkbox" checked={signLayers.includes(id)} onChange={() => onToggleSignLayer(id)} />
                <span className="swatch" style={{ background: colorAt(SIGN_LAYERS[id].scale, SWATCH_VALUE[id]) }} aria-hidden="true" />
                <span className="menu-label">{tr(SIGN_LAYERS[id].label)}</span>
                {signLayers.includes(id) && <StatusDot status={id === 'thunder' ? statuses?.openMeteo?.status : baseStatus} />}
              </label>
            ))}
          </div>
          {signLayers.length > 0 && <><div className="layer-color-choice"><label htmlFor="weather-color-layer">{tr('Map colors')}</label>
            <select id="weather-color-layer" value={signLayer} onChange={event => onSignLayer(event.target.value)}>
              {signLayers.map(id => <option key={id} value={id}>{tr(SIGN_LAYERS[id].label)}</option>)}
            </select>
          </div>
          <p className="layer-hint">{tr('One layer colors the areas; all selected layers show symbols and hover values.')}</p></>}

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
            <label className={`menu-item${overlays.storms ? ' active' : ''}`}>
              <input type="checkbox" checked={Boolean(overlays.storms)} onChange={() => onToggleOverlay('storms')} />
              <span className="menu-label">{tr('Storm movement')}</span>
            </label>
            {overlays.storms && (
              <div className="sub-choice storm-layer-mode" role="group" aria-label={tr('Storm data')}>
                {[['live', 'Live'], ['demo', 'Historical simulation']].map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={stormMode === key} className={stormMode === key ? 'chip active' : 'chip'} onClick={() => onStormMode(key)}>{tr(label)}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
