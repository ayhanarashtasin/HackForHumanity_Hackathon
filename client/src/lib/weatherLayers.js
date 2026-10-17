import { SIGN_ORDER } from './scales.js';

export function weatherLayerSelection(layers, colorLayer = 'temp') {
  if (layers?.length === 0) return { layers: [], colorLayer: null };
  const selected = SIGN_ORDER.filter(id => layers?.includes(id));
  if (!selected.length) selected.push(SIGN_ORDER.includes(colorLayer) ? colorLayer : 'temp');
  return { layers: selected, colorLayer: selected.includes(colorLayer) ? colorLayer : selected[0] };
}

export function toggleWeatherLayer(selection, id) {
  if (!SIGN_ORDER.includes(id)) return selection;
  const layers = selection.layers.includes(id) ? selection.layers.filter(layer => layer !== id) : [...selection.layers, id];
  return weatherLayerSelection(layers, selection.colorLayer);
}

export const WEATHER_ICON_SIZES = [[5, 0.58], [8, 0.72], [11, 0.9]];
export function weatherIconSize(zoom) {
  if (zoom <= 5) return 0.58;
  if (zoom >= 11) return 0.9;
  const [start, end] = zoom <= 8 ? [WEATHER_ICON_SIZES[0], WEATHER_ICON_SIZES[1]] : [WEATHER_ICON_SIZES[1], WEATHER_ICON_SIZES[2]];
  return start[1] + (end[1] - start[1]) * (zoom - start[0]) / (end[0] - start[0]);
}

// Native symbol offsets participate in collision detection; paint translations would leave the icons colliding at their old positions.
export function weatherMarkerLayout(index, count, rotation = 0, badge = false) {
  const shift = (index - (count - 1) / 2) * 44;
  const angle = rotation * Math.PI / 180;
  const textOffset = (size, fontSize) => [shift * size / fontSize, badge ? 0 : 0.95];
  return {
    markerShift: shift,
    // icon-offset rotates with the wind arrow: undo that rotation so the row of indicators stays horizontal.
    iconOffset: [shift * Math.cos(angle), -shift * Math.sin(angle)],
    textOffsetSmall: textOffset(0.58, 10),
    textOffsetMedium: textOffset(0.72, 11.5),
    textOffsetLarge: textOffset(0.9, 13),
  };
}
