import { STORM_COLORS, STORM_INTENSITY } from '../lib/stormMap.js';
import { formatClock, formatDay, relativeLabel, toMs } from '../lib/time.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import './storm-panel.css';

const TREND = { growing: 'Growing', steady: 'Steady', weakening: 'Weakening' };
const SHOWN_CELLS = 4;

// What the snapshot means for the selected upazila: a storm warning applies (the API's arrivals, counted from now), it was under a
// cell on the image, or no warning-strength storm is heading there.
function forArea(snapshot, pcode) {
  const warned = snapshot?.arrivals?.find((arrival) => arrival.pcode === pcode);
  if (warned) return { kind: 'warned', arrivalMs: toMs(warned.arrivalAt), minutes: warned.minutesFromNow };
  const under = (snapshot?.cells ?? []).some((cell) => cell.reaches?.some((place) => place.pcode === pcode && place.etaMin === 0));
  return under ? { kind: 'under' } : null;
}

function CellRow({ cell }) {
  const { tr, number } = useLanguage(MAP);
  return (
    <li className="storm-cell-row">
      <span className="storm-swatch" style={{ background: STORM_COLORS[cell.intensity] }} aria-hidden="true" />
      <div>
        <strong>{tr(STORM_INTENSITY[cell.intensity] ?? 'Strong')} · {number(cell.areaKm2)} {tr('km²')}</strong>
        <span>
          {cell.motion
            ? tr('Moving {dir} at {speed} km/h', { dir: tr(cell.motion.towards), speed: number(Math.round(cell.motion.speedKmh)) })
            : tr('Movement not measured yet')}
          {cell.trend ? ` · ${tr(TREND[cell.trend])}` : ''}
        </span>
      </div>
    </li>
  );
}

