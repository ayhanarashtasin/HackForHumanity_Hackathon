import { Suspense, lazy, useLayoutEffect, useMemo } from 'react';
import { useRoute } from './lib/router.js';
import { useLanguage } from './i18n/index.js';
import { LandingPage } from './pages/LandingPage.jsx';
import { isLazyPage, loadedPage, preloadPage } from './pages/pageLoader.js';

// MapLibre and the whole weather UI load only when someone opens the map; the alert and admin pages are lazy chunks too
// (the admin chunk is never shipped to a visitor who never opens /admin).
// A screen whose chunk has already arrived renders directly. main.jsx loads the current screen's chunk before the first render and links
// warm the next one on hover, so the loading splash below is only for a chunk that is genuinely still on its way.
const LAZY = Object.fromEntries(['map', 'alert', 'admin'].map((route) => [route, lazy(() => preloadPage(route).then((component) => ({ default: component })))]));

const TITLES = {
  home: 'AkashSathi · Weather for every upazila of Bangladesh',
  map: 'AkashSathi · Bangladesh Weather Map',
  alert: 'AkashSathi · Weather alerts for your work',
  admin: 'AkashSathi · Administrator',
};

const LOADING = { map: 'Loading map…', alert: 'Loading alerts…', admin: 'Loading…' };

export default function App() {
  const route = useRoute();
  const { lang, tr } = useLanguage();

  // The map page is a fixed full-screen app; the landing, alert and admin pages scroll like normal documents (see landing.css and styles.css).
  useLayoutEffect(() => {
    document.documentElement.dataset.page = route === 'home' ? 'landing' : route;
    document.documentElement.lang = lang;
    document.title = tr(TITLES[route]);
    // Same colours as index.html: the browser's own bar is olive only over the map.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', route === 'map' ? '#2E3D28' : '#E8E9DF');

    // The administrator page must never be indexed.
    let robots = document.querySelector('meta[name="robots"][data-managed]');
    if (route === 'admin') {
      if (!robots) {
        robots = document.createElement('meta');
        robots.name = 'robots';
        robots.dataset.managed = 'true';
        document.head.appendChild(robots);
      }
      robots.content = 'noindex, nofollow';
    } else if (robots) {
      robots.remove();
    }
  }, [route, lang, tr]);

  // Chosen once per screen: switching between the loaded component and its lazy twin mid-visit would remount the page and lose its state.
  const Page = useMemo(() => (isLazyPage(route) ? (loadedPage(route) ?? LAZY[route]) : null), [route]);
  if (Page) {
    return (
      <Suspense fallback={<div className="splash" role="status">{tr(LOADING[route])}</div>}>
        <Page />
      </Suspense>
    );
  }

  return <LandingPage />;
}
