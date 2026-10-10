import { env } from '../config/env.js';
import { recordCheck, recordFailure } from './weatherStore.js';

// NASA GIBS serves JMA Himawari-9 imagery as free WMTS tiles (CORS enabled), so the browser loads tiles directly;
// the backend only resolves which timestamps exist. Frames are roughly 45-60 minutes behind real time.
const LAYERS = {
  ir: { id: 'Himawari_AHI_Band13_Clean_Infrared', label: 'Infrared (cloud tops)' },
  visible: { id: 'Himawari_AHI_Band3_Red_Visible_1km', label: 'Visible (daytime only)' },
};
const FRAME_COUNT = 36; // about 6 hours at 10-minute spacing
const MAX_BACKLOG_MS = 12 * 3_600_000;

const state = { fetchedAt: null, layers: {} };

function parseDuration(text) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(text);
  return match ? (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000 : null;
}

// Expands "start/end/PT10M" ranges into timestamps.
export function expandRanges(ranges, now = Date.now()) {
  const times = [];
  for (const range of ranges) {
    const [startText, endText, durationText] = range.split('/');
    const start = Date.parse(startText);
    const end = Date.parse(endText);
    const step = parseDuration(durationText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !step || end < now - MAX_BACKLOG_MS) continue;

    for (let time = Math.max(start, now - MAX_BACKLOG_MS); time <= end; time += step) times.push(time);
  }
  return [...new Set(times)].sort((a, b) => a - b).map((time) => new Date(time).toISOString().replace('.000Z', 'Z'));
}

// Reads only the layers we need out of the (large) GIBS capabilities document.
export function parseCapabilities(xml, now = Date.now()) {
  const layers = {};

  for (const [key, layer] of Object.entries(LAYERS)) {
    const at = xml.indexOf(`<ows:Identifier>${layer.id}</ows:Identifier>`);
    if (at === -1) continue;

    const block = xml.slice(xml.lastIndexOf('<Layer>', at), xml.indexOf('</Layer>', at));
    const matrixSet = /<TileMatrixSet>([^<]+)<\/TileMatrixSet>/.exec(block)?.[1];
    const maxZoom = Number(/Level(\d+)/.exec(matrixSet ?? '')?.[1]);
    const ranges = [...block.matchAll(/<Value>([^<]+)<\/Value>/g)].map((match) => match[1]);
    const frames = expandRanges(ranges, now).slice(-FRAME_COUNT);

    if (matrixSet && Number.isFinite(maxZoom) && frames.length) {
      layers[key] = {
        label: layer.label,
        maxZoom,
        frames,
        tileUrl: `${env.weather.gibsUrl}/wmts/epsg3857/best/${layer.id}/default/{time}/${matrixSet}/{z}/{y}/{x}.png`,
      };
    }
  }

  return layers;
}

export async function refreshSatellite({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${env.weather.gibsUrl}/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`NASA GIBS HTTP ${response.status}`);

    const layers = parseCapabilities(await response.text());
    if (!layers.ir) throw new Error('NASA GIBS capabilities no longer list the Himawari infrared layer.');

    state.layers = layers;
    state.fetchedAt = new Date();
    recordCheck('satellite', { dataTime: layers.ir.frames.at(-1) });
  } catch (error) {
    recordFailure('satellite', error);
    throw error;
  }
}

export function getSatelliteFrames() {
  return {
    fetchedAt: state.fetchedAt ? state.fetchedAt.toISOString() : null,
    attribution: 'Himawari-9 imagery © JMA, served by NASA GIBS',
    layers: state.layers,
  };
}
