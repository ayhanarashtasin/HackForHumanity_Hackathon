import { clearSubscriberCookie, loadSubscriber, setSubscriberCookie } from '../middleware/subscriber.js';
import { evaluateSubscriberNow, reevaluateSubscriber } from '../services/alerts/engine.js';
import {
  listInbox, markAllRead, markRead, unreadCount,
} from '../services/alerts/inbox.js';
import { publicSchema } from '../services/alerts/schema.js';
import { coverageFor, publicStatus } from '../services/alerts/status.js';
import {
  createSubscriber, deleteSubscriber, profileView, setActivity, setCurrentArea, setStatus, updateProfile,
} from '../services/alerts/subscribers.js';

// Subscriber-facing handlers. Every one reads MongoDB or memory only; none of them can trigger a provider request.
export function getSchema(req, res) {
  res.json({ data: publicSchema() });
}

export async function getStatus(req, res) {
  res.json({ data: await publicStatus() });
}

// Completing the form is the whole sign-up: there is no account, only a device cookie. The new profile is evaluated at once against
// the alerts that are active now (database only), so someone who subscribes during a storm sees today's alert immediately.
export async function subscribe(req, res) {
  const { subscriber, token } = await createSubscriber(req.body);
  setSubscriberCookie(res, token);
  const backfilled = await evaluateSubscriberNow(subscriber._id);
  res.status(201).json({
    data: { profile: profileView(subscriber), unread: await unreadCount(subscriber._id), backfilled },
  });
}

// "Who am I?" for the alert page: never an error. A browser with no profile (or a stale cookie) gets `profile: null` instead of a 401, so a
// first visit does not log a failed request in the console. Every endpoint that needs a profile still answers 401 without one.
export async function getSession(req, res) {
  res.set('Cache-Control', 'no-store');
  const subscriber = await loadSubscriber(req, res);
  if (!subscriber) return res.json({ data: { profile: null, unread: 0 } });
  return res.json({ data: { profile: profileView(subscriber), unread: await unreadCount(subscriber._id) } });
}

export async function getMe(req, res) {
  res.json({ data: { profile: profileView(req.subscriber), unread: await unreadCount(req.subscriber._id) } });
}

export async function updateMe(req, res) {
  const updated = await updateProfile(req.subscriber, req.body);
  const changes = await reevaluateSubscriber(updated._id);
  res.json({ data: { profile: profileView(updated), unread: await unreadCount(updated._id), changes } });
}

export async function deleteMe(req, res) {
  await deleteSubscriber(req.subscriber);
  clearSubscriberCookie(res);
  res.status(204).end();
}

export async function updateActivity(req, res) {
  const updated = await setActivity(req.subscriber, req.body);
  await evaluateSubscriberNow(updated._id);
  res.json({ data: { profile: profileView(updated) } });
}

export async function updateStatus(req, res) {
  const updated = await setStatus(req.subscriber, req.body?.status);
  res.json({ data: { profile: profileView(updated) } });
}

export async function updateCurrentArea(req, res) {
  const body = req.body;
  if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== 'upazilaPcode') || !Object.hasOwn(body, 'upazilaPcode')) {
    return res.status(400).json({ message: 'Send an area code, or null to stop following.' });
  }
  const previous = req.subscriber.currentArea?.expiresAt > new Date() ? req.subscriber.currentArea.upazilaPcode : null;
  const updated = await setCurrentArea(req.subscriber, body.upazilaPcode);
  if (previous !== body.upazilaPcode) await reevaluateSubscriber(updated._id);
  res.json({ data: { profile: profileView(updated) } });
}

export async function getInbox(req, res) {
  const { view = 'active', before = null, limit } = req.query;
  res.json({ data: await listInbox(req.subscriber._id, { view, before, limit }) });
}

export async function readOne(req, res) {
  res.json({ data: await markRead(req.subscriber._id, req.params.id) });
}

export async function readAll(req, res) {
  res.json({ data: await markAllRead(req.subscriber._id) });
}

export async function getCoverage(req, res) {
  res.json({ data: { rows: await coverageFor(req.subscriber) } });
}
