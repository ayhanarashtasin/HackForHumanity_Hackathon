import { Suspense, lazy, useLayoutEffect } from 'react';
import { useRoute } from './lib/router.js';
import { loadAdminPage } from './pages/loadAdminPage.js';
import { loadAlertPage } from './pages/loadAlertPage.js';
import { LandingPage } from './pages/LandingPage.jsx';
import { loadMapPage } from './pages/loadMapPage.js';

// MapLibre and the whole weather UI load only when someone opens the map; the alert and admin pages are lazy chunks too
// (the admin chunk is never shipped to a visitor who never opens /admin).
const MapPage = lazy(loadMapPage);
const AlertPage = lazy(loadAlertPage);
const AdminPage = lazy(loadAdminPage);

const TITLES = {
  home: 'AkashSathi · Weather for every upazila of Bangladesh',
  map: 'AkashSathi · Bangladesh Weather Map',
  alert: 'AkashSathi · Weather alerts for your work',
  admin: 'AkashSathi · Administrator',
};

const PAGES = { map: MapPage, alert: AlertPage, admin: AdminPage };
const LOADING = { map: 'Loading map…', alert: 'Loading alerts…', admin: 'Loading…' };

export default function App() {
  const route = useRoute();

  // The map page is a fixed full-screen app; the landing, alert and admin pages scroll like normal documents (see landing.css and styles.css).
  useLayoutEffect(() => {
    document.documentElement.dataset.page = route === 'home' ? 'landing' : route;
    document.title = TITLES[route];

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
  }, [route]);

  const Page = PAGES[route];
  if (Page) {
    return (
      <Suspense fallback={<div className="splash" role="status">{LOADING[route]}</div>}>
        <Page />
      </Suspense>
    );
  }

  return <LandingPage />;
}
