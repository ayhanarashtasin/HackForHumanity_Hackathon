import { formatBst } from '../lib/time.js';
import { errorText, useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

const LABELS = { ok: 'OK', stale: 'Stale', unavailable: 'Unavailable', 'not-checked': 'Not loaded yet' };

export function StatusPanel({ open, onToggle, statuses, base }) {
  const { tr, lang } = useLanguage(MAP);
  const entries = Object.values(statuses ?? {}).filter(Boolean);
  const worst = entries.some((entry) => entry.status === 'unavailable') ? 'unavailable'
    : entries.some((entry) => entry.status === 'stale') ? 'stale'
      : entries.every((entry) => entry.status === 'ok') && entries.length ? 'ok' : 'not-checked';

  return (
    <div className="status">
      <button type="button" className="panel icon-text-button" onClick={onToggle} aria-expanded={open} aria-controls="status-popover">
        <span className={`dot dot-${worst}`} aria-hidden="true" />
        {tr('Data')}
      </button>

      {open && (
        <div id="status-popover" className="status-popover panel" role="dialog" aria-label={tr('Data sources and status')}>
          <h2>{tr('Data sources')}</h2>
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <span className={`dot dot-${entry.status}`} aria-hidden="true" />
                <div>
                  <strong>{tr(entry.label)}</strong>
                  <small>
                    {tr(LABELS[entry.status])}
                    {entry.dataTime ? ` · ${tr('Data time: {time}', { time: formatBst(new Date(entry.dataTime).getTime()) })}` : ''}
                  </small>
                  {entry.message && <small className="warn">{errorText(entry.message, lang, MAP)}</small>}
                </div>
              </li>
            ))}
          </ul>
          {base === 'open-meteo' && <p className="note-warning">{tr('BMD forecasts are not available, so values come from Open-Meteo.')}</p>}
          <h2>{tr('How to read the map')}</h2>
          <ul className="plain">
            <li>{tr('Temperature, rain and wind are forecast model values from BMD, not station measurements. Heat index is computed from them.')}</li>
            <li>{tr('Radar and satellite are observations; satellite frames are about an hour behind real time.')}</li>
            <li>{tr('Thunderstorm signs show potential (Open-Meteo), not lightning strikes.')}</li>
            <li>{tr('Grey means no data. It never means calm weather.')}</li>
            <li>{tr('This is not an official warning. Follow BMD warnings and local guidance.')}</li>
            {lang === 'bn' && <li>{tr('Place names and numbers on the map canvas remain in English; search and area details use your selected language.')}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
