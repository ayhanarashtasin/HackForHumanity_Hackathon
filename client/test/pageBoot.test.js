import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createPageLoader } from '../src/pages/pageLoader.js';
import { legacyMapUrl, resolveRoute } from '../src/lib/router.js';

// What a visitor sees before React has started: index.html decides the page (and so the background) on its own, so the first frame is
// never the wrong colour. These tests keep that copy of the routing in step with src/lib/router.js and keep the first-paint rules in place.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
const inlineStyle = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];

function bootResult(pathname, hash = '') {
  const attributes = {};
  const meta = { content: null, setAttribute: (name, value) => { if (name === 'content') meta.content = value; } };
  vm.runInNewContext(inlineScript, {
    location: { pathname, hash },
    document: {
      documentElement: { setAttribute: (name, value) => { attributes[name] = value; } },
      querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? meta : null),
    },
  });
  return { page: attributes['data-page'], themeColor: meta.content };
}
const pageFromBoot = (pathname, hash = '') => bootResult(pathname, hash).page;

// The same answer the app gives once it has started (App.jsx writes data-page the same way).
const pageFromApp = (pathname, hash = '') => {
  const route = legacyMapUrl(pathname, hash) ? 'map' : resolveRoute(pathname);
  return route === 'home' ? 'landing' : route;
};

test('index.html picks the same page as the app for every path and for old shared map links', () => {
  assert.ok(inlineScript, 'the inline script exists');
  const paths = ['/', '', '/map', '/map/', '/alert', '/alert/', '/admin', '/admin/', '/admin/login', '/admin/login/', '/administrator', '/maps', '/nope', '/map/extra', '//'];
  const hashes = ['', '#features', '#top', '#view=23.7,90.4,8z', '#layer=rain', '#o=radar', '#a=1&view=1', '#xview=1', '#view', '#vie=2'];
  for (const path of paths) {
    for (const hash of hashes) assert.equal(pageFromBoot(path, hash), pageFromApp(path, hash), `${path}${hash}`);
  }
});

test('the browser bar colour follows the page: olive over the map, Soft White everywhere else', () => {
  assert.match(html, /<meta name="theme-color" content="#2E3D28"/, 'olive until the early script says otherwise');
  for (const [path, hash, expected] of [['/', '', '#E8E9DF'], ['/alert', '', '#E8E9DF'], ['/admin/login', '', '#E8E9DF'], ['/map', '', '#2E3D28'], ['/', '#view=1,2,7z', '#2E3D28'], ['/nope', '', '#E8E9DF']]) {
    assert.equal(bootResult(path, hash).themeColor, expected, `${path}${hash}`);
  }
});

test('the first frame is painted in the right colours before any stylesheet or script has loaded', () => {
  assert.ok(inlineStyle, 'the critical style exists');
  // Deep Olive only for the map; Soft White for every page that scrolls
  assert.match(inlineStyle, /html\s*\{\s*background:\s*#2E3D28/i);
  assert.match(inlineStyle, /html\[data-page='landing'\],\s*html\[data-page='alert'\],\s*html\[data-page='admin'\]\s*\{\s*background:\s*#E8E9DF/i);
  // the script that sets data-page runs before the stylesheet and the app
  assert.ok(html.indexOf('<script>') < html.indexOf('<style>'), 'data-page is set before the first style is read');
  assert.ok(html.indexOf('<script>') < html.indexOf('type="module"'));
});

test('a quiet placeholder sits in #root and stays invisible for the first 0.4 s, so a fast load never flashes it', () => {
  assert.match(html, /<div id="root"><div class="boot" role="status">/);
  assert.match(inlineStyle, /\.boot\s*\{[^}]*opacity:\s*0[^}]*animation:\s*boot-in[^}]*0\.4s/);
  assert.match(inlineStyle, /\.boot\s*\{[^}]*position:\s*fixed/, 'taking no part in the layout');
});

test('the page loader loads a screen once, remembers it, retries after a failure and ignores screens it does not know', async () => {
  let calls = 0;
  let fail = true;
  const Component = () => null;
  const loader = createPageLoader({
    map: async () => {
      calls += 1;
      if (fail) throw new Error('chunk failed');
      return { default: Component };
    },
    alert: async () => ({ default: () => 'alert' }),
  });

  assert.equal(loader.loadedPage('map'), null);
  assert.equal(loader.isLazyPage('map'), true);
  assert.equal(loader.isLazyPage('home'), false);
  assert.equal(loader.isLazyPage('constructor'), false, 'inherited names are not screens');
  assert.equal(await loader.preloadPage('home'), null);

  await assert.rejects(loader.preloadPage('map'), /chunk failed/);
  assert.equal(loader.loadedPage('map'), null, 'a failure is not remembered as loaded');

  fail = false;
  const [first, second] = await Promise.all([loader.preloadPage('map'), loader.preloadPage('map')]);
  assert.equal(first, Component);
  assert.equal(second, Component);
  assert.equal(calls, 2, 'one failed try and one shared successful try, not three');
  assert.equal(loader.loadedPage('map'), Component);
  assert.equal(await loader.preloadPage('map'), Component);
  assert.equal(calls, 2, 'a loaded screen is never fetched again');
});

test('warming a screen on hover never throws, even when its chunk cannot be fetched', async () => {
  const loader = createPageLoader({ map: async () => { throw new Error('offline'); } });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  loader.prefetchPage('map')();
  loader.prefetchPage('nothing')();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});
