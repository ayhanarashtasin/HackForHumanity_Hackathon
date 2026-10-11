import { useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { areaLabel, pcodeFromSelection } from '../lib/alertForm.js';
import { locateUpazila } from '../lib/locate.js';
import { useAlert } from './context.js';

// "Use my location": asks the browser for a position only when the button is pressed, finds the nearest upazila on this device, and
// reports just that area code. The coordinates are never stored, sent or kept in state.
export function GeoButton({ onFound }) {
  const { tr, lang, catalogue, index } = useAlert();
  const [state, setState] = useState({ status: 'idle', key: null });
  const request = useRef(0);

  const fail = (key) => setState({ status: 'error', key });

  const find = () => {
    if (!catalogue) return;
    const current = ++request.current;
    if (!window.isSecureContext || !navigator.geolocation) { fail('gps.unsupported'); return; }
    setState({ status: 'busy', key: null });

    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const response = await fetch('/data/bd-upazila.geojson');
        if (!response.ok) throw new Error('boundaries');
        const match = locateUpazila({ lon: coords.longitude, lat: coords.latitude }, await response.json(), catalogue);
        if (current !== request.current) return;
        const pcode = match ? pcodeFromSelection(match.selection, catalogue) : null;
        if (!pcode) { fail('gps.outside'); return; }
        onFound(pcode);
        setState({ status: 'found', key: 'gps.found', pcode });
      } catch {
        if (current === request.current) fail('gps.load');
      }
    }, (error) => {
      if (current === request.current) fail(error.code === 1 ? 'gps.denied' : 'gps.error');
    }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
  };

  return (
    <div className="alert-geo">
      <button type="button" className="alert-button alert-button--ghost" onClick={find} disabled={!catalogue || state.status === 'busy'}>
        <Icon name="locate" size={18} />
        {state.status === 'busy' ? tr('gps.busy') : tr('gps.button')}
      </button>
      <p className="alert-help">{tr('gps.note')}</p>
      {state.key && <p className={state.status === 'error' ? 'alert-field-error' : 'alert-note'} role={state.status === 'error' ? 'alert' : 'status'}>{tr(state.key, { name: areaLabel(index, state.pcode, lang) })}</p>}
    </div>
  );
}
