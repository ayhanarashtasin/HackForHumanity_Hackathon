import assert from 'node:assert/strict';
import { test } from 'node:test';

test('route map links weather markers, compact stops, alternatives, refresh, languages and responsive layouts', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const now = Date.now();
  const catalogue = {
    districts: [
      { pcode: 'D1', name: 'Dhaka', nameBn: 'ঢাকা', division: 'Dhaka', lat: 23.1, lon: 90.1 },
      { pcode: 'D2', name: 'Narayanganj', nameBn: 'নারায়ণগঞ্জ', division: 'Dhaka', lat: 23.1, lon: 90.5 },
    ],
    locations: [
      { pcode: 'U1', pid: 'P1', name: 'Tejgaon', nameBn: 'তেজগাঁও', district: 'D1', lat: 23.1, lon: 90.1 },
      { pcode: 'U2', pid: 'P2', name: 'Narayanganj Sadar', nameBn: 'নারায়ণগঞ্জ সদর', district: 'D2', lat: 23.1, lon: 90.5 },
    ],
    polygons: { P1: { src: ['U1'], name: 'Tejgaon' }, P2: { src: ['U2'], name: 'Narayanganj Sadar' } },
    areas: [],
  };
  const geo = { type: 'FeatureCollection', features: [0, 1].map(index => ({
    type: 'Feature', properties: { pid: `P${index + 1}` },
    geometry: { type: 'Polygon', coordinates: [[[90 + index * .3, 23], [90.3 + index * .3, 23], [90.3 + index * .3, 23.3], [90 + index * .3, 23.3], [90 + index * .3, 23]]] },
  })) };
  let refreshed = false;
  let weatherFailure = false;
  let routeCalls = 0;
  const forecast = () => ({
    base: 'bmd', thunderSource: 'open-meteo', generatedAt: new Date(now).toISOString(),
    steps: [-1, 2, 5].map(hours => new Date(now + hours * 3_600_000).toISOString()),
    sources: { bmd: { status: 'ok', dataTime: new Date(now).toISOString() }, openMeteo: { status: 'ok' } },
    locations: Object.fromEntries(['U1', 'U2'].map(id => [id, { temp: Array(3).fill(refreshed ? 31 : 24), hi: [28, 28, 28], rf: [2, 2, 2], wg: [12, 12, 12], ts: [1, 1, 1] }])),
    districts: Object.fromEntries(['D1', 'D2'].map(id => [id, { temp: Array(3).fill(refreshed ? 31 : 24), hiMax: [28, 28, 28], rfMax: [2, 2, 2], wgMax: [12, 12, 12], ts: [1, 1, 1] }])),
  });
  const option = { coordinates: [[90.1, 23.1], [90.3, 23.15], [90.5, 23.1]], distanceKm: 50, durationMinutes: 60, samples: [
    { place: { id: 'U1' }, etaMs: now }, { place: { id: 'U2' }, etaMs: now + 3_600_000 },
  ], summary: {} };
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
    });
    await page.route('**/data/locations.json', route => route.fulfill({ json: catalogue }));
    await page.route('**/data/bd-upazila.geojson', route => route.fulfill({ json: geo }));
    await page.route('**/api/weather/snapshot', route => weatherFailure ? route.fulfill({ status: 503, json: { message: 'Temporarily unavailable' } }) : route.fulfill({ json: { data: forecast() } }));
    await page.route('**/api/weather/daily', route => route.fulfill({ json: { data: {
      days: [1, 2, 3].map(day => new Date(now + day * 86_400_000).toISOString().slice(0, 10)),
      locations: { U2: { tmin: [22, 23, 24], tmax: [30, 31, 32], rf: [1, 2, 0], ws: [10, 12, 8] } },
    } } }));
    await page.route('**/api/lightning/summaries', route => route.fulfill({ json: { data: { mode: 'A', items: [] } } }));
    await page.route('**/api/weather/route', route => {
      routeCalls++;
      return route.fulfill({ json: { data: { ...option,
        start: { lon: 90.1, lat: 23.1 }, end: { lon: 90.5, lat: 23.1 },
        alternatives: [{ ...option, coordinates: [[90.1, 23.1], [90.3, 23.25], [90.5, 23.1]], distanceKm: 70, durationMinutes: 80 }],
      } } });
    });
    await page.goto(`${process.env.UI_BASE_URL}/route`);
    const notice = page.locator('.location-notice-actions button:last-child');
    await notice.waitFor();
    await notice.click();
    await page.locator('.route-map-tools').waitFor({ timeout: 35_000 });
    assert.ok(await page.getByRole('button', { name: 'Zoom in', exact: true }).isVisible());
    // Capture the instance through a public control method; no production debug globals.
    await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource').find(entry => /\/maplibre-gl\.js/.test(entry.name))?.name;
      const { MapLibreMap } = await import(moduleUrl);
      const original = MapLibreMap.prototype.zoomIn;
      MapLibreMap.prototype.zoomIn = function (...args) {
        window.__routeMapTest = this;
        window.__routeZoomBefore = this.getZoom();
        MapLibreMap.prototype.zoomIn = original;
        return original.apply(this, args);
      };
    });
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(() => window.__routeMapTest?.getZoom() > window.__routeZoomBefore + .5 && !window.__routeMapTest.isMoving());
    const wheelBefore = await page.evaluate(() => window.__routeMapTest.getZoom());
    const canvas = await page.locator('.route-map-canvas canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(before => window.__routeMapTest.getZoom() > before + .15 && !window.__routeMapTest.isMoving(), wheelBefore);
    const outBefore = await page.evaluate(() => window.__routeMapTest.getZoom());
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await page.waitForFunction(before => window.__routeMapTest.getZoom() < before - .5 && !window.__routeMapTest.isMoving(), outBefore);
    assert.ok(await page.evaluate(() => window.__routeMapTest.touchZoomRotate.isEnabled()), 'pinch zoom remains enabled');
    const geographicChecks = await page.evaluate(() => {
      const map = window.__routeMapTest;
      const layers = map.getStyle().layers.map(layer => layer.id);
      map.jumpTo({ center: [90.4, 23.75], zoom: 17 });
      const streetZoom = map.getZoom();
      map.jumpTo({ center: [-10, 45], zoom: 0 });
      const center = map.getCenter();
      return { streetZoom, zoom: map.getZoom(), min: map.getMinZoom(), center, layers };
    });
    assert.equal(geographicChecks.streetZoom, 17, 'street-level zoom is not capped at country view');
    assert.equal(geographicChecks.zoom, geographicChecks.min, 'zooming out cannot shrink Bangladesh into a speck');
    assert.ok(geographicChecks.center.lng >= 87.4 && geographicChecks.center.lng <= 93.35);
    assert.ok(geographicChecks.center.lat >= 19.95 && geographicChecks.center.lat <= 27.3);
    for (const id of ['label-country', 'label-state', 'label-city', 'route-street-names']) assert.ok(geographicChecks.layers.indexOf(id) < geographicChecks.layers.indexOf('outside-mask'));
    for (const id of ['district-line', 'upazila-line', 'area-line', 'names-upazila', 'route-local-roads', 'bay-water', 'national-line']) assert.ok(geographicChecks.layers.includes(id));
    await page.evaluate(() => window.__routeMapTest.jumpTo({ center: [90.4, 23.75], zoom: 16, padding: { top: 0, bottom: 0, left: 0, right: 0 } }));
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.waitForFunction(() => window.__routeMapTest.getZoom() > 16.5 && !window.__routeMapTest.isMoving());
    await page.waitForFunction(() => window.__routeMapTest.queryRenderedFeatures({ layers: ['route-local-roads'] }).length > 0
      && window.__routeMapTest.queryRenderedFeatures({ layers: ['route-buildings'] }).length > 0);
    await page.getByRole('button', { name: 'Bangladesh', exact: true }).click();
    await page.waitForFunction(() => !window.__routeMapTest.isMoving());
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-country.png') });
    for (const [field, name] of [['Start', 'Dhaka'], ['Destination', 'Narayanganj']]) {
      await page.getByRole('combobox', { name: field, exact: true }).fill(name);
      await page.getByRole('option', { name: new RegExp(`^${name}`) }).first().click();
    }
    await page.getByRole('button', { name: 'Show my route', exact: true }).click();
    await page.locator('.route-map-marker').first().waitFor();
    assert.equal(await page.locator('.route-map-marker').count(), 2);
    assert.equal(await page.locator('.route-map-endpoint').allTextContents().then(values => values.join('')), 'AB');
    assert.match(await page.locator('.route-map-weather').textContent(), /24\.0°C/);
    await page.locator('.route-map-marker').nth(1).click();
    assert.equal(await page.locator('.route-stop-toggle').nth(1).getAttribute('aria-expanded'), 'true');
    assert.match(await page.locator('.route-map-weather').textContent(), /Narayanganj/);
    await page.locator('.route-map-marker').first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.route-map-marker').first().getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Full screen map', exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.locator('.route-map-fullscreen-weather').waitFor();
    await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.getByRole('button', { name: 'Alternative route', exact: false }).click();
    assert.match(await page.locator('.route-result-stats').textContent(), /70\.0/);
    await page.getByRole('button', { name: 'Fit route', exact: true }).click();
    await page.getByRole('button', { name: 'Division', exact: true }).click();
    assert.equal(await page.locator('.route-map-marker').count(), 1);
    await page.getByRole('button', { name: 'Upazila / thana', exact: true }).click();
    assert.equal(await page.locator('.route-map-marker').count(), 2);
    refreshed = true;
    await page.getByRole('button', { name: 'Refresh forecast', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.route-map-weather')?.textContent.includes('31.0°C'));
    assert.equal(routeCalls, 1, 'weather refresh must not re-request road geometry');
    weatherFailure = true;
    await page.getByRole('button', { name: 'Refresh forecast', exact: true }).click();
    await page.getByText('Forecast may be incomplete or out of date.', { exact: true }).waitFor();
    assert.match(await page.locator('.route-map-weather').textContent(), /31\.0°C/, 'failed refresh retains last successful forecast with a warning');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-desktop.png'), fullPage: true });
    for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.route-map-stage').getBoundingClientRect();
        return [...document.querySelectorAll('.route-map-marker')].every(marker => {
          const box = marker.getBoundingClientRect();
          return box.x >= canvas.x && box.right <= canvas.right && box.y >= canvas.y && box.bottom <= canvas.bottom;
        });
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${viewport.width}`);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator('.language-toggle button').first().click();
    await page.getByRole('heading', { name: 'আপনার পথ পরিকল্পনা করুন', exact: true }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'পুরো পথ দেখুন', exact: true }).isVisible());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
    // Missing WebGL must not block planning; retry restores the existing route and its markers.
    await page.addInitScript(() => {
      window.__routeTestDisableWebgl = true;
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return window.__routeTestDisableWebgl && /webgl/.test(type) ? null : getContext.call(this, type, ...args);
      };
      localStorage.setItem('akashsathi.alert.language', 'en');
    });
    weatherFailure = false;
    await page.reload();
    await page.getByText('The interactive map could not start. Your route weather is still available below.', { exact: true }).waitFor();
    for (const [field, name] of [['Start', 'Dhaka'], ['Destination', 'Narayanganj']]) {
      await page.getByRole('combobox', { name: field, exact: true }).fill(name);
      await page.getByRole('option', { name: new RegExp(`^${name}`) }).first().click();
    }
    await page.getByRole('button', { name: 'Show my route', exact: true }).click();
    await page.locator('.route-map-weather').waitFor();
    await page.evaluate(() => { window.__routeTestDisableWebgl = false; });
    await page.getByRole('button', { name: 'Retry map', exact: true }).click();
    await page.locator('.route-map-marker').first().waitFor({ timeout: 35_000 });
    assert.equal(await page.locator('.route-map-marker').count(), 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
