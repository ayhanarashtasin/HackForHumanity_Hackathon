import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../map/map.css'; // after MapLibre's CSS on purpose
import { WeatherMap } from '../map/WeatherMap.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

// Thin React wrapper: owns the WeatherMap instance and pushes state into it. All map logic lives in map/WeatherMap.js.
export function MapView({
  catalogue, initialView, signLayer, snapshot, stepIndex, baseStatus, radarItems, satelliteSpec, lightning, route, selection, flyRequest, userPosition, handlers,
}) {
  const { tr, lang } = useLanguage(MAP);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const instance = new WeatherMap({
      container: containerRef.current,
      catalogue,
      initialView,
      handlers: {
        onReady: () => setReady(true),
        onSelect: (selected) => handlersRef.current.onSelect(selected),
        onHover: (picked, point) => handlersRef.current.onHover(picked, point),
        onMoveEnd: (view) => handlersRef.current.onMoveEnd(view),
        onLightningSelect: (id) => handlersRef.current.onLightningSelect(id),
      },
    });
    mapRef.current = instance;
    const observer = new ResizeObserver(() => {
      if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) instance.resize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      instance.destroy();
      mapRef.current = null;
      setReady(false);
    };
    // The map is created once per catalogue; later view changes go through flyRequest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue]);

  useEffect(() => { mapRef.current?.setLanguage(lang); }, [lang, ready]);

  useEffect(() => {
    if (ready) mapRef.current.setSigns({ layerId: signLayer, snapshot, stepIndex, status: baseStatus });
  }, [ready, signLayer, snapshot, stepIndex, baseStatus]);

  useEffect(() => {
    if (ready) mapRef.current.setRadar(radarItems);
  }, [ready, radarItems]);

  useEffect(() => {
    if (!ready) return;
    mapRef.current.setSatellite(satelliteSpec);
    mapRef.current.setFillScale(satelliteSpec ? 0.4 : 1);
  }, [ready, satelliteSpec]);

  useEffect(() => {
    if (ready) mapRef.current.setLightning(lightning);
  }, [ready, lightning]);

  useEffect(() => {
    if (ready) mapRef.current.setRoute(route);
  }, [ready, route]);

  useEffect(() => {
    if (ready) mapRef.current.setSelection(selection);
  }, [ready, selection]);

  useEffect(() => {
    if (ready) mapRef.current.setUserPosition(userPosition);
  }, [ready, userPosition]);

  useEffect(() => {
    if (!ready || !flyRequest) return;
    if (flyRequest.fit) mapRef.current.fitBangladesh();
    else mapRef.current.flyTo(flyRequest);
  }, [ready, flyRequest]);

  return (
    <>
      <div ref={containerRef} className={`map${ready ? ' is-ready' : ''}`} role="application" aria-label={tr('Interactive weather map of Bangladesh')} />
      {!ready && <div className="map-loading" role="status"><span className="map-spinner" aria-hidden="true" /> {tr('Preparing the map…')}</div>}
    </>
  );
}
