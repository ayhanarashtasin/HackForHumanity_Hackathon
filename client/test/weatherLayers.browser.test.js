import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('multiple weather layers render together, compare on hover, persist in links, and remain selectable on mobile', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1506, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const catalogue = JSON.parse(await readFile(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
  const now = Date.now();
  const series = { temp: [32, 32], hi: [39, 39], hiMax: [39, 39], rf: [2, 2], rfMax: [2, 2], ws: [20, 20], wsMax: [20, 20], wd: [90, 90], ts: [2, 2] };
  const status = name => ({ name, label: name, status: 'ok', dataTime: new Date(now).toISOString() });
  const snapshot = {
    base: 'bmd', baseLabel: 'BMD WRF forecast', steps: [new Date(now - 1000).toISOString(), new Date(now + 3_600_000).toISOString()],
    locations: Object.fromEntries(catalogue.locations.map(item => [item.pcode, series])),
    districts: Object.fromEntries(catalogue.districts.map(item => [item.pcode, series])),
    sources: { bmd: status('bmd'), openMeteo: status('openMeteo') },
  };
  const captureMap = async () => {
    await page.locator('.map.is-ready').waitFor();
    await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource').find(entry => /\/src\/map\/WeatherMap\.js/.test(entry.name))?.name;
      const { WeatherMap } = await import(moduleUrl ?? '/src/map/WeatherMap.js');
      const original = WeatherMap.prototype.onMouseMove;
      WeatherMap.prototype.onMouseMove = function (event) {
        window.__weatherLayerMap = this;
        return original.call(this, event);
      };
      const canvas = document.querySelector('.maplibregl-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.x + 30, clientY: rect.y + 250 }));
    });
    await page.waitForFunction(() => window.__weatherLayerMap?.ready);
  };
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
      sessionStorage.removeItem('akashsathi:location-dismissed');
    });
    await page.route('**/api/weather/snapshot', route => route.fulfill({ json: { data: snapshot } }));
    await page.route('**/api/radar/frames', route => route.fulfill({ json: { data: { sites: [], status: status('radar') } } }));
    await page.route('**/api/satellite/frames', route => route.fulfill({ json: { data: { layers: {}, status: status('satellite') } } }));
    await page.route('**/api/lightning/summaries', route => route.fulfill({ json: { data: { items: [] } } }));
    await page.route('**/api/lightning/status', route => route.fulfill({ json: { data: { mode: 'B', state: 'disabled', budget: { locationCount: 0 } } } }));
    await page.route('**/api/storms', route => route.fulfill({ json: { data: { enabled: true, live: { observedAt: new Date(now).toISOString(), cells: [], arrivals: [] } } } }));
    await page.goto(`${process.env.UI_BASE_URL}/map`);
    await page.locator('.location-notice-actions button:last-child').click();
    await captureMap();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    const menu = page.locator('#map-layer-options');
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isChecked(), true);
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isDisabled(), false);
    for (const name of ['Heat index', 'Rain', 'Wind', 'Thunderstorm']) {
      await menu.getByRole('checkbox', { name, exact: true }).click();
      assert.equal(await menu.isVisible(), true, 'selection must not close the menu');
    }
    await menu.getByLabel('Map colors', { exact: true }).selectOption('rain');
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isChecked(), true);
    assert.match(new URL(page.url()).hash, /layers=temp,heat,rain,wind,thunder/);
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    await page.waitForFunction(() => window.__weatherLayerMap.map.isSourceLoaded('markers'));
    await page.waitForFunction(() => new Set(window.__weatherLayerMap.map.queryRenderedFeatures({ layers: ['markers-district'] }).map(feature => feature.properties.signLayer)).size === 5);
    assert.equal(await page.evaluate(async () => {
      const { colorAt } = await import('/src/lib/scales.js');
      const instance = window.__weatherLayerMap;
      const color = instance.map.getFeatureState({ source: 'districts', id: instance.catalogue.districts[0].pcode }).color;
      return color === colorAt('rain', 2);
    }), true, 'background colors follow only the chosen rain scale, not the other selected metrics');
    const windPoint = await page.evaluate(() => {
      const instance = window.__weatherLayerMap;
      const bounds = instance.map.getCanvas().getBoundingClientRect();
      const zoom = instance.map.getZoom();
      const size = zoom <= 5 ? .58 : zoom <= 8 ? .58 + (zoom - 5) * .14 / 3 : .72 + Math.min(zoom - 8, 3) * .18 / 3;
      for (const feature of instance.map.queryRenderedFeatures({ layers: ['markers-district'] })) {
        if (feature.properties.signLayer !== 'wind') continue;
        const point = instance.map.project(feature.geometry.coordinates);
        point.x += feature.properties.markerShift * size;
        const picked = instance.indicatorsAt(point)[0]?.picked;
        const element = document.elementFromPoint(bounds.x + point.x, bounds.y + point.y);
        if (picked?.signLayer === 'wind' && element?.classList.contains('maplibregl-canvas')) return { x: bounds.x + point.x, y: bounds.y + point.y };
      }
      throw new Error('A rotated wind symbol could not be hit at its displayed offset');
    });
    await page.mouse.move(windPoint.x, windPoint.y);
    const card = page.getByRole('tooltip');
    await card.waitFor();
    const text = await card.textContent();
    for (const expected of ['Temperature', 'Heat index', 'Rain', 'Wind', 'Thunderstorm', '32 °C', '39 °C', '2.0 mm', '20 km/h', 'Moderate', 'Map colorsRain']) assert.ok(text.includes(expected), expected);
    assert.equal(await card.getByText('Source', { exact: true }).count(), 0);
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
    await page.reload();
    await page.locator('.location-notice-actions button:last-child').click();
    await captureMap();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    for (const name of ['Temperature', 'Heat index', 'Rain', 'Wind', 'Thunderstorm']) assert.equal(await menu.getByRole('checkbox', { name, exact: true }).isChecked(), true);
    assert.equal(await menu.getByLabel('Map colors', { exact: true }).inputValue(), 'rain');
    await menu.getByRole('button', { name: 'None', exact: true }).click();
    assert.equal(await menu.getByRole('button', { name: 'None', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await menu.getByLabel('Map colors', { exact: true }).count(), 0);
    await page.waitForFunction(() => window.__weatherLayerMap.map.isSourceLoaded('markers') && !window.__weatherLayerMap.map.queryRenderedFeatures({ layers: ['markers-district', 'markers-upazila'] }).length);
    assert.equal(await page.evaluate(() => {
      const instance = window.__weatherLayerMap;
      return instance.catalogue.districts.every(item => instance.map.getFeatureState({ source: 'districts', id: item.pcode }).color === 'rgba(0,0,0,0)');
    }), true, 'None removes previously painted weather colors');
    assert.equal(await page.locator('.legend').count(), 0);
    await menu.getByRole('checkbox', { name: 'Radar', exact: true }).click();
    await page.reload();
    await page.locator('.location-notice-actions button:last-child').click();
    await page.getByRole('button', { name: 'Map layers', exact: true }).click();
    assert.equal(await menu.getByRole('button', { name: 'None', exact: true }).getAttribute('aria-pressed'), 'true');
    for (const name of ['Temperature', 'Heat index', 'Rain', 'Wind', 'Thunderstorm']) assert.equal(await menu.getByRole('checkbox', { name, exact: true }).isChecked(), false);
    assert.equal(await menu.getByRole('checkbox', { name: 'Radar', exact: true }).isChecked(), true, 'None must not turn off independently selected overlays');
    await menu.getByRole('checkbox', { name: 'Radar', exact: true }).click();
    for (const name of ['Temperature', 'Heat index', 'Rain', 'Wind', 'Thunderstorm']) await menu.getByRole('checkbox', { name, exact: true }).click();
    await menu.getByLabel('Map colors', { exact: true }).selectOption('rain');
    await menu.getByRole('checkbox', { name: 'Rain', exact: true }).focus();
    await page.keyboard.press('Space');
    assert.equal(await menu.getByLabel('Map colors', { exact: true }).inputValue(), 'temp', 'removing the color layer chooses another selected layer');
    for (const name of ['Radar', 'Satellite', 'Lightning summaries', 'Storm movement']) {
      await menu.getByRole('checkbox', { name, exact: name !== 'Storm movement' }).click();
      assert.equal(await menu.isVisible(), true, 'overlays can be selected together without a panel stealing focus');
    }
    assert.match(new URL(page.url()).hash, /o=radar,satellite,lightning,storms/);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Explore map', exact: true }).click();
    for (const name of ['Heat index', 'Wind', 'Thunderstorm']) await menu.getByRole('checkbox', { name, exact: true }).click();
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isDisabled(), false);
    await menu.getByRole('checkbox', { name: 'Rain', exact: true }).click();
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isChecked(), true);
    assert.equal(await menu.getByRole('checkbox', { name: 'Rain', exact: true }).isChecked(), true);
    await menu.getByRole('button', { name: 'None', exact: true }).tap();
    assert.equal(await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).isChecked(), false);
    assert.equal(await menu.getByRole('checkbox', { name: 'Rain', exact: true }).isChecked(), false);
    assert.equal(await menu.getByRole('checkbox', { name: 'Radar', exact: true }).isChecked(), true);
    await menu.getByRole('checkbox', { name: 'Temperature', exact: true }).click();
    await menu.getByRole('checkbox', { name: 'Rain', exact: true }).click();
    await page.locator('.language-toggle button').first().click();
    assert.equal(await menu.getByRole('checkbox', { name: 'তাপমাত্রা', exact: true }).isChecked(), true);
    assert.equal(await menu.getByRole('checkbox', { name: 'বৃষ্টি', exact: true }).isChecked(), true);
    await page.setViewportSize({ width: 667, height: 375 });
    await menu.getByRole('checkbox', { name: 'বাতাস', exact: true }).click();
    assert.equal(await menu.getByRole('checkbox', { name: 'বাতাস', exact: true }).isChecked(), true, 'landscape phones retain usable multi-select controls');
    assert.deepEqual(errors, []);
  } catch (error) {
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
    throw error;
  } finally {
    await browser.close();
  }
});
