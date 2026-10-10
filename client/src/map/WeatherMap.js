import { AttributionControl, LngLat, MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import { circlePolygon, clampToBounds, imageCoordinates, outsideMask } from '../lib/geometry.js';
import { registerIcons } from '../lib/icons.js';
import { LABELS_ANCHOR, buildBaseStyle } from '../lib/mapStyle.js';
import { BASEMAP, PALETTE, STATUS_COLORS } from '../lib/palette.js';
import { SIGN_LAYERS, colorAt, dim, textOn } from '../lib/scales.js';
import workerUrl from './maplibreWorker.js?worker&url';

setWorkerUrl(workerUrl);

// Below this zoom the map shows the 64 districts; from here on, the 544 upazila / thana locations.
export const UPAZILA_ZOOM = 8.3;
const BD_BOUNDS = [[88.0, 20.55], [92.75, 26.7]];
const viewPadding = (container) => ({
  top: Math.min(96, container.clientHeight * 0.15),
  bottom: Math.min(180, container.clientHeight * 0.3),
  left: Math.min(40, container.clientWidth * 0.08),
  right: Math.min(64, container.clientWidth * 0.08),
});
// The map shows Bangladesh only. The camera centre may drift this far (degrees) past the border, enough to slide the coast out
// from under the panels, but never to an empty canvas. Zooming out stops a little beyond the zoom that fits the whole country.
const PAN_MARGIN = 0.6;
const MIN_ZOOM_SLACK = 0.4;
const ABSOLUTE_MIN_ZOOM = 4.5;
const MAX_ZOOM = 12;
const NATIONAL_URL = '/data/bd-national.geojson';
const FILL_OPACITY = 0.56;
const EMPTY = { type: 'FeatureCollection', features: [] };
const TRANSPARENT = 'rgba(0,0,0,0)';

export const LIGHTNING_COLORS = {
  reported: '#FFB800',
  none: PALETTE.sage,
  stale: STATUS_COLORS.stale,
  unavailable: STATUS_COLORS.unavailable,
  'not-checked': STATUS_COLORS.unavailable,
};

const mean = (values) => {
  const present = values.filter((value) => value !== null && value !== undefined && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
};

function fillOpacity(scale, upazila) {
  const [a, b] = upazila ? [0, FILL_OPACITY * scale] : [FILL_OPACITY * scale, 0];
  return ['interpolate', ['linear'], ['zoom'], 7.9, a, 8.6, b];
}

export class WeatherMap {
  constructor({ container, catalogue, initialView, handlers }) {
    this.catalogue = catalogue;
    this.handlers = handlers;
    this.ready = false;
    this.selected = null;
    this.hovered = { source: null, id: null };
    this.signState = null;
    this.radarUrls = new Map();
    this.satellite = { current: 'a', pending: false, requested: null, shown: null };

    this.locationByPcode = new Map(catalogue.locations.map((location) => [location.pcode, location]));
    this.districtByCode = new Map(catalogue.districts.map((district) => [district.pcode, district]));
    this.baseMarkers = [
      ...catalogue.districts.map((district) => ({ level: 'district', id: district.pcode, name: district.name, lat: district.lat, lon: district.lon })),
      ...catalogue.locations.map((location) => ({ level: 'upazila', id: location.pcode, name: location.name, lat: location.lat, lon: location.lon })),
    ];

    // Fetched up front so the outside-Bangladesh mask is in place the moment the style loads (no flash of the neighbours).
    this.destroyed = false;
    this.zoomLimits = { min: ABSOLUTE_MIN_ZOOM, max: MAX_ZOOM };
    this.nationalData = fetch(NATIONAL_URL)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .catch((error) => {
        console.error('Could not load the national boundary; neighbouring countries will not be hidden.', error);
        return null;
      });

    this.map = new MapLibreMap({
      container,
      style: buildBaseStyle(),
      ...(initialView
        ? { center: [initialView.lon, initialView.lat], zoom: initialView.zoom }
        : { bounds: BD_BOUNDS, fitBoundsOptions: { padding: viewPadding(container), absolutePadding: true } }),
      minZoom: ABSOLUTE_MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      // A custom constrain replaces MapLibre's default one, including its min/max zoom clamp, so the zoom limits are applied here too.
      transformConstrain: (center, zoom) => {
        const { lng, lat } = clampToBounds(center.lng, center.lat, BD_BOUNDS, PAN_MARGIN);
        return { center: new LngLat(lng, lat), zoom: Math.min(Math.max(zoom, this.zoomLimits.min), this.zoomLimits.max) };
      },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new AttributionControl({
      compact: true,
      customAttribution: [
        'Forecast &amp; radar © BMD',
        'Himawari-9 © JMA via NASA GIBS',
        'Open-Meteo',
        'Boundaries: OCHA/HDX (BBS)',
      ],
    }), 'bottom-left');
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    this.map.on('load', () => this.setup().catch((error) => console.error('Map setup failed.', error)));
    this.map.on('resize', () => this.limitZoomOut());
    this.map.on('moveend', () => handlers.onMoveEnd?.(this.view()));
  }

  // Zooming out stops just past the zoom that fits Bangladesh in the free part of the screen, so the country can never shrink to a speck.
  limitZoomOut() {
    this.map.setMinZoom(ABSOLUTE_MIN_ZOOM); // measure against the loosest limit so a previous, tighter one cannot skew the result
    const camera = this.map.cameraForBounds(BD_BOUNDS, { padding: viewPadding(this.map.getContainer()), absolutePadding: true });
    if (!camera || !Number.isFinite(camera.zoom)) return;

    this.zoomLimits.min = Math.max(ABSOLUTE_MIN_ZOOM, camera.zoom - MIN_ZOOM_SLACK);
    this.map.setMinZoom(this.zoomLimits.min);
  }

  view() {
    const center = this.map.getCenter();
    return { lat: center.lat, lon: center.lng, zoom: this.map.getZoom() };
  }

  async setup() {
    const national = await this.nationalData;
    if (this.destroyed) return;

    const { map } = this;
    registerIcons(map);

    map.addSource('national', { type: 'geojson', data: national ?? NATIONAL_URL });
    map.addSource('districts', { type: 'geojson', data: '/data/bd-district.geojson', promoteId: 'pid' });
    map.addSource('upazilas', { type: 'geojson', data: '/data/bd-upazila.geojson', promoteId: 'pid' });
    map.addSource('markers', { type: 'geojson', data: EMPTY });
    map.addSource('selection', { type: 'geojson', data: EMPTY });
    map.addSource('lightning', { type: 'geojson', data: EMPTY });
    map.addSource('user-position', { type: 'geojson', data: EMPTY });

    const before = LABELS_ANCHOR;
    const add = (layer, beforeId = before) => map.addLayer(layer, beforeId);

    add({ id: 'national-fill', type: 'fill', source: 'national', paint: { 'fill-color': BASEMAP.country } });
    add({
      id: 'district-fill', type: 'fill', source: 'districts',
      paint: { 'fill-color': ['coalesce', ['feature-state', 'color'], TRANSPARENT], 'fill-opacity': fillOpacity(1, false) },
    });
    add({
      id: 'upazila-fill', type: 'fill', source: 'upazilas',
      paint: { 'fill-color': ['coalesce', ['feature-state', 'color'], TRANSPARENT], 'fill-opacity': fillOpacity(1, true) },
    });
    add({
      id: 'upazila-line', type: 'line', source: 'upazilas',
      paint: {
        'line-color': PALETTE.cream,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 6.8, 0, 8, 0.28, 10, 0.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 1.2],
      },
    });
    add({
      id: 'district-line', type: 'line', source: 'districts',
      paint: {
        'line-color': PALETTE.cream,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.35, 9, 0.6],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.6],
      },
    });
    for (const source of ['districts', 'upazilas']) {
      add({
        id: `${source}-active`, type: 'line', source,
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': PALETTE.cream,
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, ['boolean', ['feature-state', 'hover'], false], 2, 0],
          'line-opacity': 0.95,
        },
      });
    }

    // Only Bangladesh is shown. Everything outside the national border (the neighbouring countries, the sea and their labels, and the
    // parts of the radar and satellite images that spill past the border) is painted over with the canvas color. The mask sits above
    // the basemap, weather fills and raster layers, and below the lightning circles, which can legitimately reach past the border.
    if (national) {
      map.addSource('outside', { type: 'geojson', data: outsideMask(national) });
      map.addLayer({ id: 'outside-mask', type: 'fill', source: 'outside', paint: { 'fill-color': BASEMAP.land, 'fill-antialias': false } });
    }
    // Drawn after the mask so the whole border line shows, not just its inner half.
    map.addLayer({
      id: 'national-line', type: 'line', source: 'national',
      paint: { 'line-color': PALETTE.cream, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 10, 2.2], 'line-opacity': 0.9 },
    });

    this.limitZoomOut();
    this.addLightningLayers();
    // MapLibre places symbols from the top layer down, so the weather signs (added last) claim space before the names.
    this.addNameLayer('names-district', 'district', 6.2, UPAZILA_ZOOM);
    this.addNameLayer('names-upazila', 'upazila', UPAZILA_ZOOM + 1, 24);
    this.addMarkerLayer('markers-district', 'district', 0, UPAZILA_ZOOM);
    this.addMarkerLayer('markers-upazila', 'upazila', UPAZILA_ZOOM, 24);
    map.addLayer({
      id: 'selection-ring', type: 'circle', source: 'selection',
      paint: { 'circle-radius': 17, 'circle-color': TRANSPARENT, 'circle-stroke-color': PALETTE.cream, 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'user-accuracy', type: 'fill', source: 'user-position', filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': PALETTE.sage, 'fill-opacity': 0.18, 'fill-outline-color': PALETTE.cream },
    });
    map.addLayer({
      id: 'user-position-halo', type: 'circle', source: 'user-position', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 13, 'circle-color': PALETTE.cream, 'circle-opacity': 0.35 },
    });
    map.addLayer({
      id: 'user-position-dot', type: 'circle', source: 'user-position', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': PALETTE.olive, 'circle-stroke-color': PALETTE.cream, 'circle-stroke-width': 3 },
    });

    map.on('click', (event) => this.onClick(event));
    map.on('mousemove', (event) => this.onMouseMove(event));
    map.on('mouseout', () => this.setHover(null, null));

    this.ready = true;
    this.handlers.onReady?.();
  }

  addMarkerLayer(id, level, minzoom, maxzoom) {
    const isBadge = ['==', ['get', 'icon'], 'badge'];
    this.map.addLayer({
      id,
      type: 'symbol',
      source: 'markers',
      minzoom,
      maxzoom,
      filter: ['==', ['get', 'level'], level],
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.58, 8, 0.72, 11, 0.9],
        'icon-rotate': ['get', 'rot'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 11, 13],
        'text-anchor': ['case', isBadge, 'center', 'top'],
        'text-offset': ['case', isBadge, ['literal', [0, 0]], ['literal', [0, 0.95]]],
        'text-allow-overlap': false,
        'text-optional': true,
        'symbol-sort-key': ['get', 'sort'],
      },
      paint: {
        'icon-color': ['get', 'color'],
        'icon-opacity': ['case', ['==', ['get', 'icon'], 'dot'], 0.85, 1],
        'icon-halo-color': BASEMAP.halo,
        'icon-halo-width': 1.6,
        'text-color': ['get', 'textColor'],
        'text-halo-color': ['case', isBadge, TRANSPARENT, BASEMAP.halo],
        'text-halo-width': 1.5,
      },
    });
  }

  // Place names under the weather signs, shown only where there is room (lower priority than the signs themselves).
  addNameLayer(id, level, minzoom, maxzoom) {
    this.map.addLayer({
      id,
      type: 'symbol',
      source: 'markers',
      minzoom,
      maxzoom,
      filter: ['==', ['get', 'level'], level],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9.5, 12, 12],
        'text-anchor': 'top',
        'text-offset': [0, 1.5],
        'text-allow-overlap': false,
        'text-optional': true,
        'symbol-sort-key': ['get', 'sort'],
      },
      paint: { 'text-color': PALETTE.cream, 'text-opacity': 0.82, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.3 },
    });
  }

  addLightningLayers() {
    const colorByState = ['match', ['get', 'state'], ...Object.entries(LIGHTNING_COLORS).flat(), STATUS_COLORS.unavailable];
    const polygon = ['==', ['geometry-type'], 'Polygon'];
    const add = (layer) => this.map.addLayer({ ...layer, layout: { visibility: 'none', ...layer.layout } });

    add({
      id: 'lightning-fill', type: 'fill', source: 'lightning', filter: polygon,
      paint: { 'fill-color': colorByState, 'fill-opacity': ['case', ['==', ['get', 'state'], 'reported'], 0.2, 0.05] },
    });
    for (const [state, dash] of [['reported', null], ['none', [3, 2]], ['stale', [1, 2]], ['unavailable', [1, 1.6]], ['not-checked', [1, 1.6]]]) {
      add({
        id: `lightning-line-${state}`, type: 'line', source: 'lightning',
        filter: ['all', polygon, ['==', ['get', 'state'], state]],
        paint: {
          'line-color': LIGHTNING_COLORS[state],
          'line-width': state === 'reported' ? 2.8 : 2.4,
          ...(dash && { 'line-dasharray': dash }),
        },
      });
    }
    add({
      id: 'lightning-points', type: 'circle', source: 'lightning', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'role'], 'location']],
      paint: {
        'circle-color': colorByState,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 11, 6],
        'circle-stroke-color': BASEMAP.halo,
        'circle-stroke-width': 1,
      },
    });
    add({
      id: 'lightning-labels', type: 'symbol', source: 'lightning', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'role'], 'center']],
      layout: {
        'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-allow-overlap': true,
      },
      paint: { 'text-color': colorByState, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 2 },
    });
  }

  // ---------- weather signs ----------
  // Recomputes every marker and polygon color for one sign layer at one forecast step.
  setSigns({ layerId, snapshot, stepIndex, status }) {
    if (!this.ready) return;

    const cfg = SIGN_LAYERS[layerId];
    this.signState = { layerId, stepIndex };
    const hasData = snapshot && snapshot.steps?.length;
    const stale = status === 'stale';
    const tint = (color) => (stale ? dim(color) : color);
    const valuesByPcode = new Map();

    const features = this.baseMarkers.map((base) => {
      const series = hasData ? (base.level === 'district' ? snapshot.districts[base.id] : snapshot.locations[base.id]) : null;
      const key = base.level === 'district' ? cfg.districtSeries : cfg.series;
      const raw = series?.[key]?.[stepIndex];
      if (base.level === 'upazila') valuesByPcode.set(base.id, raw ?? null);

      let props;
      if (raw === null || raw === undefined) {
        props = { icon: 'dot', color: STATUS_COLORS.unavailable, label: '', textColor: PALETTE.cream, sort: 1000, rot: 0 };
      } else {
        const mark = cfg.mark(raw, { dir: series?.wd?.[stepIndex] });
        const color = mark.value === null ? PALETTE.sage : tint(colorAt(cfg.scale, mark.value));
        props = {
          icon: mark.icon,
          color,
          label: mark.label,
          textColor: mark.icon === 'badge' ? textOn(color) : PALETTE.cream,
          sort: -mark.severity,
          rot: mark.rotate ?? 0,
        };
      }

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [base.lon, base.lat] },
        properties: { level: base.level, id: base.id, name: base.name, ...props },
      };
    });
    this.map.getSource('markers').setData({ type: 'FeatureCollection', features });

    const fillFor = (value) => {
      if (value === null || value === undefined) return null;
      const mark = cfg.mark(value, {});
      if (mark.value === null || (cfg.fillMin !== undefined && mark.value < cfg.fillMin)) return null;
      return tint(colorAt(cfg.scale, mark.value));
    };
    // "No value" is a transparent fill; removeFeatureState is avoided because it misbehaves on not-yet-loaded GeoJSON sources.
    const setFill = (source, id, color) => this.map.setFeatureState({ source, id }, { color: color ?? TRANSPARENT });

    for (const [pid, polygon] of Object.entries(this.catalogue.polygons)) {
      setFill('upazilas', pid, fillFor(mean(polygon.src.map((pcode) => valuesByPcode.get(pcode)))));
    }
    for (const district of this.catalogue.districts) {
      setFill('districts', district.pcode, fillFor(hasData ? snapshot.districts[district.pcode]?.[cfg.districtSeries]?.[stepIndex] : null));
    }
  }

  // Lowers choropleth opacity while the satellite layer is on so cloud patterns stay visible.
  setFillScale(scale) {
    if (!this.ready) return;
    this.map.setPaintProperty('district-fill', 'fill-opacity', fillOpacity(scale, false));
    this.map.setPaintProperty('upazila-fill', 'fill-opacity', fillOpacity(scale, true));
  }

  // ---------- radar ----------
  // items: [{ siteId, url, bounds }]; an empty list hides the layer.
  setRadar(items) {
    if (!this.ready) return;
    const active = new Set();

    for (const item of items) {
      const id = `radar-${item.siteId}`;
      const coordinates = imageCoordinates(item.bounds);
      active.add(id);

      if (!this.map.getSource(id)) {
        this.map.addSource(id, { type: 'image', url: item.url, coordinates });
        this.map.addLayer({
          id, type: 'raster', source: id,
          paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        }, 'upazila-line');
        this.radarUrls.set(id, item.url);
      } else if (this.radarUrls.get(id) !== item.url) {
        this.map.getSource(id).updateImage({ url: item.url, coordinates });
        this.radarUrls.set(id, item.url);
      }
      this.map.setLayoutProperty(id, 'visibility', 'visible');
    }

    for (const id of this.radarUrls.keys()) {
      if (!active.has(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
    }
  }

  // ---------- satellite ----------
  // spec: { tileUrl, maxZoom } for one frame, or null to hide. Two buffers alternate so frames swap without a blank flash.
  setSatellite(spec) {
    if (!this.ready) return;
    const state = this.satellite;

    if (!spec) {
      state.requested = null;
      state.shown = null;
      for (const id of ['sat-a', 'sat-b']) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }

    state.requested = spec;
    if (state.pending || state.shown === spec.tileUrl) return;
    this.loadSatelliteFrame(spec);
  }

  loadSatelliteFrame(spec) {
    const { map } = this;
    const state = this.satellite;
    const next = state.current === 'a' ? 'b' : 'a';
    const nextId = `sat-${next}`;
    const currentId = `sat-${state.current}`;
    const first = state.shown === null;
    state.pending = true;

    const tiles = [spec.tileUrl];
    if (!map.getSource(nextId)) {
      map.addSource(nextId, { type: 'raster', tiles, tileSize: 256, maxzoom: spec.maxZoom, attribution: 'Himawari-9 © JMA / NASA GIBS' });
      map.addLayer({
        id: nextId, type: 'raster', source: nextId,
        paint: { 'raster-opacity': 0, 'raster-fade-duration': 0 },
      }, 'district-fill');
    } else if (typeof map.getSource(nextId).setTiles === 'function') {
      map.getSource(nextId).setTiles(tiles);
    }
    map.setLayoutProperty(nextId, 'visibility', 'visible');

    let done = false;
    const reveal = () => {
      if (done) return;
      done = true;
      map.off('sourcedata', onData);
      clearTimeout(timer);

      map.setPaintProperty(nextId, 'raster-opacity', 0.9);
      if (!first && map.getLayer(currentId)) map.setPaintProperty(currentId, 'raster-opacity', 0);
      state.current = next;
      state.shown = spec.tileUrl;
      state.pending = false;

      // A newer frame was requested while this one loaded.
      if (state.requested && state.requested.tileUrl !== state.shown) this.loadSatelliteFrame(state.requested);
    };
    const onData = (event) => {
      if (event.sourceId === nextId && event.isSourceLoaded) reveal();
    };
    const timer = setTimeout(reveal, 3000);
    map.on('sourcedata', onData);
  }

  // ---------- lightning ----------
  // items come from /api/lightning/summaries: circles (Mode B) or upazila locations (Mode A).
  setLightning({ visible, items }) {
    if (!this.ready) return;

    const features = [];
    for (const item of items ?? []) {
      const label = item.state === 'reported' ? (item.count === null ? '⚡' : `⚡ ${item.count}`) : item.state === 'none' ? '0' : '—';
      const props = { id: item.id, state: item.state, kind: item.kind, name: item.name ?? item.id };

      if (item.kind === 'circle') {
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: circlePolygon(item.lat, item.lon, item.radiusKm) }, properties: props });
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [item.lon, item.lat] }, properties: { ...props, role: 'center', label } });
      } else {
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [item.lon, item.lat] }, properties: { ...props, role: 'location' } });
      }
    }

    this.map.getSource('lightning').setData({ type: 'FeatureCollection', features });
    for (const layer of this.map.getStyle().layers.filter((l) => l.id.startsWith('lightning-'))) {
      this.map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  // ---------- interaction ----------
  onClick(event) {
    const lightning = this.map.getLayer('lightning-labels') && this.map.getLayoutProperty('lightning-labels', 'visibility') === 'visible'
      ? this.map.queryRenderedFeatures(event.point, { layers: ['lightning-labels', 'lightning-points'] })[0]
      : null;
    if (lightning) {
      this.handlers.onLightningSelect?.(lightning.properties.id);
      return;
    }

    const selection = this.pick(event.point);
    this.handlers.onSelect?.(selection);
  }

  // Marker first, then the polygon under the cursor (district polygons below UPAZILA_ZOOM, upazila polygons above).
  pick(point) {
    const marker = this.map.queryRenderedFeatures(point, { layers: ['markers-district', 'markers-upazila'] })[0];
    if (marker) return { level: marker.properties.level, id: marker.properties.id };

    const upazilaMode = this.map.getZoom() >= UPAZILA_ZOOM;
    const layer = upazilaMode ? 'upazila-fill' : 'district-fill';
    const feature = this.map.queryRenderedFeatures(point, { layers: [layer] })[0];
    if (!feature) return null;

    const pid = feature.properties.pid;
    if (!upazilaMode) return { level: 'district', id: pid };

    const polygon = this.catalogue.polygons[pid];
    return polygon && polygon.src.length === 1 && !polygon.approx
      ? { level: 'upazila', id: polygon.src[0] }
      : { level: 'polygon', id: pid };
  }

  onMouseMove(event) {
    const picked = this.pick(event.point);
    this.map.getCanvas().style.cursor = picked ? 'pointer' : '';

    if (!picked) {
      this.setHover(null, null);
      this.handlers.onHover?.(null);
      return;
    }

    const target = this.polygonTarget(picked);
    this.setHover(target?.source ?? null, target?.id ?? null);
    this.handlers.onHover?.(picked, { x: event.point.x, y: event.point.y });
  }

  // Which polygon represents a selection, if any (point-only city thanas have none).
  polygonTarget(selection) {
    if (!selection) return null;
    if (selection.level === 'district') return { source: 'districts', id: selection.id };
    if (selection.level === 'polygon') return { source: 'upazilas', id: selection.id };

    const location = this.locationByPcode.get(selection.id);
    return location?.pid ? { source: 'upazilas', id: location.pid } : null;
  }

  setHover(source, id) {
    if (this.hovered.source === source && this.hovered.id === id) return;
    if (this.hovered.source) this.map.setFeatureState({ source: this.hovered.source, id: this.hovered.id }, { hover: false });
    this.hovered = { source, id };
    if (source) this.map.setFeatureState({ source, id }, { hover: true });
  }

  setSelection(selection) {
    if (!this.ready) return;

    const previous = this.polygonTarget(this.selected);
    if (previous) this.map.setFeatureState(previous, { selected: false });
    this.selected = selection;

    const target = this.polygonTarget(selection);
    if (target) this.map.setFeatureState(target, { selected: true });

    // Point-only locations (no polygon) get a ring around their marker instead.
    const point = selection && !target ? this.pointOf(selection) : null;
    this.map.getSource('selection').setData(point
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} }] }
      : EMPTY);
  }

  pointOf(selection) {
    const location = selection.level === 'upazila' ? this.locationByPcode.get(selection.id) : null;
    return location ? [location.lon, location.lat] : null;
  }

  setUserPosition(position) {
    if (!this.ready) return;
    const features = position ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [position.lon, position.lat] } }] : [];
    if (position && Number.isFinite(position.accuracy) && position.accuracy > 0) {
      features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: circlePolygon(position.lat, position.lon, position.accuracy / 1000) } });
    }
    this.map.getSource('user-position').setData({ type: 'FeatureCollection', features });
  }

  flyTo({ lat, lon, zoom }) {
    this.map.flyTo({ center: [lon, lat], zoom, padding: viewPadding(this.map.getContainer()), duration: 850 });
  }

  fitBangladesh() {
    // MapLibre v6 adds fit padding to existing camera padding unless absolutePadding is set.
    this.map.fitBounds(BD_BOUNDS, { padding: viewPadding(this.map.getContainer()), absolutePadding: true, duration: 800 });
  }

  resize() {
    this.map.resize();
  }

  destroy() {
    this.destroyed = true;
    this.map.remove();
  }
}
