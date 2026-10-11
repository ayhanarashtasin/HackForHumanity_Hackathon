import { request } from './api.js';

// The subscriber's side of the API. Every call reads or writes MongoDB only; none of them can trigger a weather-provider request.
// Calls throw an Error with `.status` (401 = no alert profile in this browser) and, for a rejected form, `.details` (field path -> code).
const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// "Who am I?" -> { profile, unread }, with profile null when this browser has none. The current API answers 200 either way, so a first visit
// logs no failed request. An API that predates /alerts/session (it answers 401 or 404 there) is asked the old way: /alerts/me, where 401 means
// "no profile". That keeps a newer page working while the server is still the old one, for example between two restarts.
async function session(signal) {
  try {
    return await request('/alerts/session', { signal });
  } catch (error) {
    if (error.status !== 401 && error.status !== 404) throw error;
    return request('/alerts/me', { signal }).catch((failure) => {
      if (failure.status === 401) return { profile: null, unread: 0 };
      throw failure;
    });
  }
}

export const alertApi = {
  schema: (signal) => request('/alerts/schema', { signal }),
  status: (signal) => request('/alerts/status', { signal }),
  // The alert page checks this first (see session above).
  session,
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
