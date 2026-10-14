import { STORM_COLORS } from '../map/WeatherMap.js';
import { formatClock, formatDay, relativeLabel, toMs } from '../lib/time.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import './storm-panel.css';

const INTENSITY = { 4: 'Strong', 5: 'Severe', 6: 'Extreme' };
const TREND = { growing: 'Growing', steady: 'Steady', weakening: 'Weakening' };
const SHOWN_CELLS = 4;

// What the snapshot means for the selected upazila: inside a cell now, reached within 90 minutes, or nothing heading there.
function forArea(snapshot, pcode) {
  let best = null;
  for (const cell of snapshot?.cells ?? []) {
    const hit = cell.reaches?.find((place) => place.pcode === pcode);
    if (hit && (!best || hit.etaMin < best.etaMin)) best = { ...hit, cell };
  }
  return best;
}

function CellRow({ cell }) {
  const { tr, number } = useLanguage(MAP);
  return (
    <li className="storm-cell-row">
      <span className="storm-swatch" style={{ background: STORM_COLORS[cell.intensity] }} aria-hidden="true" />
      <div>
        <strong>{tr(INTENSITY[cell.intensity] ?? 'Strong')} · {number(cell.areaKm2)} {tr('km²')}</strong>
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

export function StormPanel({ mode, onMode, live, liveError, demo, demoError, demoIndex, onDemoIndex, playing, onPlay, selectedPcode, selectedName }) {
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
    else if (live && !live.enabled) liveNote = 'Storm tracking is off: the ML service is not running.';
    else if (live && !live.live) liveNote = live.error ? 'The satellite analysis failed; trying again in 10 minutes.' : 'Waiting for the first satellite analysis…';
  }

  return (
    <section className="storm-panel panel" aria-label={tr('Storm movement')}>
      <header className="storm-header">
        <span className="storm-heading-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span>
        <div><h2>{tr('Storm movement')}</h2><p>{tr('Experimental · Himawari-9 satellite')}</p></div>
      </header>

      <div className="sub-choice storm-mode" role="radiogroup" aria-label={tr('Storm data')}>
        {[['live', 'Live'], ['demo', 'Replay: 22 Sep 2026']].map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={mode === key} className={mode === key ? 'chip active' : 'chip'} onClick={() => onMode(key)}>{tr(label)}</button>
        ))}
      </div>

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

      {liveNote ? <p className="storm-note" role="status">{tr(liveNote)}</p> : snapshot && (
        <>
          <p className="storm-time">
            <Icon name="clock" size={14} />
            <span>
              {tr('Satellite image')} {formatClock(observedMs)}, {formatDay(observedMs)}
              {mode === 'live' && <small>{relativeLabel(observedMs)}{tr('; positions are where the storms were then')}</small>}
            </span>
          </p>

          {selectedPcode && (
            <p className={`storm-area${area ? ' is-hit' : ''}`} role="status">
              {area
                ? (area.etaMin === 0
                  ? tr('{place} is under a storm cell on this image.', { place: selectedName })
                  : tr('A storm cell may reach {place} in about {n} minutes.', { place: selectedName, n: number(area.etaMin) }))
                : tr('No tracked storm cell is heading for {place} in the next 90 minutes.', { place: selectedName })}
            </p>
          )}

          {cells.length ? (
            <>
              <h3>{tr('{n} storm cells', { n: number(cells.length) })}</h3>
              <ul className="storm-cells">{cells.slice(0, SHOWN_CELLS).map((cell) => <CellRow key={cell.id} cell={cell} />)}</ul>
            </>
          ) : <p className="storm-note">{tr('No strong storm cells on this satellite image.')}</p>}
        </>
      )}

      <p className="storm-disclaimer">
        {tr('Cold cloud tops, shifted about {km} km to the ground below them for the satellite’s viewing angle. Arrows show 60 minutes of straight-line movement. This is not a lightning observation and does not change any alert.', { km: number(Math.round(demo?.imageShiftKm ?? 22)) })}
      </p>
    </section>
  );
}
