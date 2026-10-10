import { formatBst } from '../lib/time.js';

const LABELS = { ok: 'OK', stale: 'Stale', unavailable: 'Unavailable', 'not-checked': 'Not loaded yet' };

export function StatusPanel({ open, onToggle, statuses, base }) {
  const entries = Object.values(statuses ?? {}).filter(Boolean);
  const worst = entries.some((entry) => entry.status === 'unavailable') ? 'unavailable'
    : entries.some((entry) => entry.status === 'stale') ? 'stale'
      : entries.every((entry) => entry.status === 'ok') && entries.length ? 'ok' : 'not-checked';

  return (
    <div className="status">
      <button type="button" className="panel icon-text-button" onClick={onToggle} aria-expanded={open} aria-controls="status-popover">
        <span className={`dot dot-${worst}`} aria-hidden="true" />
        Data
      </button>

      {open && (
        <div id="status-popover" className="status-popover panel" role="dialog" aria-label="Data sources and status">
          <h2>Data sources</h2>
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <span className={`dot dot-${entry.status}`} aria-hidden="true" />
                <div>
                  <strong>{entry.label}</strong>
                  <small>
                    {LABELS[entry.status]}
                    {entry.dataTime ? ` · data ${formatBst(new Date(entry.dataTime).getTime())}` : ''}
                  </small>
                  {entry.message && <small className="warn">{entry.message}</small>}
                </div>
              </li>
            ))}
          </ul>
          {base === 'open-meteo' && <p className="note-warning">BMD forecasts are not available, so values come from Open-Meteo.</p>}
          <h2>How to read the map</h2>
          <ul className="plain">
            <li>Temperature, rain and wind are <b>forecast model values</b> from BMD, not station measurements. Heat index is computed from them.</li>
            <li>Radar and satellite are <b>observations</b>; satellite frames are about an hour behind real time.</li>
            <li>Thunderstorm signs show <b>potential</b> (Open-Meteo), not lightning strikes.</li>
            <li>Grey means no data. It never means calm weather.</li>
            <li>This is not an official warning. Follow BMD warnings and local guidance.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
