import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('district routes use town endpoints and changing places cancels an outdated search', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const catalogue = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'));
  const errors = [];
  const requests = [];
  let pending;
  let hold = false;
  page.on('pageerror', error => errors.push(error.message));
  const respond = route => {
    const { start, end } = route.request().postDataJSON();
    return route.fulfill({ json: { data: {
      start, end, coordinates: [[start.lon, start.lat], [end.lon, end.lat]],
      distanceKm: 25, durationMinutes: 60, samples: [], summary: {}, alternatives: [],
    } } });
  };
  const choose = async (field, place) => {
    await page.getByRole('combobox', { name: field, exact: true }).fill(place);
    await page.getByRole('option', { name: new RegExp(`^${place} ·`) }).first().click();
  };
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
      // Route planning must also work without WebGL or external basemap requests.
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return /webgl/.test(type) ? null : getContext.call(this, type, ...args);
      };
    });
    await page.route('**/api/weather/snapshot', route => route.fulfill({ json: { data: { steps: [], locations: {}, districts: {} } } }));
    await page.route('**/api/weather/daily', route => route.fulfill({ json: { data: { days: [] } } }));
    await page.route('**/api/lightning/summaries', route => route.fulfill({ json: { data: { items: [] } } }));
    await page.route('**/api/weather/route/hospitals', route => route.fulfill({ json: { data: { disabled: true } } }));
    await page.route('**/api/weather/route', route => {
      requests.push(route.request().postDataJSON());
      if (hold) pending = route;
      else return respond(route);
    });
    await page.goto(`${process.env.UI_BASE_URL}/route`);
    await page.getByText('The interactive map could not start. Your route weather is still available below.', { exact: true }).waitFor();
    await page.locator('.location-notice-actions button:last-child').click();
    await choose('Start', 'Dhaka');
    await choose('Destination', 'Narayanganj');
    await page.getByRole('button', { name: 'Show my route', exact: true }).click();
    await page.locator('.route-result-stats').waitFor();
    const start = catalogue.locations.find(item => item.pcode === '302654');
    const end = catalogue.locations.find(item => item.pcode === '306758');
    assert.deepEqual(requests[0], {
      start: { name: 'Dhaka', lat: start.lat, lon: start.lon },
      end: { name: 'Narayanganj', lat: end.lat, lon: end.lon },
    }, 'district centroids are map labels, not route endpoints');
    assert.match(await page.locator('.route-arrival-source').textContent(), /Forecast from Narayanganj Sadar/);

    hold = true;
    const requested = page.waitForRequest(request => request.url().endsWith('/api/weather/route') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Show my route', exact: true }).click();
    await requested;
    await choose('Destination', 'Bandarban');
    assert.ok(await page.locator('.route-submit').isEnabled(), 'changing a place cancels the previous loading state');
    await respond(pending);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.route-result-stats').count(), 0, 'a late response must not restore the previous route');
    hold = false;
    await page.getByRole('button', { name: 'Show my route', exact: true }).click();
    await page.locator('.route-result-stats').waitFor();
    assert.match(await page.locator('.route-ends').textContent(), /Bandarban/);
    assert.equal(requests.at(-1).end.lat, catalogue.locations.find(item => item.pcode === '200314').lat);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
