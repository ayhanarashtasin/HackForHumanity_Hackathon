import { SIGN_LAYERS } from '../lib/scales.js';
import { resolveSelection, valueAt } from '../lib/series.js';

export function Tooltip({ hover, snapshot, catalogue, signLayer, stepIndex }) {
  if (!hover) return null;

  const resolved = resolveSelection(hover.picked, snapshot, catalogue);
  if (!resolved) return null;

  const layer = SIGN_LAYERS[signLayer];
  const value = valueAt(resolved, layer.series, layer.districtSeries, stepIndex);
  const text = value === null ? 'No data' : signLayer === 'thunder'
    ? ['None', 'Low', 'Moderate', 'High'][Math.round(value)]
    : `${Number(value).toFixed(signLayer === 'rain' ? 1 : 0)} ${layer.unit}`;

  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
      <strong>{resolved.name}</strong>
      {resolved.nameBn && <span lang="bn">{resolved.nameBn}</span>}
      <span>{layer.label}: <b>{text}</b></span>
      <small>{resolved.kind}</small>
    </div>
  );
}
