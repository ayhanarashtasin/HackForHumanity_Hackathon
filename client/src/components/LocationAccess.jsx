import { Icon } from './Icon.jsx';

export function LocationAccess({ location, onLocate, onSearch }) {
  const busy = location.status === 'locating' || location.status === 'resolving';
  const problem = ['denied', 'error', 'outside', 'unsupported'].includes(location.status);
  return (
    <section className="location-access" aria-labelledby="location-access-title">
      <span className={`location-illustration${busy ? ' is-locating' : ''}`}><Icon name="locate" size={38} /></span>
      <p className="map-eyebrow">A little closer to your sky</p>
      <h2 id="location-access-title">{busy ? 'Finding your place.' : problem ? 'Let’s find your area.' : 'Your weather starts here.'}</h2>
      <p className="access-description" role="status">
        {location.status === 'locating' ? 'Allow location in your browser to find your upazila and open its local forecast automatically.'
          : location.status === 'resolving' ? 'Location received. Checking which upazila you are in…'
            : location.message || 'Find your upazila, understand the day ahead, and explore the weather around you.'}
      </p>
      <button type="button" className="map-primary-button" onClick={onLocate} disabled={busy || location.status === 'unsupported'}>
        {busy ? <span className="map-spinner" aria-hidden="true" /> : <Icon name="locate" size={19} />}
        {busy ? 'Finding your upazila…' : problem ? 'Try my location again' : 'Use my location'}
      </button>
      <button type="button" className="map-secondary-button" onClick={onSearch}><Icon name="search" size={18} /> Search for an upazila</button>
      <small className="location-privacy">Your position is used in this browser to find your area. It is not sent to the weather service.</small>
      <div className="access-features">
        <div><Icon name="pin" /><span><strong>Your area, identified</strong><small>Upazila boundaries across Bangladesh</small></span></div>
        <div><Icon name="cloud" /><span><strong>The whole weather picture</strong><small>Temperature, rain, wind and more</small></span></div>
        <div><Icon name="clock" /><span><strong>Ahead of the day</strong><small>3-hour forecasts and a 10-day outlook</small></span></div>
      </div>
    </section>
  );
}
