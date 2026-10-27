import { loadAdminPage } from './loadAdminPage.js';
import { loadAlertPage } from './loadAlertPage.js';
import { loadFloodPage } from './loadFloodPage.js';
import { loadMapPage } from './loadMapPage.js';
import { loadRoutePage } from './loadRoutePage.js';

// The map, alert and admin screens are separate chunks. This remembers which ones have arrived, so a screen whose code is already here is
// rendered at once: no loading splash, and none of the extra delay React adds before it reveals content that was waiting behind a fallback.
// main.jsx loads the current screen's chunk before the first render; hovering or focusing a link to a screen starts its chunk early.
export function createPageLoader(loaders) {
  const loaded = new Map();
  const pending = new Map();

  const isLazyPage = (route) => Object.hasOwn(loaders, route);

  // The component of a screen whose chunk has arrived, or null.
  const loadedPage = (route) => loaded.get(route) ?? null;

  // Starts loading a screen's chunk once (and again after a failure) and resolves with its component. Unknown screens resolve with null.
  function preloadPage(route) {
    if (!isLazyPage(route)) return Promise.resolve(null);
    if (loaded.has(route)) return Promise.resolve(loaded.get(route));
    if (!pending.has(route)) {
      const started = loaders[route]()
        .then((module) => {
          loaded.set(route, module.default);
          return module.default;
        })
        .finally(() => pending.delete(route));
      pending.set(route, started);
    }
    return pending.get(route);
  }

  // An event handler for onPointerEnter / onFocus that warms a screen's chunk. A failure here is not the visitor's problem: opening the
  // screen tries again and shows the error boundary if it still cannot load.
  const prefetchPage = (route) => () => {
    preloadPage(route).catch(() => {});
  };

  return {
    isLazyPage, loadedPage, preloadPage, prefetchPage,
  };
}

export const {
  isLazyPage, loadedPage, preloadPage, prefetchPage,
} = createPageLoader({ map: loadMapPage, route: loadRoutePage, alert: loadAlertPage, flood: loadFloodPage, admin: loadAdminPage });
