import assert from 'node:assert/strict';
import { test } from 'node:test';

// Uses the same optional, already-installed Playwright setup as stormPanel.test.js.
test('map indicators explain real canvas hits, stay in bounds, support keyboard inspection and mobile taps', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1506, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cell = {
    id: 'c1', intensity: 6, areaKm2: 400, center: { lat: 22.2, lon: 88.5 },
    polygon: [[88.35, 22.1], [88.65, 22.1], [88.65, 22.3], [88.35, 22.3], [88.35, 22.1]],
    motion: { speedKmh: 20, towards: 'SW', bearingDeg: 225 },
    forecast: [30, 60, 90].map(minutes => ({ minutes, lat: 22.2 - minutes / 150, lon: 88.5 - minutes / 300, radiusKm: 15 })),
  };
  const storm = { observedAt: '2026-09-22T10:00:00Z', cells: [cell], arrivals: [] };
  try {
    await page.addInitScript(() => localStorage.setItem('akashsathi.alert.language', 'en'));
    await page.route('**/api/storms', route => route.fulfill({ json: { data: { enabled: true, live: storm } } }));
    await page.route('**/api/storms/demo', route => route.fulfill({ json: { data: { snapshots: [storm, { ...storm, observedAt: '2026-09-22T10:10:00Z' }], bounds: [88, 20, 93, 27] } } }));
    await page.route('**/api/lightning/summaries', route => route.fulfill({ json: { data: { items: [{
      id: 'L1', kind: 'circle', lat: 24, lon: 88.5, radiusKm: 30, state: 'none', count: 0,
      sampledAt: storm.observedAt, window: { from: storm.observedAt, to: '2026-09-22T10:05:00Z' },
    }] } } }));
    await page.route('**/api/lightning/status', route => route.fulfill({ json: { data: { mode: 'B', state: 'disabled', budget: { locationCount: 1 } } } }));
    await page.goto(`${process.env.UI_BASE_URL}/map#o=storms&storm=replay`);
    await page.locator('.location-notice-actions button:last-child').click();
    await page.locator('.map.is-ready').waitFor();
    await page.getByRole('heading', { name: '1 storm cells', exact: true }).waitFor();
    // Capture the running instance through an existing event method, without adding a production debug global.
    await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource').find(entry => /\/src\/map\/WeatherMap\.js/.test(entry.name))?.name;
      const { WeatherMap } = await import(moduleUrl ?? '/src/map/WeatherMap.js');
      const original = WeatherMap.prototype.onMouseMove;
      WeatherMap.prototype.onMouseMove = function (event) { window.__indicatorTestMap = this; return original.call(this, event); };
      const canvas = document.querySelector('.maplibregl-canvas');
      const bounds = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: bounds.x + 30, clientY: bounds.y + bounds.height / 2 }));
    });
    const canvasBox = await page.locator('.maplibregl-canvas').boundingBox();
    await page.mouse.move(canvasBox.x + 30, canvasBox.y + canvasBox.height / 2);
    await page.waitForFunction(() => window.__indicatorTestMap?.stormFeatures?.length);
    await page.waitForFunction(() => window.__indicatorTestMap.map.isSourceLoaded('storms'));
    const ringPoint = await page.evaluate(() => {
      const instance = window.__indicatorTestMap;
      const bounds = instance.map.getCanvas().getBoundingClientRect();
      const ring = instance.stormFeatures.find(feature => feature.properties.kind === 'ring' && feature.properties.minutes === 30);
      for (const coordinate of ring.geometry.coordinates[0]) {
        const point = instance.map.project(coordinate);
        const picked = instance.indicatorsAt(point)[0]?.picked;
        const element = document.elementFromPoint(bounds.x + point.x, bounds.y + point.y);
        if (picked?.kind === 'ring' && picked.minutes === 30 && element?.classList.contains('maplibregl-canvas')) return { x: bounds.x + point.x, y: bounds.y + point.y };
      }
      throw new Error('No visible, unobscured ring outline');
    });
    await page.mouse.move(ringPoint.x, ringPoint.y);
    const tooltip = page.getByRole('tooltip', { name: 'Predicted storm position' });
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /30 min after the satellite image/);
    assert.match(await tooltip.textContent(), /Saved replay · not live/);
    assert.match(await tooltip.textContent(), /4:30/);
    assert.match(await tooltip.textContent(), /Extreme/);
    await page.mouse.click(ringPoint.x, ringPoint.y);
    await page.getByRole('dialog', { name: 'Predicted storm position' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.map-inspection').count(), 0);
    assert.equal(await page.evaluate(() => window.__indicatorTestMap.inspection), null);

    await page.locator('.map-key summary').click();
    const select = page.getByLabel('Inspect a map indicator');
    await select.selectOption(JSON.stringify({ type: 'storm', id: 'c1', kind: 'ring', minutes: 60 }));
    const dialog = page.getByRole('dialog', { name: 'Predicted storm position' });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /60 min after/);
    assert.equal(await dialog.evaluate(element => element === document.activeElement), true);
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-desktop.png') });
    const box = await dialog.boundingBox();
    const mapBox = await page.locator('.map-stage').boundingBox();
    assert.ok(box.x >= mapBox.x && box.y >= mapBox.y && box.x + box.width <= mapBox.x + mapBox.width && box.y + box.height <= mapBox.y + mapBox.height);
    await page.getByRole('button', { name: 'Close indicator details' }).click();
    await page.locator('.map-key summary').click();
    await page.locator('.language-toggle button').first().click();
    await page.locator('.map-key summary').click();
    await page.getByLabel('মানচিত্রের চিহ্নের বিস্তারিত দেখুন').selectOption(JSON.stringify({ type: 'storm', id: 'c1', kind: 'cell' }));
    await page.getByRole('dialog', { name: 'ঝড়ের মেঘ' }).waitFor();
    assert.match(await page.locator('.map-inspection').textContent(), /অতি তীব্র/);
    await page.locator('.language-toggle button').last().click();
    await page.getByRole('button', { name: 'Next frame', exact: true }).click();
    await page.locator('.map-inspection').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__indicatorTestMap.inspection), null, 'changing replay frame clears the old card and highlight');

    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Lightning summaries', exact: true }).click();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    await page.getByLabel('Inspect a map indicator').selectOption(JSON.stringify({ type: 'lightning', id: 'L1' }));
    await page.getByRole('dialog', { name: 'Lightning search circle' }).waitFor();
    assert.match(await page.locator('.map-inspection').textContent(), /No records in window/);
    assert.match(await page.locator('.map-inspection').textContent(), /Recorded events0/);
    assert.match(await page.locator('.map-inspection').textContent(), /Sample window/);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Hide lightning panel', exact: true }).click();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Lightning summaries', exact: true }).click();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Explore map', exact: true }).click();
    await page.locator('.map-key summary').click();
    await page.getByRole('button', { name: 'Turn off storm movement' }).click();
    await page.waitForFunction(() => !window.__indicatorTestMap.map.isMoving());
    const tapPoint = await page.evaluate(() => {
      const instance = window.__indicatorTestMap;
      const bounds = instance.map.getCanvas().getBoundingClientRect();
      for (const base of instance.baseMarkers.filter(marker => marker.level === 'district')) {
        const point = instance.map.project([base.lon, base.lat]);
        const element = document.elementFromPoint(bounds.x + point.x, bounds.y + point.y);
        if (element?.classList.contains('maplibregl-canvas') && instance.indicatorsAt(point)[0]?.picked.type === 'weather') return { x: bounds.x + point.x, y: bounds.y + point.y };
      }
      throw new Error('No visible weather marker to tap');
    });
    await page.touchscreen.tap(tapPoint.x, tapPoint.y);
    await page.locator('.map-inspection.is-pinned').waitFor();
    assert.equal(await page.locator('.weather-app').evaluate(element => element.classList.contains('mobile-view-map')), true);
    assert.equal(await page.locator('.map-inspection').evaluate(element => getComputedStyle(element).display), 'flex');
    const mobileBox = await page.locator('.map-inspection').boundingBox();
    assert.ok(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 375);
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
    assert.deepEqual(errors, []);
  } catch (error) {
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
    throw error;
  } finally {
    await browser.close();
  }
});
