import assert from 'node:assert/strict';
import { test } from 'node:test';

test('shared navigation fits without overlapping and keeps every destination accessible', {
  skip: !process.env.UI_BASE_URL || !process.env.PLAYWRIGHT_MODULE,
}, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('akashsathi.alert.language', 'en');
      localStorage.setItem('akashsathi.alert', JSON.stringify({ armed: true }));
    });
    await page.route('**/api/alerts/inbox?*', route => route.fulfill({ json: { data: { unread: 14, items: [] } } }));
    await page.route('**/api/flood/status', route => route.fulfill({ json: { data: { demo: false, status: 'UNAVAILABLE', groups: [] } } }));
    await page.goto(`${process.env.UI_BASE_URL}/`);
    await page.locator('.nav-badge').waitFor();
    assert.equal(await page.locator('.nav-badge').textContent(), '9+');
    await page.evaluate(() => document.fonts.ready);

    const checkLayout = async (viewport) => {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const menuVisible = getComputedStyle(document.querySelector('.nav-toggle')).display !== 'none';
        const logoHidden = getComputedStyle(document.querySelector('.nav-logo-text')).display === 'none';
        const navHeight = getComputedStyle(document.querySelector('.nav')).getPropertyValue('--nav-h').trim();
        const padding = getComputedStyle(document.querySelector('.nav-inner')).paddingLeft;
        return menuVisible === matchMedia('(max-width: 1200px)').matches
          && logoHidden === matchMedia('(max-width: 600px)').matches
          && navHeight === (matchMedia('(max-width: 860px)').matches ? '64px' : '72px')
          && padding === (matchMedia('(max-width: 600px)').matches ? '10px' : matchMedia('(max-width: 1200px)').matches ? '16px' : '20px');
      });
      const issues = await page.evaluate(() => {
        const nav = document.querySelector('.nav').getBoundingClientRect();
        const items = [...document.querySelectorAll('.nav-inner a, .nav-inner button')].filter(item => item.getClientRects().length);
        return items.flatMap((item, index) => {
          const box = item.getBoundingClientRect();
          const issues = box.left < nav.left - 1 || box.right > nav.right + 1 ? [`outside navbar: ${item.textContent.trim()}`] : [];
          for (const other of items.slice(index + 1)) {
            const next = other.getBoundingClientRect();
            if (box.left < next.right - 1 && box.right > next.left + 1 && box.top < next.bottom - 1 && box.bottom > next.top + 1) issues.push(`overlap: ${item.textContent.trim()} / ${other.textContent.trim()}`);
          }
          return issues;
        });
      });
      assert.deepEqual(issues, [], `navigation fits at ${viewport.width}px`);
    };
    const widths = [320, 360, 375, 600, 601, 860, 861, 1024, 1200, 1201, 1263, 1440, 1920];
    for (const width of widths) await checkLayout({ width, height: 800 });
    if (process.env.UI_SCREENSHOT) {
      await page.setViewportSize({ width: 1263, height: 800 });
      await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: false });
    }
    await page.getByRole('button', { name: 'বাংলা' }).click();
    await page.waitForFunction(() => document.documentElement.lang === 'bn');
    await page.evaluate(() => document.fonts.ready);
    for (const width of widths) await checkLayout({ width, height: 800 });

    await page.setViewportSize({ width: 375, height: 812 });
    const toggle = page.locator('.nav-toggle');
    assert.ok(await page.getByRole('link', { name: 'সতর্কবার্তা, ১৪টি পড়া হয়নি' }).isVisible());
    assert.equal(await page.locator('.nav-badge').textContent(), '৯+');
    if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT.replace(/\.png$/, '-mobile.png'), fullPage: false });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    for (const label of ['সুবিধাসমূহ', 'কাদের জন্য', 'সতর্কবার্তা', 'বন্যা', 'মানচিত্র', 'পথ']) {
      assert.ok(await page.locator('.nav-menu').getByRole('link', { name: label, exact: label !== 'সতর্কবার্তা' }).isVisible());
    }
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(await toggle.evaluate(element => element === document.activeElement));

    await page.setViewportSize({ width: 812, height: 375 });
    await toggle.click();
    const routesLink = page.locator('.nav-menu').getByRole('link', { name: 'পথ', exact: true });
    await routesLink.scrollIntoViewIfNeeded();
    assert.ok(await routesLink.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight));
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1024, height: 768 });
    await toggle.click();
    await page.setViewportSize({ width: 1263, height: 800 });
    await page.locator('.nav-menu').waitFor({ state: 'detached' });
    for (const path of ['/flood', '/route', '/alert']) {
      await page.goto(`${process.env.UI_BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.nav').waitFor();
      await page.evaluate(() => document.fonts.ready);
      for (const width of [375, 861, 1201, 1263]) await checkLayout({ width, height: 800 });
    }
  } finally {
    await browser.close();
  }
});
