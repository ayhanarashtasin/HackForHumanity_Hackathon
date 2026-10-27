import assert from 'node:assert/strict';
import { test } from 'node:test';

// Optional browser check, using an existing Playwright install and running dev server:
// UI_BASE_URL=http://localhost:5173 PLAYWRIGHT_MODULE=<Playwright index.mjs file URL> node --test client/test/stormPanel.test.js
test('storm layers offer live tracking and historical simulation, with playback and clear live-data states', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1506, height: 724 }, reducedMotion: 'reduce' });
  const snapshot = { observedAt: new Date(Date.now() - 20 * 60_000).toISOString(), cells: [], arrivals: [] };
  let live = { enabled: true, live: snapshot };
  let status = 200;
  let release;
  let pending = new Promise(resolve => { release = resolve; });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
      sessionStorage.removeItem('akashsathi:location-dismissed');
    });
    await page.route('**/api/storms', async route => {
      await pending;
      await route.fulfill({ status, json: status === 200 ? { data: live } : { message: 'Unavailable' } });
    });
    await page.route('**/api/storms/demo', route => route.fulfill({ json: { data: { snapshots: [0, 10].map(minute => ({
      ...snapshot, observedAt: `2026-09-22T08:${String(minute).padStart(2, '0')}:00Z`, cells: [{ id: 'c1', intensity: 4, areaKm2: 300 }],
    })) } } }));
    const open = async () => {
      if (page.url() === 'about:blank') await page.goto(`${process.env.UI_BASE_URL}/map#o=storms`);
      else await page.reload();
      await page.locator('.location-notice-actions button:last-child').click();
    };
    await open();
    await page.getByText('Loading storm tracking…', { exact: true }).waitFor();
    assert.equal(await page.locator('.storm-empty').count(), 0, 'loading must not be reported as no storms');
    release();
    pending = null;
    await page.locator('.storm-empty').waitFor();
    assert.match(await page.locator('.storm-empty').textContent(), /Rain or lightning may still occur/);
    assert.equal(await page.locator('.storm-legend').count(), 0, 'zero warnings must not push the empty state out of view');
    const empty = await page.locator('.storm-empty').boundingBox();
    const timestamp = await page.locator('.storm-time').boundingBox();
    assert.ok(empty.y < timestamp.y, 'explain the missing map tracks before showing metadata');

    for (const [width, height] of [[1506, 724], [375, 812], [667, 375]]) {
      await page.setViewportSize({ width, height });
      if (width <= 760) await page.getByRole('button', { name: 'Explore map', exact: true }).click();
      await page.getByRole('button', { name: 'Map layers', exact: true }).click();
      const menu = page.locator('#map-layer-options');
      const storms = menu.getByRole('checkbox', { name: 'Storm movement', exact: true });
      assert.equal(await storms.count(), 1, 'the layer label must not include Experimental');
      await storms.uncheck();
      assert.equal(await menu.getByRole('group', { name: 'Storm data', exact: true }).count(), 0);
      await storms.check();
      const choices = menu.getByRole('group', { name: 'Storm data', exact: true });
      assert.equal(await choices.count(), 1, 'enabling the layer reveals Live and Historical simulation immediately');
      if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, `-${width}-menu.png`) });
      await choices.getByRole('button', { name: 'Historical simulation', exact: true }).click();
      const panel = page.locator('#storm-movement-panel');
      await panel.getByText('Historical storm movement for simulation only — not live weather or a current warning.', { exact: true }).waitFor();
      assert.equal(await panel.getByRole('radio', { name: 'Historical simulation', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await panel.evaluate(element => element === document.activeElement), true, 'choosing a mode opens and focuses its details');
      assert.doesNotMatch(await panel.locator('.storm-header').textContent(), /Experimental/);
      await panel.getByRole('button', { name: 'Next frame', exact: true }).click();
      assert.equal(await panel.locator('.storm-player > span').textContent(), '2/2');
      if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, `-${width}.png`) });
      await panel.getByRole('button', { name: 'Play', exact: true }).click();
      await panel.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Map layers', exact: true }).click();
      await menu.getByRole('group', { name: 'Storm data', exact: true }).getByRole('button', { name: 'Live', exact: true }).focus();
      await page.keyboard.press('Enter');
      await panel.locator('.storm-empty').waitFor();
      assert.equal(await panel.getByRole('radio', { name: 'Live', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await panel.locator('.storm-player').count(), 0, 'Live must not retain the historical player');
    }
    await page.setViewportSize({ width: 1506, height: 724 });

    await page.getByRole('button', { name: 'Show saved storm replay', exact: true }).click();
    await page.getByRole('heading', { name: '1 storm cells', exact: true }).waitFor();
    await page.locator('.storm-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator('.storm-mode button').first().click();
    await page.locator('.storm-empty').waitFor();
    assert.equal(await page.locator('.storm-content').evaluate(el => el.scrollTop), 0, 'switching to Live reveals its status immediately');
    await page.locator('.language-toggle button').first().click();
    assert.match(await page.locator('.storm-empty').textContent(), /শনাক্ত হয়নি/);
    await page.getByRole('button', { name: 'মানচিত্রের তথ্যস্তর', exact: true }).click();
    await page.getByRole('group', { name: 'ঝড়ের তথ্য', exact: true }).getByRole('button', { name: 'আগের ঝড়ের সিমুলেশন', exact: true }).click();
    await page.getByText('আগের ঝড়ের গতিপথ শুধু সিমুলেশনের জন্য — বর্তমান আবহাওয়া বা চলমান সতর্কবার্তা নয়।', { exact: true }).waitFor();

    for (const [payload, httpStatus, message] of [
      [{ enabled: false, live: null }, 200, 'Storm tracking is off: the ML service is not running.'],
      [{ enabled: true, live: null }, 200, 'Waiting for the first satellite analysis…'],
      [{ enabled: true, live: null, error: 'Analysis failed' }, 200, 'The satellite analysis failed; trying again in a few minutes.'],
      [null, 503, 'Storm tracking could not be loaded.'],
    ]) {
      live = payload;
      status = httpStatus;
      await open();
      await page.getByText(message, { exact: true }).waitFor();
      assert.equal(await page.locator('.storm-empty').count(), 0, 'unavailable data must not be reported as no storms');
    }
  } finally {
    release();
    await browser.close();
  }
});
