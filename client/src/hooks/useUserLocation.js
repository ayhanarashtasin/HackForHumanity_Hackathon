import { useCallback, useEffect, useRef, useState } from 'react';
import { locateUpazila } from '../lib/locate.js';

const INITIAL = { status: 'idle', position: null, match: null, message: '' };

export function useUserLocation(catalogue) {
  const [location, setLocation] = useState(INITIAL);
  const requestRef = useRef(0);
  const controllerRef = useRef(null);

  const requestLocation = useCallback(() => {
    if (!catalogue) return;
    const request = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!window.isSecureContext || !navigator.geolocation) {
      setLocation({ ...INITIAL, status: 'unsupported', message: 'Location needs a supported browser and a secure (HTTPS) connection. You can still search for your upazila.' });
      return;
    }

    setLocation({ ...INITIAL, status: 'locating' });
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      if (request !== requestRef.current) return;
      const position = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy };
      setLocation((current) => ({ ...current, status: 'resolving', position }));
      try {
        const response = await fetch('/data/bd-upazila.geojson', { signal: controller.signal });
        if (!response.ok) throw new Error('Area boundaries could not be loaded. Try again or search for your upazila.');
        const match = locateUpazila(position, await response.json(), catalogue);
        if (request !== requestRef.current) return;
        setLocation({ position, match, status: match ? 'ready' : 'outside', message: match ? '' : 'We could not match this position to a Bangladesh upazila. Search for an area, especially if you are near a border.' });
      } catch (error) {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setLocation({ ...INITIAL, position, status: 'error', message: error.message });
      }
    }, (error) => {
      if (request !== requestRef.current) return;
      const message = error.code === 1
        ? 'Location access is blocked. Allow location in your browser’s site settings, then try again. Or search for your upazila above.'
        : error.code === 3
          ? 'Finding your location took too long. Try again, or search for your upazila.'
          : 'Your device could not find its location. Try again, or search for your upazila.';
      setLocation((current) => ({ ...current, status: error.code === 1 ? 'denied' : 'error', message }));
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 });
  }, [catalogue]);

  useEffect(() => {
    // Deferring one tick avoids duplicate browser prompts during React's development effect replay.
    const timer = setTimeout(requestLocation, 0);
    return () => {
      clearTimeout(timer);
      ++requestRef.current;
      controllerRef.current?.abort();
    };
  }, [requestLocation]);

  return { ...location, requestLocation };
}
