import { useSyncExternalStore } from 'react';
import { getUserLocation, requestUserLocation, subscribeUserLocation } from '../lib/userLocation.js';

export function useUserLocation() {
  const location = useSyncExternalStore(subscribeUserLocation, getUserLocation, getUserLocation);
  return { ...location, requestLocation: requestUserLocation };
}
