import mongoose from 'mongoose';
import {
  DATA_STATUSES, NOTIFICATION_ORIGINS, NOTIFICATION_STATUSES, RULE_STATUSES, SEVERITIES,
} from '../config/alertConstants.js';

// One personal alert: one subscriber, one hazard event, one catalogue rule (scenario). The unique index below is the de-duplication key.
const actionSchema = new mongoose.Schema({ key: { type: String, required: true }, text: { type: String, required: true } }, { _id: false });

const sourceSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    product: { type: String, default: null },
    observedAt: { type: Date, default: null },
    forecastIssuedAt: { type: Date, default: null },
    url: { type: String, default: null },
  },
  { _id: false },
);

const lifecycleSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    // created | updated | escalated | published | expired | withdrawn
    type: { type: String, required: true },
    note: { type: String, default: null },
  },
  { _id: false },
);

const notificationSchema = new mongoose.Schema(
  {
    subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscriber', required: true },
    hazardEventId: { type: mongoose.Schema.Types.ObjectId, ref: 'HazardEvent', required: true },
    // The subscriber's occupation at the time (a denormalised copy: reporting groups by role without a join).
    occupation: { type: String, default: null },
    // A catalogue rule ID (FARM-01...) or ADMIN-MSG.
    scenarioId: { type: String, required: true },
    ruleVersion: { type: String, required: true },
    ruleStatus: { type: String, enum: RULE_STATUSES, required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    recommendedActions: { type: [actionSchema], default: [] },
    lang: { type: String, enum: ['bn', 'en'], default: 'en' },
    // The same alert read in the other language, so the inbox page's language toggle shows an already-stored alert correctly instead
    // of only new ones: { en: {title, message, recommendedActions, reasonForSelection, affectedArea}, bn: {...} }. Everything else
    // (severity, hazard, evidence, times...) does not vary by language, so it is not duplicated here.
    translations: { type: mongoose.Schema.Types.Mixed, default: undefined },
    templateKey: { type: String, default: null },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    affectedArea: {
      scope: { type: String, required: true },
      upazilaPcode: { type: String, default: null },
      districtPcode: { type: String, default: null },
      name: { type: String, default: null },
      nameBn: { type: String, default: null },
      text: { type: String, required: true },
    },
    sourceReferences: { type: [sourceSchema], default: [] },
    reasonForSelection: { type: String, required: true },
    // Compact evidence shown in the card details (metrics, agreement, coverage, hazard level).
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    hazardType: { type: String, required: true },
    hazardLevel: { type: Number, default: 0 },
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    readAt: { type: Date, default: null },
    isDemo: { type: Boolean, default: false },
    origin: { type: String, enum: NOTIFICATION_ORIGINS, default: 'automatic' },
    // draft / discarded / expired_unsent exist only while an administrator "hold" is on.
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'active' },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, enum: ['engine', 'admin', null], default: null },
    batchId: { type: String, default: null },
    dataStatus: { type: String, enum: DATA_STATUSES, default: 'FRESH' },
    revision: { type: Number, default: 1 },
    renotifications: { type: Number, default: 0 },
    lifecycle: { type: [lifecycleSchema], default: [] },
    withdrawalReason: { type: String, default: null },
    purgeAfter: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

notificationSchema.index({ subscriberId: 1, hazardEventId: 1, scenarioId: 1 }, { unique: true });
notificationSchema.index({ subscriberId: 1, status: 1, createdAt: -1 });
notificationSchema.index({ subscriberId: 1, status: 1, readAt: 1 });
notificationSchema.index({ hazardEventId: 1, status: 1 });
notificationSchema.index({ status: 1, batchId: 1 });
notificationSchema.index({ status: 1, scenarioId: 1, 'affectedArea.upazilaPcode': 1 });
notificationSchema.index({ purgeAfter: 1 }, { expireAfterSeconds: 0 });

export const Notification = mongoose.model('Notification', notificationSchema);
