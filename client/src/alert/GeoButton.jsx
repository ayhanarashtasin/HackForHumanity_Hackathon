import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon.jsx';
import { useUserLocation } from '../hooks/useUserLocation.js';
import { areaLabel } from '../lib/alertForm.js';
import { useAlert } from './context.js';

// Suggest the shared area, but never assume the visitor is at home or overwrite a manual choice.
export function GeoButton({ onFound, value }) {
  const { tr, lang, catalogue, index } = useAlert();
  const location = useUserLocation();
  const request = useRef(0);
  useEffect(() => {
    ++request.current;
    return () => { ++request.current; };
  }, [value]);
  const busy = ['locating', 'resolving'].includes(location.status);
  const ready = location.status === 'ready' && location.pcode;
  const problem = { denied: 'gps.denied', unsupported: 'gps.unsupported', outside: 'gps.outside', inaccurate: 'live.inaccurate', error: 'gps.error' }[location.status];
  const find = async () => {
    const id = ++request.current;
    const found = await location.requestLocation();
    if (id === request.current && found.status === 'ready' && found.pcode) onFound(found.pcode);
  };

  return (
    <div className="alert-geo">
      <button type="button" className="alert-button alert-button--ghost" onClick={find} disabled={!catalogue || busy}>
        <Icon name="locate" size={18} />
        {tr(busy ? 'gps.busy' : ready ? 'gps.useDetected' : 'gps.button')}
      </button>
      <p className="alert-help">{tr('gps.note')}</p>
      {ready && <p className="alert-note" role="status">{tr('gps.suggest', { name: areaLabel(index, location.pcode, lang) })}</p>}
      {problem && <p className="alert-field-error" role="status">{tr(problem)}</p>}
    </div>
  );
}
