import { AttributionControl, LngLat, LngLatBounds, MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import { circlePolygon, clampToBounds, imageCoordinates, outsideMask } from '../lib/geometry.js';
import { registerIcons } from '../lib/icons.js';
import { neighbourhoodById } from '../lib/neighbourhoods.js';
import { LABELS_ANCHOR, buildBaseStyle } from '../lib/mapStyle.js';
import { BASEMAP, PALETTE, STATUS_COLORS } from '../lib/palette.js';
import { SIGN_LAYERS, colorAt, dim, textOn } from '../lib/scales.js';
import { WEATHER_ICON_SIZES, weatherIconSize, weatherMarkerLayout } from '../lib/weatherLayers.js';
import { STORM_COLORS, STORM_WARNING_COLOR, arrivalTiers, stormFeatures } from '../lib/stormMap.js';
import { INDICATOR_FILL_LAYERS, INDICATOR_HIT_LAYERS, LIGHTNING_COLORS, indicatorCandidates, indicatorFromFeature, indicatorKey } from '../lib/mapIndicators.js';
import { translate } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { getLanguage } from '../i18n/language.js';
import workerUrl from './maplibreWorker.js?worker&url';

setWorkerUrl(workerUrl);

// Below this zoom the map shows the 64 districts; from here on, the 544 upazila / thana locations.
export const UPAZILA_ZOOM = 8.3;
const AREA_ZOOM = 9.2;
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
const pidFilter = (pids) => ['in', ['get', 'pid'], ['literal', pids]];
const NONE = pidFilter([]);
const ROUTE_STOP_LAYERS = ['route-stop-circles', 'route-area-dots'];
const TRANSPARENT = 'rgba(0,0,0,0)';

export { LIGHTNING_COLORS, STORM_COLORS };
const STORM_LAYERS = [
  'storm-arrival-fill', 'storm-arrival-line', 'storm-ring-fill', 'storm-ring', 'storm-cell', 'storm-cell-line', 'storm-track', 'storm-arrow',
  'storm-step', 'storm-step-label', 'storm-label', 'storm-arrival-label',
];

const mean = (values) => {
  const present = values.filter((value) => value !== null && value !== undefined && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
};

function fillOpacity(scale, upazila) {
  const [a, b] = upazila ? [0, FILL_OPACITY * scale] : [FILL_OPACITY * scale, 0];
  return ['interpolate', ['linear'], ['zoom'], 7.9, a, 8.6, b];
}

export class WeatherMap {
  // maxZoom: the weather map stops at district/upazila detail; the route page allows street level to follow a city route.
  constructor({ container, catalogue, initialView, handlers, maxZoom = MAX_ZOOM }) {
    this.catalogue = catalogue;
    this.handlers = handlers;
    this.ready = false;
    this.selected = null;
    this.hovered = { source: null, id: null };
    this.signState = null;
    this.radarUrls = new Map();
    this.satellite = { current: 'a', pending: false, requested: null, shown: null };
    this.stormImageUrl = null;

    this.locationByPcode = new Map(catalogue.locations.map((location) => [location.pcode, location]));
    this.districtByCode = new Map(catalogue.districts.map((district) => [district.pcode, district]));
    this.baseMarkers = [
      ...catalogue.districts.map((district) => ({ level: 'district', id: district.pcode, name: district.name, lat: district.lat, lon: district.lon })),
      ...catalogue.locations.map((location) => ({ level: 'upazila', id: location.pcode, name: location.name, lat: location.lat, lon: location.lon })),
    ];

    // Fetched up front so the outside-Bangladesh mask is in place the moment the style loads (no flash of the neighbours).
    this.destroyed = false;
    this.zoomLimits = { min: ABSOLUTE_MIN_ZOOM, max: maxZoom };
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
      maxZoom,
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
        'ADM4 boundaries: geoBoundaries (BBS/OCHA ROAP, CC BY 3.0 IGO)',
        'Mugda point: © OpenStreetMap contributors (ODbL)',
      ],
    }), 'bottom-left');
    // MapLibre initially expands even compact credits; keep the long strip behind its info button.
    container.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show .maplibregl-ctrl-attrib-button')?.click();
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    this.setLanguage(getLanguage());

    this.map.on('load', () => this.setup().catch((error) => console.error('Map setup failed.', error)));
    this.map.on('resize', () => this.limitZoomOut());
    this.map.on('moveend', () => handlers.onMoveEnd?.(this.view()));
  }

  // MapLibre has no public runtime locale setter. Relabel its HTML controls without rebuilding the map or using private fields.
  setLanguage(lang) {
    const container = this.map.getContainer();
    for (const [selector, text] of [
      ['.maplibregl-ctrl-zoom-in', 'Zoom in'], ['.maplibregl-ctrl-zoom-out', 'Zoom out'],
      ['.maplibregl-ctrl-attrib-button', 'Toggle attribution'],
    ]) {
      const button = container.querySelector(selector);
      if (!button) continue;
      const label = translate(lang, text, {}, MAP);
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    this.map.getCanvas().setAttribute('aria-label', translate(lang, 'Interactive weather map of Bangladesh', {}, MAP));
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
    map.addSource('areas', { type: 'geojson', data: '/data/bd-admin4.geojson', promoteId: 'pid' });
    map.addSource('markers', { type: 'geojson', data: EMPTY });
    map.addSource('selection', { type: 'geojson', data: EMPTY });
    map.addSource('lightning', { type: 'geojson', data: EMPTY });
    map.addSource('user-position', { type: 'geojson', data: EMPTY });
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addSource('route-stops', { type: 'geojson', data: EMPTY });
    map.addSource('indicator-hover', { type: 'geojson', data: EMPTY });

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
      id: 'area-fill', type: 'fill', source: 'areas', minzoom: AREA_ZOOM,
      paint: {
        'fill-color': ['coalesce', ['feature-state', 'color'], TRANSPARENT],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], AREA_ZOOM, 0.16, 12, 0.3],
      },
    });
    add({
      id: 'area-point', type: 'circle', source: 'areas', minzoom: AREA_ZOOM,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': ['coalesce', ['feature-state', 'color'], PALETTE.sage],
        'circle-stroke-color': PALETTE.cream,
        'circle-stroke-width': 2,
      },
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
    add({
      id: 'area-line', type: 'line', source: 'areas', minzoom: AREA_ZOOM,
      paint: {
        'line-color': PALETTE.cream,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], AREA_ZOOM, 0.5, 12, 0.78],
        'line-width': ['interpolate', ['linear'], ['zoom'], AREA_ZOOM, 0.55, 12, 1.1],
      },
    });
    // Upazilas and local areas the route crosses (route page only); setRouteDetails fills in the filters.
    add({ id: 'route-upazila-fill', type: 'fill', source: 'upazilas', filter: NONE, paint: { 'fill-color': PALETTE.sage, 'fill-opacity': 0.16 } });
    add({ id: 'route-upazila-line', type: 'line', source: 'upazilas', filter: NONE, paint: { 'line-color': PALETTE.sage, 'line-width': 1.6, 'line-opacity': 0.85 } });
    add({ id: 'route-area-line', type: 'line', source: 'areas', filter: NONE, minzoom: 9, paint: { 'line-color': PALETTE.cream, 'line-width': 1.2, 'line-opacity': 0.8, 'line-dasharray': [2, 1.5] } });
    for (const source of ['districts', 'upazilas', 'areas']) {
      add({
        id: `${source}-active`, type: 'line', source,
        minzoom: source === 'areas' ? AREA_ZOOM : 0,
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': PALETTE.cream,
          'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, ['boolean', ['feature-state', 'hover'], false], 2, 0],
          'line-opacity': 0.95,
        },
      });
    }

    // Country/weather fills otherwise cover the basemap's rivers. Keep real water polygons and centerlines above those fills,
    // but below the outside mask and storm/lightning overlays; no hand-drawn substitute river routes.
    for (const id of ['water', 'waterway-casing', 'waterway']) map.moveLayer(id, LABELS_ANCHOR);

    // Hide neighbouring land and its labels. Restore ocean water above the mask so the Bay has its real coastline;
    // storm and lightning layers stay above both, including storms approaching from the Bay.
    if (national) {
      map.addSource('outside', { type: 'geojson', data: outsideMask(national) });
      map.addLayer({ id: 'outside-mask', type: 'fill', source: 'outside', paint: { 'fill-color': BASEMAP.land, 'fill-antialias': false } });
    }
    map.addLayer({
      id: 'bay-water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
      filter: ['==', ['get', 'class'], 'ocean'], paint: { 'fill-color': BASEMAP.water },
    });
    // A local label keeps the northern Bay named even when the basemap's sea label falls outside the Bangladesh view.
    map.addSource('bay-of-bengal', {
      type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [90.3, 21] } },
    });
    map.addLayer({
      id: 'bay-of-bengal-label', type: 'symbol', source: 'bay-of-bengal', maxzoom: 9,
      layout: {
        'text-field': 'Bay of Bengal', 'text-font': ['Noto Sans Italic'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 12, 8, 17], 'text-letter-spacing': 0.12,
      },
      paint: { 'text-color': BASEMAP.label, 'text-halo-color': BASEMAP.water, 'text-halo-width': 1.5 },
    });
    // Drawn after the mask so the whole border line shows, not just its inner half.
    map.addLayer({
      id: 'national-line', type: 'line', source: 'national',
      paint: { 'line-color': PALETTE.cream, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 10, 2.2], 'line-opacity': 0.9 },
    });

    this.limitZoomOut();
    this.addLightningLayers();
    this.addStormLayers();
    // MapLibre places symbols from the top layer down, so the weather signs (added last) claim space before the names.
    this.addNameLayer('names-district', 'district', 6.2, UPAZILA_ZOOM);
    this.addNameLayer('names-upazila', 'upazila', UPAZILA_ZOOM + 1, 24);
    map.addLayer({
      id: 'names-areas', type: 'symbol', source: 'areas', minzoom: AREA_ZOOM + 0.6,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 12, 11],
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: { 'text-color': PALETTE.cream, 'text-opacity': 0.9, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.4 },
    });
    // Dense ward/union names yield to river names; weather symbols still have the highest placement priority.
    map.moveLayer('names-areas', 'label-river');
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
    map.addLayer({
      id: 'indicator-hover-line', type: 'line', source: 'indicator-hover', filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': PALETTE.cream, 'line-width': 3, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: 'indicator-hover-point', type: 'circle', source: 'indicator-hover', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 12, 'circle-color': TRANSPARENT, 'circle-stroke-color': PALETTE.cream, 'circle-stroke-width': 2.5 },
    });
    // Alternative routes: dashed and muted under the chosen one, with a wide invisible line so they are easy to point at and click.
    map.addLayer({ id: 'route-alt-casing', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alternative'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.cream, 'line-width': 6, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'route-alt-line', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alternative'], layout: { 'line-join': 'round' }, paint: { 'line-color': PALETTE.olive, 'line-width': 3, 'line-opacity': 0.7, 'line-dasharray': [2, 1.6] } });
    map.addLayer({ id: 'route-alt-hit', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alternative'], paint: { 'line-color': PALETTE.olive, 'line-width': 18, 'line-opacity': 0 } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'path'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.cream, 'line-width': 8, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'path'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.sage, 'line-width': 4.5 } });    map.addLayer({ id: 'route-points', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7, 'circle-color': PALETTE.sage, 'circle-stroke-color': PALETTE.cream, 'circle-stroke-width': 3 } });
    // Numbered stops (one per upazila/thana card in the route list) and a small dot for each local area passed. Hovering either shows
    // its weather; areas share the forecast of their stop.
    map.addLayer({
      id: 'route-area-dots', type: 'circle', source: 'route-stops', filter: ['==', ['get', 'type'], 'area'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 13, 6], 'circle-color': PALETTE.cream, 'circle-stroke-color': PALETTE.olive, 'circle-stroke-width': 1.5 },
    });
    map.addLayer({
      id: 'route-area-names', type: 'symbol', source: 'route-stops', minzoom: 11, filter: ['==', ['get', 'type'], 'area'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-optional': true },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.4 },
    });
    map.addLayer({
      id: 'route-stop-circles', type: 'circle', source: 'route-stops', filter: ['==', ['get', 'type'], 'stop'],
      paint: { 'circle-radius': 11, 'circle-color': PALETTE.olive, 'circle-stroke-color': PALETTE.cream, 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'route-stop-numbers', type: 'symbol', source: 'route-stops', filter: ['==', ['get', 'type'], 'stop'],
      layout: { 'text-field': ['get', 'number'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5, 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': PALETTE.cream },
    });
    map.addLayer({
      id: 'route-stop-names', type: 'symbol', source: 'route-stops', filter: ['==', ['get', 'type'], 'stop'],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 1.25], 'text-optional': true },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.6 },
    });

    map.on('click', (event) => this.onClick(event));
    map.on('mousemove', (event) => this.onMouseMove(event));
    map.on('mouseout', event => {
      if (event.originalEvent?.relatedTarget?.closest?.('.map-inspection')) return;
      if (!this.inspection?.pinned) this.clearInspection();
      this.handlers.onRouteHover?.(null);
    });
    map.on('movestart', () => this.clearInspection());

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
        'icon-size': ['interpolate', ['linear'], ['zoom'], ...WEATHER_ICON_SIZES.flat()],
        'icon-offset': ['get', 'iconOffset'],
        'icon-rotate': ['get', 'rot'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 11, 13],
        'text-anchor': ['case', isBadge, 'center', 'top'],
        'text-offset': ['interpolate', ['linear'], ['zoom'],
          5, ['array', 'number', 2, ['get', 'textOffsetSmall']],
          8, ['array', 'number', 2, ['get', 'textOffsetMedium']],
          11, ['array', 'number', 2, ['get', 'textOffsetLarge']],
        ],
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
      filter: ['all', ['==', ['get', 'level'], level], ['==', ['get', 'primary'], true]],
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

  // Experimental storm movement (ml-service storm tracker): the upazilas a storm warning applies to, cell outlines, the 30/60/90-minute
  // circles with clock times, the track and an arrow (features: lib/stormMap.js). Drawn above the outside mask: a storm still over
  // Meghalaya or the Bay is exactly the one worth seeing coming.
  addStormLayers() {
    const { map } = this;
    map.addSource('storms', { type: 'geojson', data: EMPTY });
    const color = ['match', ['get', 'intensity'], 6, STORM_COLORS[6], 5, STORM_COLORS[5], STORM_COLORS[4]];
    const kind = (name) => ['==', ['get', 'kind'], name];
    const add = (layer) => map.addLayer({ source: 'storms', ...layer, layout: { visibility: 'none', ...layer.layout } });
    // feature-state stormTier on the upazila polygons: 1 = may arrive within 30 minutes, 2 = within the hour.
    const tier = (soon, later) => ['match', ['coalesce', ['feature-state', 'stormTier'], 0], 1, soon, 2, later, 0];

    add({ id: 'storm-arrival-fill', type: 'fill', source: 'upazilas', paint: { 'fill-color': STORM_WARNING_COLOR, 'fill-opacity': tier(0.42, 0.2) } });
    add({ id: 'storm-arrival-line', type: 'line', source: 'upazilas', paint: { 'line-color': STORM_WARNING_COLOR, 'line-width': tier(1.8, 1.1), 'line-opacity': tier(0.95, 0.7) } });
    add({ id: 'storm-ring-fill', type: 'fill', filter: kind('ring'), paint: { 'fill-color': color, 'fill-opacity': 0.05 } });
    add({
      id: 'storm-ring', type: 'line', filter: kind('ring'),
      paint: { 'line-color': color, 'line-width': 1.3, 'line-dasharray': [2, 2], 'line-opacity': ['match', ['get', 'minutes'], 30, 0.9, 60, 0.7, 0.5] },
    });
    add({ id: 'storm-cell', type: 'fill', filter: kind('cell'), paint: { 'fill-color': color, 'fill-opacity': 0.32 } });
    add({ id: 'storm-cell-line', type: 'line', filter: kind('cell'), paint: { 'line-color': color, 'line-width': 1.6 } });
    add({ id: 'storm-track', type: 'line', filter: kind('track'), layout: { 'line-cap': 'round' }, paint: { 'line-color': PALETTE.cream, 'line-width': 2.4 } });
    add({ id: 'storm-arrow', type: 'fill', filter: kind('arrow'), paint: { 'fill-color': PALETTE.cream } });
    add({
      id: 'storm-step', type: 'circle', filter: kind('step'),
      paint: { 'circle-radius': 3, 'circle-color': PALETTE.cream, 'circle-stroke-color': color, 'circle-stroke-width': 1.4 },
    });
    add({
      id: 'storm-step-label', type: 'symbol', filter: ['all', kind('step'), ['!=', ['get', 'label'], '']],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-offset': [0, 1.05], 'text-optional': true },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.6 },
    });
    add({
      id: 'storm-label', type: 'symbol', filter: kind('label'),
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-optional': true },
      paint: { 'text-color': PALETTE.cream, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.6 },
    });
    add({
      id: 'storm-arrival-label', type: 'symbol', filter: kind('arrival'), minzoom: 7,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-offset': [0, 1.6], 'text-optional': true },
      paint: { 'text-color': STORM_WARNING_COLOR, 'text-halo-color': BASEMAP.halo, 'text-halo-width': 1.6 },
    });
  }

  // { visible, snapshot, image: { url, bounds } | null }. snapshot.arrivals (from the API) are the upazilas a storm warning applies to;
  // the image is the frame's satellite picture (the replay's GIBS frame, or live the picture ml-service draws from the NOAA frame).
  setStorms({ visible, snapshot, image }) {
    if (!this.ready) return;
    const { map } = this;
    this.stormSnapshot = visible ? snapshot : null;
    this.stormFeatures = visible ? stormFeatures(snapshot, this.locationByPcode) : [];
    map.getSource('storms').setData({ type: 'FeatureCollection', features: this.stormFeatures });
    for (const id of STORM_LAYERS) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');

    const tiers = arrivalTiers(visible ? snapshot?.arrivals ?? [] : [], this.catalogue.polygons);
    for (const pid of this.stormTiers ?? []) if (!tiers.has(pid)) map.setFeatureState({ source: 'upazilas', id: pid }, { stormTier: 0 });
    for (const [pid, value] of tiers) map.setFeatureState({ source: 'upazilas', id: pid }, { stormTier: value });
    this.stormTiers = new Set(tiers.keys());

    // The frame's satellite picture sits with the other raster layers, under the outside mask.
    const url = visible && image ? image.url : null;
    if (url && !map.getSource('storm-image')) {
      map.addSource('storm-image', { type: 'image', url, coordinates: imageCoordinates(image.bounds) });
      map.addLayer({ id: 'storm-image', type: 'raster', source: 'storm-image', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, 'district-fill');
    } else if (url && this.stormImageUrl !== url) {
      map.getSource('storm-image').updateImage({ url, coordinates: imageCoordinates(image.bounds) });
    }
    if (map.getLayer('storm-image')) map.setLayoutProperty('storm-image', 'visibility', url ? 'visible' : 'none');
    this.stormImageUrl = url;
  }

  // ---------- weather signs ----------
  // Each selected variable gets its own symbol; only the chosen color layer paints administrative areas.
  setSigns({ layerId, layerIds = [layerId], snapshot, stepIndex, status }) {
    if (!this.ready) return;

    const cfg = SIGN_LAYERS[layerId];
    this.signState = { layerId, layerIds, stepIndex };
    const hasData = snapshot && snapshot.steps?.length;
    const statusFor = id => id === 'thunder' ? snapshot?.sources?.openMeteo?.status ?? status : status;
    const stale = statusFor(layerId) === 'stale';
    const tint = (color) => (stale ? dim(color) : color);
    const valuesByPcode = new Map();

    const features = this.baseMarkers.flatMap((base) => layerIds.map((id, index) => {
      const markerCfg = SIGN_LAYERS[id];
      const series = hasData ? (base.level === 'district' ? snapshot.districts[base.id] : snapshot.locations[base.id]) : null;
      const key = base.level === 'district' ? markerCfg.districtSeries : markerCfg.series;
      const raw = series?.[key]?.[stepIndex];
      if (base.level === 'upazila' && id === layerId) valuesByPcode.set(base.id, raw ?? null);

      let props;
      if (raw === null || raw === undefined) {
        props = { icon: 'dot', color: STATUS_COLORS.unavailable, label: '', textColor: PALETTE.cream, sort: 1000, rot: 0 };
      } else {
        const mark = markerCfg.mark(raw, { dir: series?.wd?.[stepIndex] });
        const rawColor = mark.value === null ? PALETTE.sage : colorAt(markerCfg.scale, mark.value);
        const color = mark.value !== null && statusFor(id) === 'stale' ? dim(rawColor) : rawColor;
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
        properties: {
          level: base.level, id: base.id, name: base.name, signLayer: id, primary: id === layerId, ...props,
          ...weatherMarkerLayout(index, layerIds.length, props.rot, props.icon === 'badge'),
        },
      };
    }));
    this.map.getSource('markers').setData({ type: 'FeatureCollection', features });

    const fillFor = (value) => {
      if (!cfg || value === null || value === undefined) return null;
      const mark = cfg.mark(value, {});
      if (mark.value === null || (cfg.fillMin !== undefined && mark.value < cfg.fillMin)) return null;
      return tint(colorAt(cfg.scale, mark.value));
    };
    // "No value" is a transparent fill; removeFeatureState is avoided because it misbehaves on not-yet-loaded GeoJSON sources.
    const setFill = (source, id, color) => this.map.setFeatureState({ source, id }, { color: color ?? TRANSPARENT });

    for (const [pid, polygon] of Object.entries(this.catalogue.polygons)) {
      setFill('upazilas', pid, fillFor(mean(polygon.src.map((pcode) => valuesByPcode.get(pcode)))));
    }
    for (const area of this.catalogue.areas ?? []) {
      const parent = this.catalogue.polygons[area.parentPid];
      setFill('areas', area.id, fillFor(parent ? mean(parent.src.map((pcode) => valuesByPcode.get(pcode))) : null));
    }
    for (const district of this.catalogue.districts) {
      setFill('districts', district.pcode, fillFor(cfg && hasData ? snapshot.districts[district.pcode]?.[cfg.districtSeries]?.[stepIndex] : null));
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

    this.lightningFeatures = visible ? features : [];
    this.lightningItems = visible ? items : [];
    this.map.getSource('lightning').setData({ type: 'FeatureCollection', features });
    for (const layer of this.map.getStyle().layers.filter((l) => l.id.startsWith('lightning-'))) {
      this.map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  // ---------- interaction ----------
  onClick(event) {
    // A tap on a route stop shows its weather (there is no hover on touch screens).
    const stop = this.routeStopAt(event.point);
    if (stop) {
      this.handlers.onRouteHover?.(stop, { x: event.point.x, y: event.point.y });
      return;
    }
    this.handlers.onRouteHover?.(null);

    const alternative = this.routeAlternativeAt(event.point);
    if (alternative !== null) {
      this.handlers.onRouteSelect?.(alternative);
      return;
    }

    if (this.handlers.onHover) {
      const candidates = this.indicatorsAt(event.point);
      if (candidates.length) {
        this.inspect(candidates[0], event.point, true, candidates.slice(1).map(item => item.picked));
        if (candidates[0].picked.type === 'weather') this.handlers.onSelect?.(candidates[0].picked);
        if (candidates[0].picked.type === 'lightning') this.handlers.onLightningSelect?.(candidates[0].picked.id);
        return;
      }
    }
    const selection = this.pick(event.point);
    if (selection && this.handlers.onHover) this.inspect({ picked: selection }, event.point, true);
    else this.clearInspection();
    this.handlers.onSelect?.(selection);
  }

  indicatorsAt(point) {
    const visible = layers => layers.filter(id => this.map.getLayer(id) && this.map.getLayoutProperty(id, 'visibility') !== 'none');
    const hitLayers = visible(INDICATOR_HIT_LAYERS);
    const fillLayers = visible(INDICATOR_FILL_LAYERS);
    const box = [[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]];
    const project = coordinates => this.map.project(coordinates);
    const iconSize = weatherIconSize(this.map.getZoom());
    // An exact outline hit beats a nearby expanded dot, otherwise tiny rings become impossible to inspect when zoomed out.
    const candidates = [
      ...indicatorCandidates(hitLayers.length ? this.map.queryRenderedFeatures(point, { layers: hitLayers }) : [], point, project, iconSize),
      ...indicatorCandidates(hitLayers.length ? this.map.queryRenderedFeatures(box, { layers: hitLayers }) : [], point, project, iconSize),
      ...indicatorCandidates(fillLayers.length ? this.map.queryRenderedFeatures(point, { layers: fillLayers }) : [], point, project, iconSize),
    ];
    const seen = new Set();
    return candidates.filter(({ picked }) => {
      const key = indicatorKey(picked);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  inspect(candidate, point, pinned = false, also = []) {
    const key = indicatorKey(candidate.picked);
    const same = key === this.inspection?.key;
    if (!same) {
      clearTimeout(this.inspectionTimer);
      this.handlers.onHover?.(null);
      const target = !candidate.picked.type || candidate.picked.type === 'weather' ? this.polygonTarget(candidate.picked) : null;
      this.setHover(target?.source ?? null, target?.id ?? null);
      this.map.setPaintProperty('indicator-hover-point', 'circle-translate', [
        (candidate.feature?.properties?.markerShift ?? 0) * weatherIconSize(this.map.getZoom()), 0,
      ]);
      this.map.getSource('indicator-hover')?.setData({ type: 'FeatureCollection', features: candidate.feature ? [{
        type: 'Feature', geometry: candidate.feature.geometry, properties: {},
      }] : [] });
    }
    this.inspection = { ...candidate, key, point, pinned, also, shown: same && this.inspection.shown };
    const show = () => {
      if (!this.inspection) return;
      this.inspection.shown = true;
      const current = this.inspection;
      this.handlers.onHover?.(current.picked, { x: current.point.x, y: current.point.y, pinned: current.pinned, also: current.also });
    };
    if (pinned || this.inspection.shown) { clearTimeout(this.inspectionTimer); show(); }
    else if (!same) this.inspectionTimer = setTimeout(show, 200);
  }

  clearInspection() {
    clearTimeout(this.inspectionTimer);
    if (!this.inspection && !this.hovered.source) return;
    this.inspection = null;
    this.setHover(null, null);
    this.map.getSource('indicator-hover')?.setData(EMPTY);
    this.handlers.onHover?.(null);
  }

  // The map key offers a native select for keyboard/screen-reader access to the same cards as the canvas.
  inspectTarget(picked) {
    if (!this.ready || !picked) return;
    const layers = { cell: 'storm-cell', ring: 'storm-ring', step: 'storm-step', track: 'storm-track', arrival: 'storm-arrival-label' };
    const features = picked.type === 'storm'
      ? (this.stormFeatures ?? []).map(feature => ({ ...feature, layer: { id: layers[feature.properties.kind] ?? 'storm-label' } }))
      : (this.lightningFeatures ?? []).map(feature => ({ ...feature, layer: { id: feature.geometry.type === 'Point' ? 'lightning-labels' : 'lightning-fill' } }));
    const feature = features.find(feature => indicatorKey(indicatorFromFeature(feature)) === indicatorKey(picked));
    if (!feature) return;
    const cell = this.stormSnapshot?.cells?.find(cell => cell.id === picked.id);
    const center = picked.minutes ? cell?.forecast?.find(step => step.minutes === picked.minutes) : cell?.center;
    const location = center ?? this.lightningItems?.find(item => item.id === picked.id);
    const point = location ? this.map.project([location.lon, location.lat]) : { x: 24, y: 90 };
    this.inspect({ picked, feature }, point, true);
  }

  // Marker first, then the most detailed visible administrative polygon.
  pick(point) {
    const marker = this.map.queryRenderedFeatures(point, { layers: ['markers-district', 'markers-upazila'] })[0];
    if (marker) return { level: marker.properties.level, id: marker.properties.id };

    const upazilaMode = this.map.getZoom() >= UPAZILA_ZOOM;
    if (this.map.getZoom() >= AREA_ZOOM) {
      const area = this.map.queryRenderedFeatures(point, { layers: ['area-fill', 'area-point'] })[0];
      if (area) return { level: 'area', id: area.properties.pid };
    }
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

  // A route stop or area dot under the pointer, if any; route stops take priority over the weather map underneath.
  routeStopAt(point) {
    if (!this.hasRouteStops) return null;
    return this.map.queryRenderedFeatures(point, { layers: ROUTE_STOP_LAYERS })[0]?.properties.id ?? null;
  }

  onMouseMove(event) {
    if (this.inspection?.pinned) return;
    const stop = this.routeStopAt(event.point);
    this.handlers.onRouteHover?.(stop, stop ? { x: event.point.x, y: event.point.y } : null);
    if (stop) {
      this.map.getCanvas().style.cursor = 'pointer';
      this.clearInspection();
      return;
    }
    const alternative = this.routeAlternativeAt(event.point);
    if (alternative !== null) {
      this.map.getCanvas().style.cursor = 'pointer';
      this.clearInspection();
      return;
    }
    const candidates = this.handlers.onHover ? this.indicatorsAt(event.point) : [];
    if (candidates.length) {
      this.map.getCanvas().style.cursor = 'pointer';
      this.inspect(candidates[0], event.point, false, candidates.slice(1).map(item => item.picked));
      return;
    }
    const picked = this.pick(event.point);
    this.map.getCanvas().style.cursor = picked ? 'pointer' : '';

    if (!picked) {
      this.clearInspection();
      return;
    }

    this.inspect({ picked }, event.point);
  }

  // Which polygon represents a selection, if any (point-only city thanas have none).
  polygonTarget(selection) {
    if (!selection) return null;
    if (selection.level === 'district') return { source: 'districts', id: selection.id };
    if (selection.level === 'polygon') return { source: 'upazilas', id: selection.id };
    if (selection.level === 'neighbourhood') return null;
    if (selection.level === 'area') {
      const area = this.catalogue.areas?.find((item) => item.id === selection.id);
      return area && !area.boundaryApprox ? { source: 'areas', id: selection.id } : null;
    }

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
    if (selection.level === 'neighbourhood') {
      const place = neighbourhoodById(selection.id);
      return place ? [place.lon, place.lat] : null;
    }
    if (selection.level === 'area') {
      const area = this.catalogue.areas?.find((item) => item.id === selection.id);
      return area?.boundaryApprox ? [area.lon, area.lat] : null;
    }
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

  // alternatives: [{ index, coordinates }] drawn under the chosen route; clicking one calls onRouteSelect(index).
  setRoute(route, alternatives = []) {
    if (!this.ready) return;
    const shown = route?.coordinates?.length ? alternatives.filter((option) => option.coordinates?.length) : [];
    const features = route?.coordinates?.length ? [
      ...shown.map(({ index, coordinates }) => ({ type: 'Feature', properties: { role: 'alternative', index }, geometry: { type: 'LineString', coordinates } })),
      { type: 'Feature', properties: { role: 'path' }, geometry: { type: 'LineString', coordinates: route.coordinates } },
      { type: 'Feature', properties: { role: 'endpoint' }, geometry: { type: 'Point', coordinates: [route.start.lon, route.start.lat] } },
      { type: 'Feature', properties: { role: 'endpoint' }, geometry: { type: 'Point', coordinates: [route.end.lon, route.end.lat] } },
    ] : [];
    this.hasRouteAlternatives = shown.length > 0;
    this.map.getSource('route').setData({ type: 'FeatureCollection', features });
    if (!features.length) { this.routeFitKey = null; return; }

    // Switching between the options of one search keeps the camera; a new search fits all its options into view.
    const all = [route.coordinates, ...shown.map((option) => option.coordinates)];
    const key = `${route.start.lon},${route.start.lat};${route.end.lon},${route.end.lat};${all.map((line) => line.length).sort().join(',')}`;
    if (key !== this.routeFitKey) {
      this.routeFitKey = key;
      this.fitRoute(all.flat());
    }
  }

  routeAlternativeAt(point) {
    if (!this.hasRouteAlternatives) return null;
    const feature = this.map.queryRenderedFeatures(point, { layers: ['route-alt-hit'] })[0];
    return feature ? feature.properties.index : null;
  }

  // details: { stops: [{ id, type: 'stop' | 'area', number?, label, lon, lat }], upazilaPids: [], areaPids: [] } or null.
  setRouteDetails(details) {
    if (!this.ready) return;
    const stops = details?.stops ?? [];
    this.hasRouteStops = stops.length > 0;
    this.map.getSource('route-stops').setData({
      type: 'FeatureCollection',
      features: stops.map(({ lon, lat, ...properties }) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } })),
    });
    this.map.setFilter('route-upazila-fill', pidFilter(details?.upazilaPids ?? []));
    this.map.setFilter('route-upazila-line', pidFilter(details?.upazilaPids ?? []));
    this.map.setFilter('route-area-line', pidFilter(details?.areaPids ?? []));
  }

  fitRoute(coordinates) {
    if (!coordinates?.length) return;
    const bounds = coordinates.reduce((result, coordinate) => result.extend(coordinate), new LngLatBounds(coordinates[0], coordinates[0]));
    // A short city route (Banasree → Farmgate) needs a close zoom for its stops to be told apart. Never past the map's own limit: the
    // constrain would clamp the animation mid-flight and the camera would jump.
    this.map.fitBounds(bounds, { padding: viewPadding(this.map.getContainer()), maxZoom: Math.min(13, this.zoomLimits.max), duration: 800 });
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
    clearTimeout(this.inspectionTimer);
    this.map.remove();
  }
}
