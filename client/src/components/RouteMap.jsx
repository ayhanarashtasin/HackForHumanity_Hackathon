import { useEffect, useRef, useState } from 'react';
import { AttributionControl, LngLat, LngLatBounds, MapLibreMap, Marker, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { clampToBounds } from '../lib/geometry.js';
import { buildRouteMapStyle } from '../lib/routeMapStyle.js';
import { PALETTE } from '../lib/palette.js';
import workerUrl from '../map/maplibreWorker.js?worker&url';

setWorkerUrl(workerUrl);
const BD_BOUNDS = [[88, 20.55], [92.75, 26.7]];
const MIN_ZOOM = 4.5;
const MAX_ZOOM = 18;
const EMPTY = { type: 'FeatureCollection', features: [] };
const feature = (coordinates, role) => ({ type: 'Feature', properties: { role }, geometry: { type: 'LineString', coordinates } });

export function RouteMap({ route, otherRoute, points, selected, onSelect, onAlternative, focusRequest }) {
  const { tr, number } = useLanguage(MAP);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const stageRef = useRef(null);
  const markersRef = useRef([]);
  const routeRef = useRef({ route, otherRoute });
  routeRef.current = { route, otherRoute };
  const handlersRef = useRef({ onSelect, onAlternative });
  handlersRef.current = { onSelect, onAlternative };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const fit = (map, coordinates) => {
    const bounds = coordinates?.length ? coordinates.reduce((box, point) => box.extend(point), new LngLatBounds(coordinates[0], coordinates[0])) : BD_BOUNDS;
    map.fitBounds(bounds, { padding: coordinates?.length ? { top: 90, bottom: 72, left: 40, right: 100 } : 35, absolutePadding: true, maxZoom: 14, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600 });
  };

  useEffect(() => {
    let map;
    let observer;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => setError('The map is taking longer than expected. Check your connection and retry.'), 20_000);
    const zoomLimits = { min: MIN_ZOOM, max: MAX_ZOOM };
    const limitZoomOut = () => {
      map.setMinZoom(MIN_ZOOM);
      const camera = map.cameraForBounds(BD_BOUNDS, { padding: 35, absolutePadding: true });
      zoomLimits.min = Math.max(MIN_ZOOM, (camera?.zoom ?? MIN_ZOOM) - .4);
      map.setMinZoom(zoomLimits.min);
    };
    setError('');
    setReady(false);
    const initialize = async () => {
      try {
        const response = await fetch('/data/bd-national.geojson', { signal: controller.signal });
        if (!response.ok) throw new Error('National boundary unavailable.');
        const national = await response.json();
        if (!national.features?.some(feature => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))) throw new Error('National boundary unavailable.');
        if (controller.signal.aborted) return;
        map = new MapLibreMap({
          container: containerRef.current, style: buildRouteMapStyle(national), bounds: BD_BOUNDS,
          fitBoundsOptions: { padding: 35, absolutePadding: true }, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
          // Match the weather map: limit panning, without forcing a rectangular maxBounds to crop the country.
          transformConstrain: (center, zoom) => {
            const { lng, lat } = clampToBounds(center.lng, center.lat, BD_BOUNDS, .6);
            return { center: new LngLat(lng, lat), zoom: Math.max(zoomLimits.min, Math.min(zoomLimits.max, zoom)) };
          },
          attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        });
        mapRef.current = map;
        map.touchZoomRotate.disableRotation();
        map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
        map.addControl(new AttributionControl({ compact: true, customAttribution: 'Boundaries: OCHA/HDX (BBS) · geoBoundaries (CC BY 3.0 IGO)' }), 'bottom-left');
        containerRef.current.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show .maplibregl-ctrl-attrib-button')?.click();
        map.on('load', () => {
          clearTimeout(timeout);
          limitZoomOut();
          containerRef.current.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact-show .maplibregl-ctrl-attrib-button')?.click();
          map.addSource('journey', { type: 'geojson', data: EMPTY });
          map.addLayer({ id: 'journey-alternative-hit', type: 'line', source: 'journey', filter: ['==', ['get', 'role'], 'alternative'], paint: { 'line-width': 22, 'line-opacity': 0 } });
          map.addLayer({ id: 'journey-alternative', type: 'line', source: 'journey', filter: ['==', ['get', 'role'], 'alternative'], layout: { 'line-join': 'round' }, paint: { 'line-color': PALETTE.cream, 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': .65 } });
          map.addLayer({ id: 'journey-casing', type: 'line', source: 'journey', filter: ['==', ['get', 'role'], 'selected'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.olive, 'line-width': 10 } });
          map.addLayer({ id: 'journey-line', type: 'line', source: 'journey', filter: ['==', ['get', 'role'], 'selected'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': PALETTE.sage, 'line-width': 5 } });
          map.on('click', 'journey-alternative-hit', () => handlersRef.current.onAlternative());
          map.on('mouseenter', 'journey-alternative-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', 'journey-alternative-hit', () => { map.getCanvas().style.cursor = ''; });
          setError('');
          setReady(true);
        });
        observer = new ResizeObserver(() => {
          map.resize();
          limitZoomOut();
          const current = routeRef.current;
          if (map.getSource('journey')) fit(map, current.route ? [...current.route.coordinates, ...(current.otherRoute?.coordinates ?? [])] : null);
        });
        observer.observe(containerRef.current);
      } catch {
        if (controller.signal.aborted) return;
        clearTimeout(timeout);
        if (!map) containerRef.current?.replaceChildren();
        setError('The interactive map could not start. Your route weather is still available below.');
      }
    };
    initialize();
    return () => {
      controller.abort();
      clearTimeout(timeout);
      observer?.disconnect();
      markersRef.current.forEach(marker => marker.remove());
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    const features = route ? [feature(route.coordinates, 'selected'), ...(otherRoute ? [feature(otherRoute.coordinates, 'alternative')] : [])] : [];
    map.getSource('journey').setData({ type: 'FeatureCollection', features });
    fit(map, route ? [...route.coordinates, ...(otherRoute?.coordinates ?? [])] : null);
  }, [ready, route, otherRoute]);

  useEffect(() => {
    if (!ready || !route) return;
    const markers = [route.coordinates[0], route.coordinates.at(-1)].map((coordinates, index) => {
      const element = document.createElement('span');
      element.className = 'route-map-endpoint';
      element.textContent = index ? 'B' : 'A';
      element.setAttribute('aria-hidden', 'true');
      return new Marker({ element, offset: [0, 30] }).setLngLat(coordinates).addTo(mapRef.current);
    });
    return () => markers.forEach(marker => marker.remove());
  }, [ready, route]);

  useEffect(() => {
    if (!ready) return;
    const focusedIndex = markersRef.current.findIndex(marker => marker.getElement() === document.activeElement);
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = points.filter(point => point.coordinates?.every(Number.isFinite)).map(point => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'route-map-marker';
      element.dataset.index = point.index;
      element.setAttribute('aria-label', `${number(point.index + 1)}. ${point.name} · ${tr(point.regional ? 'Average temperature' : 'Temperature')}: ${Number.isFinite(point.temp) ? `${number(point.temp.toFixed(1))}${tr('°C')}` : tr('Not available')}`);
      const badge = document.createElement('span');
      badge.textContent = number(point.index + 1);
      element.append(badge);
      if (Number.isFinite(point.temp)) {
        if (points.length <= 8 || point.index === 0 || point.index === points.length - 1) element.classList.add('has-label');
        const temperature = document.createElement('small');
        temperature.textContent = `${number(Math.round(point.temp))}°`;
        element.append(temperature);
      }
      element.addEventListener('click', () => handlersRef.current.onSelect(point.index));
      return new Marker({ element, anchor: 'left', offset: [-21, 0] }).setLngLat(point.coordinates).addTo(mapRef.current);
    });
    if (focusedIndex >= 0) markersRef.current[focusedIndex]?.getElement().focus({ preventScroll: true });
  }, [ready, points, tr, number]);

  useEffect(() => {
    markersRef.current.forEach(marker => {
      const active = Number(marker.getElement().dataset.index) === selected;
      marker.getElement().setAttribute('aria-pressed', String(active));
      marker.getElement().classList.toggle('is-selected', active);
    });
  }, [selected, points, ready]);

  useEffect(() => {
    const point = points[focusRequest?.index];
    if (ready && point?.coordinates) mapRef.current.flyTo({ center: point.coordinates, zoom: Math.max(mapRef.current.getZoom(), 9), duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600 });
  }, [ready, focusRequest]); // Forecast refreshes must not move a camera the user has positioned.

  useEffect(() => {
    if (!ready) return;
    for (const [selector, label] of [['.maplibregl-ctrl-zoom-in', 'Zoom in'], ['.maplibregl-ctrl-zoom-out', 'Zoom out'], ['.maplibregl-ctrl-attrib-button', 'Toggle attribution']]) {
      const button = containerRef.current.querySelector(selector);
      if (button) { button.title = tr(label); button.setAttribute('aria-label', tr(label)); }
    }
    mapRef.current.getCanvas().setAttribute('aria-label', tr('Your journey on the map'));
  }, [ready, tr]);

  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  return (
    <div className="route-map-stage" ref={stageRef}>
      <div className="route-map-canvas" ref={containerRef} role="region" aria-label={tr('Route map')} />
      {!ready && !error && <div className="route-map-loading" role="status"><Icon name="map" size={25} /><span>{tr('Loading route map…')}</span></div>}
      {error && <div className="route-map-error" role="alert"><Icon name="warning" size={24} /><p>{tr(error)}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{tr('Retry map')}</button></div>}
      {ready && <div className="route-map-tools">
        <button type="button" onClick={() => fit(mapRef.current, route?.coordinates)}><Icon name="locate" size={16} />{tr(route ? 'Fit route' : 'Bangladesh')}</button>
        {typeof document.documentElement.requestFullscreen === 'function' && <button type="button" aria-label={tr(expanded ? 'Exit full screen' : 'Full screen map')} onClick={async () => {
          try { if (expanded) await document.exitFullscreen(); else await stageRef.current.requestFullscreen(); } catch { /* The map stays usable when the browser denies fullscreen. */ }
        }}><Icon name={expanded ? 'minimize' : 'maximize'} size={18} /></button>}
      </div>}
      {ready && !route && <div className="route-map-welcome"><span><Icon name="route" size={23} /></span><div><strong>{tr('Your route, clearly laid out.')}</strong><p>{tr('Choose a start and destination to draw your route here.')}</p></div></div>}
      {ready && route && <div className="route-map-key"><span><i />{tr('Selected route')}</span>{otherRoute && <span><i className="is-alternative" />{tr('Alternative route')}</span>}</div>}
      {expanded && points[selected] && <div className="route-map-fullscreen-weather" aria-live="polite"><strong>{points[selected].name}</strong><span>{tr(points[selected].regional ? 'Average temperature' : 'Temperature')}: {Number.isFinite(points[selected].temp) ? `${number(points[selected].temp.toFixed(1))}${tr('°C')}` : tr('Not available')}</span><small>{tr('Forecast, not live observations')}</small></div>}
    </div>
  );
}
