import mongoose from 'mongoose';
import { ACTIVITIES, AREA_ROLES, MATCH_METHODS, OCCUPATIONS } from '../config/alertConstants.js';

// Someone who completed the alert form. There are no accounts: the browser holds an opaque token (HttpOnly cookie) and only its
// SHA-256 is stored here. Only area codes are kept, never coordinates, names or e-mail addresses. A phone number exists only if the
// person chose WhatsApp or SMS and verified it; it is stored encrypted (services/delivery/secretBox.js) and masked for display.
const areaSchema = new mongoose.Schema(
  {
    role: { type: String, enum: AREA_ROLES, required: true },
    upazilaPcode: { type: String, required: true },
    districtPcode: { type: String, required: true },
    matchMethod: { type: String, enum: MATCH_METHODS, default: 'manual' },
  },
  { _id: false },
);

// Telegram needs no phone number: the person opens a one-time link, the bot learns the chat id, and that is all that is kept.
const telegramChannelSchema = new mongoose.Schema(
  {
    chatId: { type: String },
    linkedAt: { type: Date },
    followPendingUntil: { type: Date },
    liveMessageId: { type: Number },
    liveUntil: { type: Date },
    liveReportedAt: { type: Date },
    linkCodeHash: { type: String },
    linkExpiresAt: { type: Date },
  },
  { _id: false },
);

// WhatsApp and SMS: a Bangladeshi mobile number the person entered, consented to and proved they own with a one-time code.
// The number being verified lives in `pending` until the code is right, so an unverified number can never be used for delivery
// (and re-verifying a different number never makes the old verification apply to it).
const pendingPhoneSchema = new mongoose.Schema(
  {
    phoneEnc: { type: String },
    phoneMask: { type: String },
    consentAt: { type: Date },
    otpHash: { type: String },
    otpExpiresAt: { type: Date },
    otpAttempts: { type: Number, default: 0 },
    otpSentAt: { type: Date },
  },
  { _id: false },
);

const phoneChannelSchema = new mongoose.Schema(
  {
    phoneEnc: { type: String },
    phoneMask: { type: String },
    verifiedAt: { type: Date },
    consentAt: { type: Date },
    consentVersion: { type: String },
    pending: { type: pendingPhoneSchema },
    // Code requests in the current hour, for the per-profile limit.
    otpWindowStart: { type: Date },
    otpWindowCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const subscriberSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    occupation: { type: String, enum: OCCUPATIONS, required: true },
    // Validated against services/alerts/schema.js before it is saved.
    occupationData: { type: mongoose.Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, required: true },
    areas: { type: [areaSchema], default: [] },
    // Denormalised from `areas` on every save: they carry the (occupation, area) indexes the recipient search uses.
    relevantUpazilas: { type: [String], default: [] },
    relevantDistricts: { type: [String], default: [] },
    // Short-lived area only; the browser resolves GPS locally and never sends coordinates.
    currentArea: {
      type: new mongoose.Schema({
        upazilaPcode: { type: String, required: true },
        districtPcode: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        source: { type: String, enum: ['web', 'telegram'], default: 'web' },
        reportedAt: { type: Date },
      }, { _id: false }),
      default: null,
    },
    activeActivity: {
      type: new mongoose.Schema(
        {
          key: { type: String, enum: ACTIVITIES, required: true },
          since: { type: Date, required: true },
          expiresAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    language: { type: String, enum: ['bn', 'en'], default: 'bn' },
    isHeatSensitive: { type: Boolean, default: false },
    guardianManaged: { type: Boolean, default: false },
    preferences: {
      quietHours: {
        enabled: { type: Boolean, default: false },
        start: { type: String, default: '22:00' },
        end: { type: String, default: '06:00' },
      },
      channelInterest: { type: [String], default: [] },
    },
    consent: {
      version: { type: String, required: true },
      at: { type: Date, required: true },
    },
    // External delivery (optional, opt-in per channel). Alerts always reach the in-app inbox whether or not any of these are set.
    channels: {
      telegram: { type: telegramChannelSchema },
      whatsapp: { type: phoneChannelSchema },
      sms: { type: phoneChannelSchema },
    },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
    isDemo: { type: Boolean, default: false },
    // Written at most once an hour (not on every inbox poll). `expiresAt` slides forward with use: 90 days of inactivity removes the profile.
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

subscriberSchema.index({ occupation: 1, relevantUpazilas: 1 });
subscriberSchema.index({ occupation: 1, relevantDistricts: 1 });
// The engine finds recipients by area first (an event is occupation-neutral); the compound indexes above serve role-specific counts.
subscriberSchema.index({ relevantUpazilas: 1, status: 1 });
subscriberSchema.index({ relevantDistricts: 1, status: 1 });
subscriberSchema.index({ 'currentArea.upazilaPcode': 1, 'currentArea.expiresAt': 1 });
subscriberSchema.index({ 'currentArea.districtPcode': 1, 'currentArea.expiresAt': 1 });
// One Telegram chat belongs to one profile; the partial filter keeps profiles without Telegram out of the index.
subscriberSchema.index(
  { 'channels.telegram.chatId': 1 },
  { unique: true, partialFilterExpression: { 'channels.telegram.chatId': { $type: 'string' } } },
);
subscriberSchema.index({ 'channels.telegram.linkCodeHash': 1 }, { partialFilterExpression: { 'channels.telegram.linkCodeHash': { $type: 'string' } } });
// TTL cleanup is not instantaneous; the service also checks `expiresAt` on every request.
subscriberSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Subscriber = mongoose.model('Subscriber', subscriberSchema);
