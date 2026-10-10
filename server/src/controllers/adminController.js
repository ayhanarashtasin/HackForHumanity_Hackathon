import mongoose from 'mongoose';
import {
  ADMIN_COOKIE, clearAdminCookie, devBypassAllowed, setAdminCookie,
} from '../middleware/admin.js';
import { parseCookies } from '../middleware/cookies.js';
import * as admin from '../services/alerts/admin.js';
import {
  adminConfigured, createAdminSession, endAdminSession, passcodeMatches,
} from '../services/alerts/adminAuth.js';
import { badRequest } from '../services/alerts/errors.js';
import { getSettings } from '../services/alerts/settings.js';

// Admin handlers. Like everything else they read and write MongoDB only; the engine's provider fetches run on their own schedule.
export function availability(req, res) {
  res.json({ data: { configured: adminConfigured() } });
}

export async function login(req, res) {
  if (!adminConfigured()) return res.status(503).json({ message: 'Admin is not configured. Set ADMIN_PASSCODE in server/.env to enable it.' });
  if (!passcodeMatches(req.body?.passcode)) {
    await admin.audit({ at: new Date(), action: 'login', outcome: 'failed' });
    return res.status(401).json({ message: 'That passcode is not correct.' });
  }
  req.loginLimiter?.reset(req.ip);
  const session = await createAdminSession();
  setAdminCookie(res, session.token, session.maxAgeSeconds);
  await admin.audit({ at: new Date(), action: 'login' });
  return res.json({ data: { authenticated: true, expiresAt: session.expiresAt } });
}

export async function logout(req, res) {
  await endAdminSession(parseCookies(req.get('cookie'))[ADMIN_COOKIE]);
  clearAdminCookie(res);
  res.status(204).end();
}

export function me(req, res) {
  res.json({ data: { authenticated: true, devBypass: devBypassAllowed(req) } });
}

export function getOptions(req, res) {
  res.json({ data: admin.options() });
}

export async function getOverview(req, res) {
  res.json({ data: await admin.overview() });
}

export async function previewSend(req, res) {
  res.json({ data: await admin.preview(req.body) });
}

export async function sendAlerts(req, res) {
  const result = await admin.send(req.body);
  res.status(result.replayed ? 200 : 201).json({ data: result });
}

// :id is a send's batch id ("b_...") or a hazard event id.
export async function withdrawAlerts(req, res) {
  const { id } = req.params;
  const target = id.startsWith('b_') ? { batchId: id } : { eventId: id };
  if (target.eventId && !mongoose.isValidObjectId(target.eventId)) throw badRequest('Invalid id.');
  res.json({ data: await admin.withdraw({ ...target, reason: req.body?.reason }) });
}

export async function discardHeld(req, res) {
  res.json({ data: await admin.discardHeld(req.body ?? {}) });
}

export async function getHistory(req, res) {
  res.json({ data: await admin.history({ limit: req.query.limit }) });
}

export async function getRules(req, res) {
  res.json({ data: await admin.rules() });
}

export async function getAdminSettings(req, res) {
  res.json({ data: await getSettings({ force: true }) });
}

export async function putAdminSettings(req, res) {
  res.json({ data: await admin.changeSettings(req.body ?? {}) });
}

export async function demoList(req, res) {
  res.json({ data: await admin.listDemoSubscribers() });
}

export async function demoCreate(req, res) {
  res.status(201).json({ data: await admin.createDemoSubscribers(req.body?.areaPcode) });
}

export async function demoDelete(req, res) {
  res.json({ data: await admin.deleteDemoSubscribers() });
}

export async function demoInbox(req, res) {
  res.json({ data: await admin.viewAs(req.params.id, req.query.view === 'earlier' ? 'earlier' : 'active') });
}
