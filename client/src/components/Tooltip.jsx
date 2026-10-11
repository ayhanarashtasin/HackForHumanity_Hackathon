import { SIGN_LAYERS } from '../lib/scales.js';
import { resolveSelection, valueAt } from '../lib/series.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

export function Tooltip({ hover, snapshot, catalogue, signLayer, stepIndex }) {
  const { lang, tr, number } = useLanguage(MAP);
  if (!hover) return null;

  const resolved = resolveSelection(hover.picked, snapshot, catalogue, lang);
  if (!resolved) return null;

  const layer = SIGN_LAYERS[signLayer];
  const value = valueAt(resolved, layer.series, layer.districtSeries, stepIndex);
  const text = value === null ? tr('No data') : signLayer === 'thunder'
    ? tr(['None', 'Low', 'Moderate', 'High'][Math.round(value)])
    : `${number(Number(value).toFixed(signLayer === 'rain' ? 1 : 0))} ${tr(layer.unit)}`;

  return (
    <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="tooltip">
      <strong>{resolved.name}</strong>
      {lang === 'en' && resolved.nameBn && <span lang="bn">{resolved.nameBn}</span>}
      <span>{tr(layer.label)}: <b>{text}</b></span>
      <small>{tr(resolved.kind)}</small>
    </div>
  );
}
