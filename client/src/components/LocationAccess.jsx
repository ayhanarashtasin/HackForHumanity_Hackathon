import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

export function LocationAccess({ location, onLocate, onSearch }) {
  const { tr } = useLanguage(MAP);
  const busy = location.status === 'locating' || location.status === 'resolving';
  const problem = ['denied', 'error', 'outside', 'unsupported'].includes(location.status);
  return (
    <section className="location-access" aria-labelledby="location-access-title">
      <span className={`location-illustration${busy ? ' is-locating' : ''}`}><Icon name="locate" size={38} /></span>
      <p className="map-eyebrow">{tr('A little closer to your sky')}</p>
      <h2 id="location-access-title">{tr(busy ? 'Finding your place.' : problem ? 'Let’s find your area.' : 'Your weather starts here.')}</h2>
      <p className="access-description" role="status">
        {tr(location.status === 'locating' ? 'Allow location in your browser to find your upazila and open its local forecast automatically.'
          : location.status === 'resolving' ? 'Location received. Checking which upazila you are in…'
            : location.message || 'Find your upazila, understand the day ahead, and explore the weather around you.')}
      </p>
      <button type="button" className="map-primary-button" onClick={onLocate} disabled={busy || location.status === 'unsupported'}>
        {busy ? <span className="map-spinner" aria-hidden="true" /> : <Icon name="locate" size={19} />}
        {tr(busy ? 'Finding your upazila…' : problem ? 'Try my location again' : 'Use my location')}
      </button>
      <button type="button" className="map-secondary-button" onClick={onSearch}><Icon name="search" size={18} /> {tr('Search for an upazila')}</button>
      <small className="location-privacy">{tr('Your position is used in this browser to find your area. It is not sent to the weather service.')}</small>
      <div className="access-features">
        <div><Icon name="pin" /><span><strong>{tr('Your area, identified')}</strong><small>{tr('Upazila boundaries across Bangladesh')}</small></span></div>
        <div><Icon name="cloud" /><span><strong>{tr('The whole weather picture')}</strong><small>{tr('Temperature, rain, wind and more')}</small></span></div>
        <div><Icon name="clock" /><span><strong>{tr('Ahead of the day')}</strong><small>{tr('3-hour forecasts and a 10-day outlook')}</small></span></div>
      </div>
    </section>
  );
}
