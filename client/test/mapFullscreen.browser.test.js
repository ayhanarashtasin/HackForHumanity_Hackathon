import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Uses the same optional Playwright installation and dev server as the other map browser checks.
test('fullscreen keeps simulations running, supports mobile fallback, and shows the Bay and real river courses', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1506, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const catalogue = JSON.parse(await readFile(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
  const now = Date.now();
  const status = { status: 'ok' };
  const series = { temp: [30, 31] };
  const snapshot = {
    base: 'bmd', steps: [new Date(now).toISOString(), new Date(now + 3_600_000).toISOString()],
    locations: Object.fromEntries(catalogue.locations.map(item => [item.pcode, series])),
    districts: Object.fromEntries(catalogue.districts.map(item => [item.pcode, series])),
    sources: { bmd: status, openMeteo: status },
  };
  const frames = [0, 10, 20].map(minute => ({
    observedAt: new Date(now + minute * 60_000).toISOString(), arrivals: [],
    cells: [{ id: 'offshore', intensity: 4, areaKm2: 300, polygon: [[90.8, 21], [91, 21], [91, 21.2], [90.8, 21.2], [90.8, 21]] }],
  }));
  const payloads = {
    '/api/weather/snapshot': snapshot,
    '/api/radar/frames': { sites: [], status },
    '/api/satellite/frames': { layers: {}, status },
    '/api/lightning/summaries': { items: [] },
    '/api/lightning/status': { mode: 'B', state: 'disabled', budget: {} },
    '/api/storms': { enabled: true, live: frames[0] },
    '/api/storms/demo': { snapshots: frames },
  };
  const assertFullscreen = async () => {
    await page.waitForFunction(() => {
      const stage = document.querySelector('.map-stage');
      const bounds = stage.getBoundingClientRect();
      const canvas = stage.querySelector('canvas').getBoundingClientRect();
      return bounds.x === 0 && bounds.y === 0 && bounds.width === innerWidth && bounds.height === innerHeight
        && Math.abs(canvas.width - innerWidth) < 1 && Math.abs(canvas.height - innerHeight) < 1;
    });
    assert.equal(await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.topbar').evaluate(element => element.inert), true);
    assert.equal(await page.locator('.timebar').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Map layers', exact: true }).isVisible(), true);
  };
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
      sessionStorage.setItem('akashsathi:location-dismissed', '1');
    });
    await page.route('**/api/**', route => route.fulfill({ json: { data: payloads[new URL(route.request().url()).pathname] ?? {} } }));
    await page.goto(`${process.env.UI_BASE_URL}/map#o=storms&storm=replay`);
    await page.locator('.map.is-ready').waitFor();
    await page.locator('.storm-player').waitFor();
    await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource').find(entry => /\/src\/map\/WeatherMap\.js/.test(entry.name))?.name;
      const { WeatherMap } = await import(moduleUrl ?? '/src/map/WeatherMap.js');
      const original = WeatherMap.prototype.onMouseMove;
      WeatherMap.prototype.onMouseMove = function (event) {
        window.__fullscreenMap = this;
        return original.call(this, event);
      };
      window.__fullscreenCanvas = document.querySelector('.maplibregl-canvas');
      const bounds = window.__fullscreenCanvas.getBoundingClientRect();
      window.__fullscreenCanvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: bounds.x + 10, clientY: bounds.y + 200 }));
    });
    await page.waitForFunction(() => window.__fullscreenMap?.ready);
    const credits = page.locator('.maplibregl-ctrl-attrib-inner');
    const creditsToggle = page.locator('.maplibregl-ctrl-attrib-button');
    assert.equal(await credits.isVisible(), false, 'the long source-credit strip must not cover the map by default');
    assert.equal(await creditsToggle.isVisible(), true, 'source credits remain accessible through the info button');
    await creditsToggle.click();
    assert.equal(await credits.isVisible(), true);
    assert.match(await credits.textContent(), /BMD/);
    assert.match(await credits.textContent(), /OpenStreetMap/);
    await creditsToggle.focus();
    await page.keyboard.press('Enter');
    assert.equal(await credits.isVisible(), false, 'keyboard users can collapse the credits too');
    await page.waitForFunction(() => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['bay-water'] }).length > 0);
    await page.waitForFunction(() => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['bay-of-bengal-label'] }).length > 0);
    assert.equal(await page.evaluate(() => {
      const ids = window.__fullscreenMap.map.getStyle().layers.map(layer => layer.id);
      return ids.indexOf('outside-mask') < ids.indexOf('bay-water') && ids.indexOf('bay-water') < ids.indexOf('storm-cell');
    }), true, 'the Bay is visible above the mask and offshore storms remain above the water');
    assert.equal(await page.evaluate(() => {
      const ids = window.__fullscreenMap.map.getStyle().layers.map(layer => layer.id);
      return ['national-fill', 'district-fill', 'upazila-fill', 'area-fill'].every(id => ids.indexOf(id) < ids.indexOf('water'))
        && ids.indexOf('water') < ids.indexOf('waterway-casing') && ids.indexOf('waterway-casing') < ids.indexOf('waterway')
        && ids.indexOf('waterway') < ids.indexOf('outside-mask') && ids.indexOf('names-areas') < ids.indexOf('label-river')
        && ids.indexOf('label-river') < ids.indexOf('markers-district');
    }), true, 'river geometry stays above weather fills, below the border mask and weather symbols, with names above dense ward labels');

    const initialBounds = await page.locator('.map-stage').boundingBox();
    await page.locator('.storm-player').getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await assertFullscreen();
    assert.equal(await credits.isVisible(), false, 'fullscreen must not reopen the source-credit strip');
    assert.equal(await page.evaluate(() => document.fullscreenElement === document.querySelector('.map-stage')), true);
    const frame = await page.locator('.storm-player > span').textContent();
    await page.waitForFunction(previous => document.querySelector('.storm-player > span').textContent !== previous, frame);
    await page.locator('.storm-player').getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    assert.equal(await page.locator('#map-layer-options').isVisible(), true);
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    assert.equal(await page.evaluate(() => document.querySelector('.maplibregl-canvas') === window.__fullscreenCanvas), true, 'fullscreen must not recreate the simulation');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.map-stage.is-fullscreen'));
    assert.deepEqual(await page.locator('.map-stage').boundingBox(), initialBounds);
    assert.equal(await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).evaluate(element => element === document.activeElement), true);

    // Browser-driven exit (including the browser's Escape action) also synchronizes the button and layout.
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await page.waitForFunction(() => document.fullscreenElement);
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).waitFor();

    await page.getByRole('button', { name: 'Turn off storm movement', exact: true }).click();
    for (const [width, height, unsupported] of [[375, 812, false], [667, 375, true]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: 'Explore map', exact: true }).click();
      await page.locator('.map-stage').evaluate((element, unavailable) => {
        element.requestFullscreen = unavailable ? undefined : () => Promise.reject(new Error('Fullscreen blocked'));
      }, unsupported);
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
      await assertFullscreen();
      assert.equal(await credits.isVisible(), false, 'resizing to mobile must not reopen the source-credit strip');
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).waitFor();
      assert.equal(await page.locator('.topbar').evaluate(element => element.inert), false);
    }
    await page.setViewportSize({ width: 1506, height: 900 });
    await page.locator('.language-toggle button').first().click();
    await page.getByRole('button', { name: 'পূর্ণ পর্দায় দেখুন', exact: true }).click();
    await page.getByRole('button', { name: 'পূর্ণ পর্দা থেকে ফিরুন', exact: true }).click();

    // Check real tile geometry at multiple scales, not just that river layers were registered.
    await page.evaluate(() => window.__fullscreenMap.map.jumpTo({ center: [90, 23.65], zoom: 9, padding: { top: 0, right: 0, bottom: 0, left: 0 } }));
    for (const name of ['Padma', 'Jamuna River', 'Meghna River']) {
      await page.waitForFunction(expected => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['waterway'] })
        .some(feature => (feature.properties['name:en'] ?? feature.properties['name:latin']) === expected), name);
    }
    await page.waitForFunction(() => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['label-river'] }).length > 0);
    assert.equal(await page.evaluate(() => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['water'] }).some(feature => feature.properties.class === 'river')), true);
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-river-detail.png') });
    await page.evaluate(() => window.__fullscreenMap.map.jumpTo({ center: [90.4, 23.72], zoom: 11 }));
    await page.waitForFunction(() => window.__fullscreenMap.map.queryRenderedFeatures({ layers: ['waterway'] })
      .some(feature => feature.properties['name:en'] === 'Buriganga River'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
