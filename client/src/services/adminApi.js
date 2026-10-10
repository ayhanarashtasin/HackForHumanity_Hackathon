import { request } from './api.js';

// The administrator API (the client's model layer for /admin). Every call uses the shared request(): errors carry `.status` and `.details`.
// A 401 after sign-in means the session ended; callers route it back to the sign-in screen (see admin/AdminContext.jsx).
const send = (method, body, signal) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
  signal,
});

export const adminApi = {
  availability: (signal) => request('/admin/availability', { signal }),
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
