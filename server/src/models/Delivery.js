import mongoose from 'mongoose';
import { DELIVERY_CHANNELS, DELIVERY_STATUSES } from '../config/alertConstants.js';

// One external message for one notification on one channel. The unique key (notification, channel, stage) is the idempotency guarantee:
// however often the delivery cycle runs, a given alert stage reaches a given channel at most once. A stage is the severity plus the
// number of re-notifications, so an escalation (or an allowed lightning re-notification) is a new stage and is sent again.
// Only references and outcomes are kept here: the message text is rebuilt from the stored notification, never copied.
const deliverySchema = new mongoose.Schema(
  {
    notificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', required: true },
    subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscriber', required: true },
    channel: { type: String, enum: DELIVERY_CHANNELS, required: true },
    stageKey: { type: String, required: true },
    severity: { type: String, required: true },
    // 3 = CRITICAL ... so the queue sends the most urgent first.
    rank: { type: Number, default: 1 },
    status: { type: String, enum: DELIVERY_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    leaseUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: null },
    // retry | permanent | blocked | auth | config: why it did not go out (never a credential, never a message body).
    errorClass: { type: String, default: null },
    lastError: { type: String, default: null },
    // Why a row was not sent on purpose: no_longer_active, superseded, subscriber_paused, channel_unlinked, daily_cap, expired_in_quiet_hours...
    skippedReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    purgeAfter: { type: Date, required: true },
  },
  { versionKey: false, minimize: false },
);

deliverySchema.index({ notificationId: 1, channel: 1, stageKey: 1 }, { unique: true });
deliverySchema.index({ status: 1, nextAttemptAt: 1, rank: -1 });
deliverySchema.index({ subscriberId: 1, channel: 1, sentAt: -1 });
deliverySchema.index({ createdAt: -1 });
deliverySchema.index({ purgeAfter: 1 }, { expireAfterSeconds: 0 });

export const Delivery = mongoose.model('Delivery', deliverySchema);
