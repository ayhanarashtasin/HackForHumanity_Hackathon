import { STEP_MS, dayKey, formatBst, formatClock, formatDay, formatRange, relativeLabel } from '../lib/time.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

function tickLabels(times, kind) {
  const labels = [];
  times.forEach((time, i) => {
    if (kind === 'forecast') {
      if (i === 0 || dayKey(time) !== dayKey(times[i - 1])) labels.push({ i, text: formatDay(time) });
    } else if (i % 6 === 0 || i === times.length - 1) {
      labels.push({ i, text: formatClock(time) });
    }
  });
  return labels;
}

export function TimeBar({
  mode, onMode, timeline, tickIndex, onTick, playing, onPlay, currentTime, onNow, liveNote,
}) {
  const { tr } = useLanguage(MAP);
  const { times, kind, nowIndex } = timeline;
  const count = times.length;
  const labels = tickLabels(times, kind);
  const percent = (i) => (count > 1 ? (i / (count - 1)) * 100 : 0);
  const isForecast = kind === 'forecast';
  const now = Date.now();
  const relative = isForecast && now >= currentTime && now < currentTime + STEP_MS ? tr('this step is now') : relativeLabel(currentTime);

  return (
    <section className="timebar panel" aria-label={tr('Time controls')}>
      <div className="timebar-modes" role="group" aria-label={tr('Map time mode')}>
        {[['live', 'Live'], ['forecast', 'Forecast']].map(([key, label]) => (
          <button key={key} type="button" aria-pressed={mode === key} className={mode === key ? 'tab active' : 'tab'} onClick={() => onMode(key)}>
            {tr(label)}
          </button>
        ))}
      </div>

      <button type="button" className="icon-button" onClick={onPlay} disabled={count < 2} aria-label={tr(playing ? 'Pause animation' : 'Play animation')}>
        <Icon name={playing ? 'pause' : 'play'} size={18} />
      </button>

      <div className="timebar-track">
        <input
          type="range"
          min={0}
          max={Math.max(count - 1, 0)}
          step={1}
          value={Math.min(tickIndex, Math.max(count - 1, 0))}
          disabled={count < 2}
          onChange={(event) => onTick(Number(event.target.value))}
          aria-label={tr('Time')}
          aria-valuetext={formatBst(currentTime)}
        />
        <div className="ticks" aria-hidden="true">
          {count > 0 && <span className="tick-now" style={{ left: `${percent(nowIndex)}%` }} />}
          {labels.map(({ i, text }) => (
            <span key={i} className={`tick-label${i === 0 ? ' tick-first' : i === count - 1 ? ' tick-last' : ''}`} style={{ left: `${percent(i)}%` }}>{text}</span>
          ))}
        </div>
      </div>

      <div className="timebar-readout">
        <strong>{isForecast ? formatRange(currentTime, currentTime + STEP_MS) : formatBst(currentTime)}</strong>
        <span>{count ? `${relative} · ${tr(isForecast ? '3-hour forecast step' : 'observed frame')}` : liveNote}</span>
      </div>

      <button type="button" className="text-button" onClick={onNow} disabled={count < 2}>
        {tr(kind === 'forecast' ? 'Now' : 'Latest')}
      </button>
    </section>
  );
}