export function StormPanel({ mode, onMode, live, liveError, demo, demoError, demoIndex, onDemoIndex, playing, onPlay, onClose, selectedPcode, selectedName }) {
  const { tr, number } = useLanguage(MAP);
  const snapshots = demo?.snapshots ?? [];
  const snapshot = mode === 'demo' ? snapshots[demoIndex] : live?.live;
  const observedMs = snapshot?.observedAt ? toMs(snapshot.observedAt) : null;
  const cells = snapshot?.cells ?? [];
  const area = selectedPcode ? forArea(snapshot, selectedPcode) : null;
  const step = (delta) => onDemoIndex((demoIndex + delta + snapshots.length) % snapshots.length);

  let liveNote = null;
  if (mode === 'live') {
    if (liveError) liveNote = 'Storm tracking could not be loaded.';
    else if (!live) liveNote = 'Loading storm tracking…';
    else if (!live.enabled) liveNote = 'Storm tracking is off: the ML service is not running.';
    else if (!live.live) liveNote = live.error ? 'The satellite analysis failed; trying again in a few minutes.' : 'Waiting for the first satellite analysis…';
  }

  return (
    <section id="storm-movement-panel" className="storm-panel panel" tabIndex={-1} aria-label={tr('Storm movement')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }}>
      <header className="storm-header">
        <span className="storm-heading-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span>
        <div><h2>{tr('Storm movement')}</h2><p>{tr('Himawari-9 satellite')}</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={tr('Turn off storm movement')}><Icon name="close" size={18} /></button>
      </header>

      <div className="storm-controls">
        <div className="storm-mode" role="radiogroup" aria-label={tr('Storm data')}>
          {[['live', 'Live'], ['demo', 'Historical simulation']].map(([key, label]) => (
            <button key={key} type="button" role="radio" aria-checked={mode === key} className={mode === key ? 'chip active' : 'chip'} onClick={() => onMode(key)}>{tr(label)}</button>
          ))}
        </div>

        {mode === 'demo' && <p className="storm-note">{tr('Historical storm movement for simulation only — not live weather or a current warning.')}</p>}

        {mode === 'demo' && (
          demoError ? <p className="storm-note">{tr('The replay could not be loaded.')}</p>
            : !snapshots.length ? <p className="storm-note" role="status">{tr('Preparing the replay…')}</p>
              : (
                <div className="storm-player">
                  <button type="button" className="icon-button" onClick={onPlay} aria-label={tr(playing ? 'Pause' : 'Play')}><Icon name={playing ? 'pause' : 'play'} size={17} /></button>
                  <button type="button" className="icon-button" onClick={() => step(-1)} aria-label={tr('Previous frame')}><Icon name="arrow" size={15} /></button>
                  <button type="button" className="icon-button storm-next" onClick={() => step(1)} aria-label={tr('Next frame')}><Icon name="arrow" size={15} /></button>
                  <span>{number(demoIndex + 1)}/{number(snapshots.length)}</span>
                </div>
              )
        )}
      </div>

      <div key={mode} className="storm-content" tabIndex={0} role="region" aria-label={tr('Storm movement details')}>
        {liveNote ? <p className="storm-note" role="status">{tr(liveNote)}</p> : snapshot && (
          <>
            {!cells.length && (
              <div className="storm-empty" role="status">
                <div className="storm-empty-heading"><Icon name="radar" size={18} /><strong>{tr('No strong storm cells detected')}</strong></div>
                <p>{tr('No storm tracks to draw on this image. Rain or lightning may still occur.')}</p>
                {mode === 'live' && <button type="button" className="text-button" onClick={() => onMode('demo')}>{tr('Show saved storm replay')} <Icon name="arrow" size={16} /></button>}
              </div>
            )}

            <p className="storm-time">
              <Icon name="clock" size={14} />
              <span>
                {tr('Satellite image')} {formatClock(observedMs)}, {formatDay(observedMs)}
                {mode === 'live' && <small>{relativeLabel(observedMs)}{tr('; positions are where the storms were then')}</small>}
              </span>
            </p>

            {snapshot.arrivals?.length > 0 && (
              <div className="storm-legend">
                <p>
                  <span><i className="storm-tier is-soon" aria-hidden="true" />{tr('Within 30 min')}</span>
                  <span><i className="storm-tier" aria-hidden="true" />{tr('Within 60 min')}</span>
                </p>
                <small>
                  {tr('Shaded: the {n} upazilas a storm warning applies to, counted from {time}.', {
                    n: number(snapshot.arrivals.length), time: formatClock(toMs(snapshot.arrivalsAt)),
                  })}
                </small>
              </div>
            )}

            {selectedPcode && (
              <p className={`storm-area${area ? ' is-hit' : ''}`} role="status">
                {area?.kind === 'warned' && (area.minutes > 0
                  ? tr('Storm warning: a storm may reach {place} around {time} (in about {n} minutes).', { place: selectedName, time: formatClock(area.arrivalMs), n: number(area.minutes) })
                  : tr('Storm warning: a storm may be reaching {place} now.', { place: selectedName }))}
                {area?.kind === 'under' && tr('{place} is under a storm cell on this image.', { place: selectedName })}
                {!area && tr('No warning-strength storm is heading for {place} in the next hour.', { place: selectedName })}
              </p>
            )}

            {cells.length > 0 && (
              <>
                <h3>{tr('{n} storm cells', { n: number(cells.length) })}</h3>
                <ul className="storm-cells">{cells.slice(0, SHOWN_CELLS).map((cell) => <CellRow key={cell.id} cell={cell} />)}</ul>
              </>
            )}
          </>
        )}

        <p className="storm-disclaimer">
          {tr('Cold cloud tops, shifted about {km} km to the ground below them for the satellite’s viewing angle. Dashed circles show where each storm may be after 30, 60 and 90 minutes of straight-line movement, with the time. This is not a lightning observation; a strong storm heading for a saved area sends a prototype storm warning.', { km: number(Math.round(demo?.imageShiftKm ?? 22)) })}
        </p>
      </div>
    </section>
  );
}
