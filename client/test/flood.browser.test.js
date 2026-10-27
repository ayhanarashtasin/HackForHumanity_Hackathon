import assert from 'node:assert/strict';
import { test } from 'node:test';

test('flood view separates live and demo readings and remains usable on small screens', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const summary = { alertingAreas: 1, approaching: 0, above: 1, significantlyAbove: 0, observedStations: 2, unmatchedStations: 1 };
  const group = {
    key: 'live', name: 'Live Town', nameBn: 'লাইভ এলাকা', scope: 'upazila', lat: 23.8, lon: 90.4,
    classification: 'ABOVE', level: 2, aboveDangerM: .3, shelterStatus: 'FRESH',
    stations: [{ stationId: 1, name: 'River Gauge', river: 'River', waterLevelM: 9.5, dangerLevelM: 9.2, measuredAt: '2026-10-27T12:00:00Z' }],
    shelters: [{ id: 's1', name: 'Community School', distanceKm: 2, mapsUrl: 'https://www.google.com/maps/dir/?api=1&destination=23.8,90.4' }],
  };
  const live = { demo: false, status: 'FRESH', fetchedAt: '2026-10-27T12:00:00Z', summary, groups: [group] };
  const demo = {
    demo: true, status: 'DEMO', summary, groups: [
      { ...group, key: 'demo', name: 'Demo Town', nameBn: 'ডেমো এলাকা', shelters: [], shelterStatus: 'UNAVAILABLE' },
      { ...group, key: 'no-location', name: 'Unknown Area', lat: null, lon: null, shelters: [], shelterStatus: 'STALE' },
    ],
  };
  let liveMode = 'fresh';
  let releaseDemo;
  const demoPending = new Promise(resolve => { releaseDemo = resolve; });
  try {
    await page.addInitScript(() => localStorage.setItem('akashsathi.alert.language', 'en'));
    await page.route('**/api/flood/status', route => {
      if (liveMode === 'error') return route.fulfill({ status: 503, json: { message: 'The request failed. Please try again.' } });
      if (liveMode === 'unavailable') return route.fulfill({ json: { data: { ...live, status: 'UNAVAILABLE', summary: { ...summary, alertingAreas: 0 }, groups: [] } } });
      if (liveMode === 'empty') return route.fulfill({ json: { data: { ...live, summary: { ...summary, alertingAreas: 0 }, groups: [] } } });
      return route.fulfill({ json: { data: { ...live, status: liveMode === 'stale' ? 'STALE' : 'FRESH' } } });
    });
    await page.route('**/api/flood/demo', async route => {
      await demoPending;
      await route.fulfill({ json: { data: demo } });
    });
    await page.goto(`${process.env.UI_BASE_URL}/flood`);
    await page.getByRole('heading', { name: 'Live Town' }).waitFor();
    assert.ok(await page.getByRole('link', { name: 'Directions to Community School' }).isVisible());
    assert.ok(await page.getByText('2 km from area centre').isVisible());
    assert.ok(await page.getByText('Gauges not matched to an area: 1. They are not included in this summary or the area list.').isVisible());

    await page.getByRole('button', { name: 'Demo view' }).click();
    assert.equal(new URL(page.url()).pathname, '/flood/demo');
    assert.equal(await page.getByRole('button', { name: 'Demo view' }).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.getByText('DEMO DATA:', { exact: false }).isVisible());
    assert.equal(await page.getByRole('heading', { name: 'Live Town' }).count(), 0, 'live readings are not shown as demo while the request is pending');
    assert.ok(await page.getByRole('status').filter({ hasText: 'Loading the latest river readings' }).isVisible());
    releaseDemo();
    await page.getByRole('heading', { name: 'Demo Town' }).waitFor();
    assert.ok(await page.getByText('DDM shelter information is not available right now.').isVisible());
    assert.ok(await page.getByText('Nearby shelters cannot be matched because this area has no coordinates.').isVisible());
    assert.ok(await page.getByText('The shelter list may be out of date.', { exact: false }).isVisible());

    await page.getByRole('button', { name: 'Live gauges' }).click();
    await page.getByRole('heading', { name: 'Live Town' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Demo Town' }).count(), 0, 'demo readings are never presented as live');
    assert.equal(new URL(page.url()).pathname, '/flood');

    await page.goto(`${process.env.UI_BASE_URL}/flood/demo/`);
    await page.getByRole('heading', { name: 'Demo Town' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Demo view' }).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.getByText('DEMO DATA:', { exact: false }).isVisible());
    await page.reload();
    await page.getByRole('heading', { name: 'Demo Town' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Live Town' }).count(), 0);
    await page.getByRole('button', { name: 'Live gauges' }).click();
    await page.getByRole('heading', { name: 'Live Town' }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Demo Town' }).waitFor();
    await page.goForward();
    await page.getByRole('heading', { name: 'Live Town' }).waitFor();

    liveMode = 'error';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Could not refresh. The last loaded information may be out of date.', { exact: false }).waitFor();
    assert.ok(await page.getByRole('heading', { name: 'Live Town' }).isVisible());

    liveMode = 'unavailable';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Live FFWC data is not available yet.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'At a glance' }).count(), 0, 'unavailable data is not displayed as zero readings');
    liveMode = 'empty';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('No matched areas are listed near or above their danger levels', { exact: false }).waitFor();
    assert.ok(await page.getByText('This is not an all-clear', { exact: false }).isVisible());
    liveMode = 'stale';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('This reading is older than the freshness window', { exact: false }).waitFor();

    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-desktop.png'), fullPage: true });
    const checkLayouts = async () => {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 1024, height: 768 }, { width: 861, height: 700 }, { width: 768, height: 1024 }, { width: 601, height: 700 }, { width: 375, height: 812 }, { width: 812, height: 375 }, { width: 320, height: 700 }]) {
        await page.setViewportSize(viewport);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${viewport.width}`);
        assert.ok(await page.evaluate(() => document.querySelector('.flood-hero').getBoundingClientRect().top >= document.querySelector('.nav').getBoundingClientRect().bottom), `navigation does not cover the heading at ${viewport.width}`);
        const navIssues = await page.evaluate(() => {
          const items = [...document.querySelectorAll('.nav-inner a, .nav-inner button')].filter(item => item.getClientRects().length);
          return items.flatMap((item, index) => {
            const box = item.getBoundingClientRect();
            const issues = box.left < 0 || box.right > innerWidth ? [`outside viewport: ${item.textContent}`] : [];
            for (const other of items.slice(index + 1)) {
              const next = other.getBoundingClientRect();
              if (box.left < next.right - 1 && box.right > next.left + 1 && box.top < next.bottom - 1 && box.bottom > next.top + 1) issues.push(`overlap: ${item.textContent} / ${other.textContent}`);
            }
            return issues;
          });
        });
        assert.deepEqual(navIssues, [], `navigation controls fit at ${viewport.width}`);
      }
    };
    await checkLayouts();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.getByRole('heading', { name: 'লাইভ এলাকা' }).waitFor();
    assert.ok(await page.getByText('এলাকার কেন্দ্র থেকে ২ কিমি').isVisible());
    await checkLayouts();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'মেনু খুলুন' }).click();
    assert.ok(await page.getByRole('link', { name: 'বন্যা', exact: true }).isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'মেনু খুলুন' }).getAttribute('aria-expanded'), 'false');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    releaseDemo();
    await browser.close();
  }
});
