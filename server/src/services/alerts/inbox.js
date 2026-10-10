import mongoose from 'mongoose';
import { SEVERITY_RANK, VISIBLE_STATUSES } from '../../config/alertConstants.js';
import { Notification } from '../../models/Notification.js';
import { badRequest } from './errors.js';

// The in-app inbox. Reads MongoDB only: it can never trigger a provider request. Held (draft) notifications are never visible here.
const MAX_ACTIVE = 100;
const MAX_PAGE = 50;

// Expiry is applied here as well as by the engine: a notification whose validity has ended is "earlier" the moment it ends.
export function effectiveStatus(doc, now) {
  return doc.status === 'active' && doc.validUntil <= now ? 'expired' : doc.status;
}

export function toItem(doc, now = new Date()) {
  return {
    id: String(doc._id),
    scenarioId: doc.scenarioId,
    ruleVersion: doc.ruleVersion,
    ruleStatus: doc.ruleStatus,
    severity: doc.severity,
    title: doc.title,
    message: doc.message,
    recommendedActions: doc.recommendedActions,
    lang: doc.lang,
    affectedArea: doc.affectedArea,
    sourceReferences: doc.sourceReferences,
    reasonForSelection: doc.reasonForSelection,
    hazardType: doc.hazardType,
    hazardLevel: doc.hazardLevel,
    validFrom: doc.validFrom,
    validUntil: doc.validUntil,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    readAt: doc.readAt,
    renotifications: doc.renotifications ?? 0,
    status: effectiveStatus(doc, now),
    origin: doc.origin,
    sender: doc.origin !== 'automatic' ? 'administrator' : (doc.evidence?.official ? 'official' : 'automatic'),
    dataStatus: doc.dataStatus,
    evidence: doc.evidence,
    relatedRules: doc.evidence?.relatedRules ?? [],
    lifecycle: (doc.lifecycle ?? []).slice(-6),
    withdrawalReason: doc.withdrawalReason,
    isDemo: doc.isDemo,
  };
}

export async function unreadCount(subscriberId, now = new Date()) {
  return Notification.countDocuments({ subscriberId, status: 'active', validUntil: { $gt: now }, readAt: null });
}

// view = 'active' (current alerts, most severe first) | 'earlier' (expired or withdrawn, newest first, paged with `before`)
export async function listInbox(subscriberId, { view = 'active', before = null, limit = 30, now = new Date() } = {}) {
  if (view === 'active') {
    const rows = await Notification.find({ subscriberId, status: 'active', validUntil: { $gt: now } }).sort({ updatedAt: -1 }).limit(MAX_ACTIVE).lean();
    rows.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (+b.updatedAt - +a.updatedAt));
    return { items: rows.map((row) => toItem(row, now)), unread: await unreadCount(subscriberId, now), hasMore: false };
  }

  if (view !== 'earlier') throw badRequest('view must be active or earlier.');
  const size = Math.min(Math.max(Number(limit) || 30, 1), MAX_PAGE);
  const query = {
    subscriberId,
    $or: [{ status: { $in: ['expired', 'withdrawn'] } }, { status: 'active', validUntil: { $lte: now } }],
  };
  if (before) {
    const at = new Date(before);
    if (Number.isNaN(at.getTime())) throw badRequest('before must be a date.');
    query.createdAt = { $lt: at };
  }
  const rows = await Notification.find(query).sort({ createdAt: -1 }).limit(size + 1).lean();
  return {
    items: rows.slice(0, size).map((row) => toItem(row, now)),
    unread: await unreadCount(subscriberId, now),
    hasMore: rows.length > size,
  };
}

export async function markRead(subscriberId, id, now = new Date()) {
  if (!mongoose.isValidObjectId(id)) throw badRequest('Invalid alert id.');
  const result = await Notification.updateOne(
    { _id: id, subscriberId, status: { $in: VISIBLE_STATUSES }, readAt: null },
    { $set: { readAt: now } },
  );
  return { updated: result.modifiedCount, unread: await unreadCount(subscriberId, now) };
}

export async function markAllRead(subscriberId, now = new Date()) {
  const result = await Notification.updateMany(
    { subscriberId, status: { $in: VISIBLE_STATUSES }, readAt: null },
    { $set: { readAt: now } },
  );
  return { updated: result.modifiedCount, unread: 0 };
}
