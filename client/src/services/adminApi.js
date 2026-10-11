import { request } from './api.js';

// The administrator API (the client's model layer for /admin). Every call uses the shared request(): errors carry `.status` and `.details`.
// A 401 after sign-in means the session ended; callers route it back to the sign-in screen (see admin/AdminContext.jsx).
const send = (method, body, signal) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
  signal,
});

// "Am I signed in?" -> { state: 'closed' | 'signed-out' | 'signed-in', devBypass }. The current API answers 200 in every case, so opening /admin
// without a session logs no failed request. An API that predates /admin/session answers through its sign-in check instead (503 = no passcode
// set, 401 = signed out, 404 = signed in, because the check let the request through to a route that is not there), so those are read the
// old way, from /admin/me. That keeps a newer page working while the server is still the old one.
async function session(signal) {
  try {
    return await request('/admin/session', { signal });
  } catch (error) {
    if (error.status === 503) return { state: 'closed', devBypass: false };
    if (error.status === 401) return { state: 'signed-out', devBypass: false };
    if (error.status !== 404) throw error;
    return request('/admin/me', { signal })
      .then((data) => ({ state: 'signed-in', devBypass: Boolean(data?.devBypass) }))
      .catch((failure) => {
        if (failure.status === 503) return { state: 'closed', devBypass: false };
        if (failure.status === 401) return { state: 'signed-out', devBypass: false };
        throw failure;
      });
  }
}

export const adminApi = {
  availability: (signal) => request('/admin/availability', { signal }),
  // The admin page checks this first (see session above).
  session,
  me: (signal) => request('/admin/me', { signal }),
  login: (passcode) => request('/admin/login', send('POST', { passcode })),
  logout: () => request('/admin/logout', { method: 'POST' }),

  options: (signal) => request('/admin/options', { signal }),
  overview: (signal) => request('/admin/overview', { signal }),

  preview: (body, signal) => request('/admin/preview', send('POST', body, signal)),
  send: (body) => request('/admin/send', send('POST', body)),
  withdraw: (id, reason) => request(`/admin/alerts/${encodeURIComponent(id)}/withdraw`, send('POST', { reason })),
  discardHeld: (body) => request('/admin/held/discard', send('POST', body)),

  history: (signal) => request('/admin/history', { signal }),
  rules: (signal) => request('/admin/rules', { signal }),

  settings: (signal) => request('/admin/settings', { signal }),
  saveSettings: (patch) => request('/admin/settings', send('PUT', patch)),

  demoList: (signal) => request('/admin/demo/subscribers', { signal }),
  demoCreate: (areaPcode) => request('/admin/demo/subscribers', send('POST', { areaPcode })),
  demoDelete: () => request('/admin/demo/subscribers', { method: 'DELETE' }),
  demoInbox: (id, view = 'active', signal) => request(`/admin/demo/subscribers/${encodeURIComponent(id)}/inbox?view=${view}`, { signal }),
};
