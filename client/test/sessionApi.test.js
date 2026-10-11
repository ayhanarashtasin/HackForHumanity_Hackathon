import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { adminApi } from '../src/services/adminApi.js';
import { alertApi } from '../src/services/alertApi.js';

// The two "who am I?" checks the alert and admin pages make first. The current server answers 200 whatever the state, so a first visit logs
// no failed request. A server that predates them is read the old way, so a newer page keeps working until the API is restarted.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// routes: { '/api/alerts/session': [status, body] }. An unlisted route is a 404, like the API's own "route not found".
function serve(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push(path);
    const [status, body] = routes[path] ?? [404, { message: 'API route not found.' }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const PROFILE = { profile: { occupation: 'farmer', language: 'en' }, unread: 2 };

test('alert session: the current server answers 200 with the profile, or with profile null, and nothing else is asked', async () => {
  const calls = serve({ '/api/alerts/session': [200, { data: PROFILE }] });
  assert.deepEqual(await alertApi.session(), PROFILE);
  assert.deepEqual(calls, ['/api/alerts/session']);

  const none = serve({ '/api/alerts/session': [200, { data: { profile: null, unread: 0 } }] });
  assert.deepEqual(await alertApi.session(), { profile: null, unread: 0 });
  assert.deepEqual(none, ['/api/alerts/session'], 'no second request, no failed request');
});

test('alert session: an older server (401 or 404 on /session) is asked through /me, where 401 means no profile', async () => {
  // 401: the old API's profile check runs before it finds there is no /session route
  let calls = serve({ '/api/alerts/session': [401, { message: 'No alert profile found for this browser.' }], '/api/alerts/me': [200, { data: PROFILE }] });
  assert.deepEqual(await alertApi.session(), PROFILE);
  assert.deepEqual(calls, ['/api/alerts/session', '/api/alerts/me'], 'a profile that exists is found, not mistaken for "none"');

  // 404: it had a profile, so the check passed and there was simply no such route
  calls = serve({ '/api/alerts/me': [200, { data: PROFILE }] });
  assert.deepEqual(await alertApi.session(), PROFILE);

  calls = serve({ '/api/alerts/session': [401, { message: 'x' }], '/api/alerts/me': [401, { message: 'No alert profile found for this browser.' }] });
  assert.deepEqual(await alertApi.session(), { profile: null, unread: 0 });
  assert.equal(calls.length, 2);
});

test('alert session: a real failure is reported, never hidden as "no profile"', async () => {
  serve({ '/api/alerts/session': [500, { message: 'database down' }] });
  await assert.rejects(alertApi.session(), /database down/);

  serve({ '/api/alerts/session': [401, { message: 'x' }], '/api/alerts/me': [500, { message: 'database down' }] });
  await assert.rejects(alertApi.session(), /database down/);

  globalThis.fetch = async () => { throw new TypeError('network'); };
  await assert.rejects(alertApi.session(), /Cannot reach the API/);
});

test('admin session: the current server answers 200 with closed, signed-out or signed-in', async () => {
  for (const state of ['closed', 'signed-out', 'signed-in']) {
    const calls = serve({ '/api/admin/session': [200, { data: { state, devBypass: false } }] });
    assert.deepEqual(await adminApi.session(), { state, devBypass: false });
    assert.deepEqual(calls, ['/api/admin/session']);
  }
  serve({ '/api/admin/session': [200, { data: { state: 'signed-in', devBypass: true } }] });
  assert.equal((await adminApi.session()).devBypass, true);
});

test('admin session: an older server is read through its sign-in check and /admin/me', async () => {
  serve({ '/api/admin/session': [503, { message: 'Admin is not configured.' }] });
  assert.deepEqual(await adminApi.session(), { state: 'closed', devBypass: false });

  serve({ '/api/admin/session': [401, { message: 'Admin sign-in required.' }] });
  assert.deepEqual(await adminApi.session(), { state: 'signed-out', devBypass: false });

  // signed in: the check let /session through to a route that does not exist
  const calls = serve({ '/api/admin/me': [200, { data: { authenticated: true, devBypass: false } }] });
  assert.deepEqual(await adminApi.session(), { state: 'signed-in', devBypass: false });
  assert.deepEqual(calls, ['/api/admin/session', '/api/admin/me']);

  serve({ '/api/admin/me': [200, { data: { authenticated: true, devBypass: true } }] });
  assert.deepEqual(await adminApi.session(), { state: 'signed-in', devBypass: true });

  serve({ '/api/admin/me': [401, { message: 'x' }] });
  assert.deepEqual(await adminApi.session(), { state: 'signed-out', devBypass: false });
  serve({ '/api/admin/me': [503, { message: 'x' }] });
  assert.deepEqual(await adminApi.session(), { state: 'closed', devBypass: false });
});

test('admin session: a real failure is reported, not read as signed out', async () => {
  serve({ '/api/admin/session': [500, { message: 'database down' }] });
  await assert.rejects(adminApi.session(), /database down/);
  serve({ '/api/admin/me': [500, { message: 'database down' }] });
  await assert.rejects(adminApi.session(), /database down/);
});
