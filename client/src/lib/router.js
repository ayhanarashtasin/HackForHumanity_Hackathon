import { useSyncExternalStore } from 'react';

// A tiny History API router instead of a dependency. "/" is the landing page, "/map" the weather map, "/flood" the FFWC river and DDM
// shelter view, "/alert" the alert sign-up and inbox, and "/admin" (and "/admin/login") the administrator dashboard. The map keeps its
// shareable view in the URL hash (urlState.js), so routing only looks at the path.
export const ROUTES = { home: '/', map: '/map', route: '/route', alert: '/alert', flood: '/flood', floodDemo: '/flood/demo', admin: '/admin', adminLogin: '/admin/login' };
const NAVIGATE_EVENT = 'akashsathi:navigate';

export function resolveRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === ROUTES.map) return 'map';
  if (path === ROUTES.route) return 'route';
  if (path === ROUTES.alert) return 'alert';
  if (path === ROUTES.flood || path === ROUTES.floodDemo) return 'flood';
  if (path === ROUTES.admin || path === ROUTES.adminLogin) return 'admin';
  return 'home';
}

// Which screen of the admin area a path asks for ("/admin/login" is the sign-in screen).
export function adminScreen(pathname) {
  return (pathname.replace(/\/+$/, '') || '/') === ROUTES.adminLogin ? 'login' : 'dashboard';
}

// Before the landing page existed the map lived at "/" and shared links looked like "/#view=...&layer=...". Keep them working.
export function legacyMapUrl(pathname, hash) {
  if (resolveRoute(pathname) !== 'home') return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return ['view', 'layer', 'o'].some((key) => params.has(key)) ? `${ROUTES.map}${hash}` : null;
}

export function normalizeUrl() {
  const legacy = legacyMapUrl(window.location.pathname, window.location.hash);
  if (legacy) window.history.replaceState(null, '', legacy);
}

export function navigate(to, { replace = false } = {}) {
  const from = window.location.pathname;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  if (window.location.pathname !== from) window.scrollTo(0, 0);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(listener) {
  // Pasting an old "/#view=..." link into a tab that already shows the landing page is a hash change, not a page load.
  const onHashChange = () => {
    normalizeUrl();
    listener();
  };
  window.addEventListener('popstate', listener);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener('hashchange', onHashChange);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

export function useRoute() {
  return useSyncExternalStore(subscribe, () => resolveRoute(window.location.pathname), () => 'home');
}

// The admin area needs the exact path (login vs dashboard), so it subscribes to the pathname itself.
export function usePathname() {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => '/');
}
