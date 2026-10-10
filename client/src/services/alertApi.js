import { request } from './api.js';

// The subscriber's side of the API. Every call reads or writes MongoDB only; none of them can trigger a weather-provider request.
// Calls throw an Error with `.status` (401 = no alert profile in this browser) and, for a rejected form, `.details` (field path -> code).
const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const alertApi = {
  schema: (signal) => request('/alerts/schema', { signal }),
  status: (signal) => request('/alerts/status', { signal }),
  me: (signal) => request('/alerts/me', { signal }),
  subscribe: (payload) => request('/alerts/subscribe', { method: 'POST', ...json(payload) }),
  updateProfile: (payload) => request('/alerts/me', { method: 'PUT', ...json(payload) }),
  deleteProfile: () => request('/alerts/me', { method: 'DELETE' }),
  setActivity: (body) => request('/alerts/me/activity', { method: 'PUT', ...json(body) }),
  setStatus: (status) => request('/alerts/me/status', { method: 'PUT', ...json({ status }) }),
  coverage: (signal) => request('/alerts/me/coverage', { signal }),
  inbox: ({ view = 'active', before = null, limit = 30 } = {}, signal) => {
    const query = new URLSearchParams({ view, limit: String(limit) });
    if (before) query.set('before', before);
    return request(`/alerts/inbox?${query}`, { signal });
  },
  markRead: (id) => request(`/alerts/inbox/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  markAllRead: () => request('/alerts/inbox/read-all', { method: 'POST' }),

  // Telegram, WhatsApp and SMS: connecting is a message to the person's own channel, started by their own click.
  channels: (signal) => request('/alerts/me/channels', { signal }),
  linkTelegram: () => request('/alerts/me/channels/telegram/link', { method: 'POST' }),
  startChannel: (channel, body) => request(`/alerts/me/channels/${channel}/start`, { method: 'POST', ...json(body) }),
  verifyChannel: (channel, code) => request(`/alerts/me/channels/${channel}/verify`, { method: 'POST', ...json({ code }) }),
  removeChannel: (channel) => request(`/alerts/me/channels/${channel}`, { method: 'DELETE' }),
};
