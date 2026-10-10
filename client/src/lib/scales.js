import { PALETTE, STATUS_COLORS } from './palette.js';

// Weather data ramps. These are the only colors outside the three-color palette (see design.md "Data colors").
export const SCALES = {
  temp: {
    unit: '°C',
    stops: [[10, '#5B8DB8'], [18, '#7FB5A3'], [24, '#C9D77A'], [28, '#F2D253'], [32, '#F2A03D'], [36, '#E0662F'], [40, '#B8312B'], [44, '#7F1D2B']],
  },
  rain: {
    unit: 'mm',
    stops: [[0.1, '#9ED0E6'], [1, '#5FB0D9'], [5, '#3B86C6'], [15, '#2F5FB0'], [40, '#5A3FA0'], [80, '#8A2D8F']],
  },
  heat: {
    unit: '°C',
    stops: [[27, '#F2E394'], [32, '#F2C14E'], [39, '#EE8D3A'], [51, '#D9532B']],
  },
  wind: {
    unit: 'km/h',
    stops: [[0, '#CFE0C0'], [10, '#A9BE87'], [20, '#D8D36A'], [30, '#F0A63C'], [45, '#D9582B'], [60, '#9B2335']],
  },
  thunder: {
    unit: 'level',
    stops: [[1, '#F5D547'], [2, '#F2A900'], [3, '#D9480F']],
  },
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

export function colorAt(scaleKey, value) {
  const { stops } = SCALES[scaleKey];
  if (value <= stops[0][0]) return stops[0][1];
  if (value >= stops.at(-1)[0]) return stops.at(-1)[1];

  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const t = (value - v0) / (v1 - v0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return rgbToHex(a.map((channel, k) => channel + (b[k] - channel) * t));
    }
  }
  return stops.at(-1)[1];
}

// Blend toward the neutral status color so stale data is visibly desaturated.
export function dim(hex, amount = 0.6) {
  const a = hexToRgb(hex);
  const b = hexToRgb(STATUS_COLORS.stale);
  return rgbToHex(a.map((channel, k) => channel + (b[k] - channel) * amount));
}

// Light text on dark ramp colors, Deep Olive text on light ones.
export function textOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? PALETTE.olive : PALETTE.cream;
}

const round1 = (value) => (Math.abs(value) >= 10 ? String(Math.round(value)) : value.toFixed(1));

// Weather "signs" shown at every district / upazila. `series` is the BMD/Open-Meteo key, `districtSeries` the district summary key.
export const SIGN_LAYERS = {
  temp: {
    label: 'Temperature',
    unit: '°C',
    scale: 'temp',
    series: 'temp',
    districtSeries: 'temp',
    note: 'BMD forecast model value for the selected 3-hour step.',
    mark: (v) => ({ icon: 'badge', value: v, label: `${Math.round(v)}°`, severity: v }),
  },
  heat: {
    label: 'Heat index',
    unit: '°C',
    scale: 'heat',
    series: 'hi',
    districtSeries: 'hiMax',
    note: 'Computed from BMD temperature and humidity (NWS heat index). Not an on-site WBGT measurement.',
    mark: (v) => (v >= 27
      ? { icon: 'sun', value: v, label: `${Math.round(v)}°`, severity: v }
      : { icon: 'dot', value: null, label: '', severity: 0, neutralDot: true }),
  },
  rain: {
    label: 'Rain',
    unit: 'mm',
    scale: 'rain',
    series: 'rf',
    districtSeries: 'rfMax',
    note: 'BMD forecast rainfall for the selected step (the wettest upazila is shown per district).',
    mark: (v) => (v >= 0.1
      ? { icon: 'drop', value: v, label: v < 10 ? v.toFixed(1) : String(Math.round(v)), severity: v }
      : { icon: 'dot', value: null, label: '', severity: 0, neutralDot: true }),
  },
  wind: {
    label: 'Wind',
    unit: 'km/h',
    scale: 'wind',
    series: 'ws',
    districtSeries: 'wsMax',
    fillMin: 15, // calm air is left unshaded so the arrows stay readable
    note: 'BMD forecast wind speed. Arrows point where the wind blows toward. Areas are shaded from 15 km/h.',
    mark: (v, extra) => ({
      icon: 'arrow',
      value: v,
      label: round1(v),
      severity: v,
      rotate: Number.isFinite(extra?.dir) ? (extra.dir + 180) % 360 : 0,
    }),
  },
  thunder: {
    label: 'Thunderstorm',
    unit: 'potential',
    scale: 'thunder',
    series: 'ts',
    districtSeries: 'ts',
    note: 'Thunderstorm potential from Open-Meteo (CAPE, rain probability, weather code). It is a risk sign, not an observation of lightning.',
    mark: (v) => (v >= 1
      ? { icon: 'bolt', value: v, label: '', severity: v * 10 }
      : { icon: 'dot', value: null, label: '', severity: 0, neutralDot: true }),
  },
};

export const SIGN_ORDER = ['temp', 'heat', 'rain', 'wind', 'thunder'];

export function legendFor(layerId) {
  const layer = SIGN_LAYERS[layerId];
  return { ...layer, stops: SCALES[layer.scale].stops };
}

export const WMO_LABELS = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, heavy hail',
};
