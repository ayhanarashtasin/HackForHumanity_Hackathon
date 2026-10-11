import { dayKey, formatDay, formatBst } from '../lib/time.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

const W = 320;
const H = 112;
const PAD = { l: 32, r: 8, t: 10, b: 20 };

function linePath(values, x, y) {
  let path = '';
  let pen = false;
  values.forEach((value, i) => {
    if (value === null || value === undefined) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
    pen = true;
  });
  return path;
}

// Small dependency-free SVG chart for 3-hourly series: lines and/or bars, day separators, and the selected step highlighted.
export function Chart({ title, unit, times, series, selectedIndex, zeroBase = false, maxFloor = 0, decimals = 0 }) {
  const { tr, number } = useLanguage(MAP);
  const n = times.length;
  const values = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
  if (!n || !values.length) return null;

  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  let min = Math.min(...values);
  let max = Math.max(...values, maxFloor);
  if (zeroBase || series.some((s) => s.type === 'bar')) min = Math.min(0, min);
  if (max === min) max = min + 1;

  const x = (i) => PAD.l + ((i + 0.5) / n) * innerW;
  const cellX = (i) => PAD.l + (i / n) * innerW;
  const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * innerH;
  const barWidth = Math.max(1.5, (innerW / n) * 0.7);
  const format = (v) => number(Number(v).toFixed(decimals));

  const dayStarts = times.map((time, i) => (i === 0 || dayKey(time) !== dayKey(times[i - 1]) ? i : null)).filter((i) => i !== null);

  return (
    <figure className="chart">
      <figcaption>
        <strong>{tr(title)}</strong>
        <span className="chart-legend">
          {series.map((s) => (
            <span key={s.label}><i style={{ background: s.color }} />{tr(s.label)}</span>
          ))}
          {unit && <em>{number(tr(unit))}</em>}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('{title}, {n} steps from {from} to {to}', { title: tr(title), n, from: formatBst(times[0]), to: formatBst(times[n - 1]) })}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(min)} y2={y(min)} className="axis" />
        <line x1={PAD.l} x2={W - PAD.r} y1={y(max)} y2={y(max)} className="grid" />
        <text x={PAD.l - 4} y={y(max) + 3} className="axis-text" textAnchor="end">{format(max)}</text>
        <text x={PAD.l - 4} y={y(min) + 3} className="axis-text" textAnchor="end">{format(min)}</text>

        {dayStarts.map((i) => (
          <g key={i}>
            {i > 0 && <line x1={cellX(i)} x2={cellX(i)} y1={PAD.t} y2={H - PAD.b} className="day-line" />}
            <text x={Math.min(cellX(i) + 3, W - 34)} y={H - 6} className="axis-text">{formatDay(times[i]).split(' ').slice(0, 2).join(' ')}</text>
          </g>
        ))}

        {selectedIndex !== null && selectedIndex >= 0 && selectedIndex < n && (
          <rect x={cellX(selectedIndex)} y={PAD.t} width={innerW / n} height={innerH} className="selected-step" />
        )}

        {series.filter((s) => s.type === 'bar').map((s) => s.values.map((value, i) => (
          value > 0 ? <rect key={`${s.label}-${i}`} x={x(i) - barWidth / 2} y={y(value)} width={barWidth} height={Math.max(0.5, y(min) - y(value))} fill={s.color} /> : null
        )))}
        {series.filter((s) => s.type !== 'bar').map((s) => (
          <path key={s.label} d={linePath(s.values, x, y)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dash} />
        ))}
      </svg>
    </figure>
  );
}
