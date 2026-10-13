import { Subscriber } from '../../models/Subscriber.js';
import { locationByPcode } from '../geo.js';
import { reevaluateSubscriber } from '../alerts/engine.js';
import { CURRENT_AREA_TTL_MS } from '../alerts/subscribers.js';

const PENDING_MS = 5 * 60_000;
const MAX_LIVE_MS = 24 * 60 * 60_000;
const areaAvailable = (now) => ({ $or: [
  { currentArea: null }, { 'currentArea.source': 'telegram' }, { 'currentArea.expiresAt': { $lte: now } },
] });
const areaValue = (pcode, now, reportedAt) => {
  const location = locationByPcode.get(pcode);
  return location ? { upazilaPcode: pcode, districtPcode: location.district,
    expiresAt: new Date(+now + CURRENT_AREA_TTL_MS), source: 'telegram', reportedAt } : null;
};

// /follow is a separate, short consent window. Merely sending a location for /update never arms alerts.
export async function requestTelegramFollow(subscriber, now = new Date()) {
  const result = await Subscriber.updateOne({ _id: subscriber._id, ...areaAvailable(now) }, {
    $set: { 'channels.telegram.followPendingUntil': new Date(+now + PENDING_MS) },
  });
  return result.matchedCount > 0;
}

export async function stopTelegramFollow(subscriber, now = new Date(), messageId = null) {
  const result = await Subscriber.updateOne({ _id: subscriber._id, ...(messageId === null ? {} : { 'channels.telegram.liveMessageId': messageId }) }, { $unset: {
    'channels.telegram.followPendingUntil': '', 'channels.telegram.liveMessageId': '', 'channels.telegram.liveUntil': '', 'channels.telegram.liveReportedAt': '',
  } });
  if (!result.matchedCount) return false;
  const cleared = await Subscriber.updateOne({ _id: subscriber._id, 'currentArea.source': 'telegram', 'channels.telegram.liveMessageId': { $exists: false } }, { $set: { currentArea: null } });
  if (cleared.modifiedCount) await reevaluateSubscriber(subscriber._id, { nowMs: +now });
  return true;
}

// Returns true only when the linked user explicitly requested following and shared a live location.
export async function beginTelegramFollow(subscriber, { pcode, messageId, livePeriod, reportedAt }, now = new Date()) {
  if (!(subscriber.channels?.telegram?.followPendingUntil > now) || !Number.isInteger(messageId)
    || !Number.isFinite(livePeriod) || livePeriod < 60) return false;
  const liveUntil = new Date(Math.min(+reportedAt + livePeriod * 1000, +now + MAX_LIVE_MS));
  const area = areaValue(pcode, now, reportedAt);
  if (!area || liveUntil <= now || +reportedAt < +now - CURRENT_AREA_TTL_MS || +reportedAt > +now + 60_000) return false;
  // Consent, area ownership and the first live fix change together; a concurrent /unfollow cannot leave half a session behind.
  const before = await Subscriber.findOneAndUpdate({ _id: subscriber._id, 'channels.telegram.chatId': subscriber.channels.telegram.chatId,
    'channels.telegram.followPendingUntil': { $gt: now }, ...areaAvailable(now) }, {
    $set: { currentArea: area, 'channels.telegram.liveMessageId': messageId, 'channels.telegram.liveUntil': liveUntil, 'channels.telegram.liveReportedAt': reportedAt },
    $unset: { 'channels.telegram.followPendingUntil': '' },
  }, { returnDocument: 'before' }).lean();
  if (!before) return false;
  const changed = !(before.currentArea?.expiresAt > now) || before.currentArea.upazilaPcode !== pcode;
  if (changed) await reevaluateSubscriber(subscriber._id, { nowMs: +now });
  return true;
}

export async function refreshTelegramFollow(subscriber, { pcode, messageId, reportedAt, stopped = false }, now = new Date()) {
  const tg = subscriber.channels?.telegram;
  if (tg?.liveMessageId !== messageId || !(tg.liveUntil > now)
    || +reportedAt < +now - CURRENT_AREA_TTL_MS || +reportedAt > +now + 60_000) return false;
  if (stopped) return stopTelegramFollow(subscriber, now, messageId);
  const area = areaValue(pcode, now, reportedAt);
  if (!area) return false;
  const before = await Subscriber.findOneAndUpdate({ _id: subscriber._id, 'channels.telegram.chatId': tg.chatId,
    'channels.telegram.liveMessageId': messageId, 'channels.telegram.liveUntil': { $gt: now },
    'channels.telegram.liveReportedAt': { $lte: reportedAt }, ...areaAvailable(now) }, {
    $set: { currentArea: area, 'channels.telegram.liveReportedAt': reportedAt },
  }, { returnDocument: 'before' }).lean();
  if (!before) return false;
  if (!(before.currentArea?.expiresAt > now) || before.currentArea.upazilaPcode !== pcode) await reevaluateSubscriber(subscriber._id, { nowMs: +now });
  return true;
}
