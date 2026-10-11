import mongoose from 'mongoose';

export const slotStatuses = ['pending', 'running', 'completed', 'partial', 'skipped_budget', 'missed'];

const slotSchema = new mongoose.Schema(
  {
    slotId: { type: String, required: true },
    kind: { type: String, enum: ['initial', 'scheduled'], required: true },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: slotStatuses, default: 'pending' },
    startedAt: Date,
    finishedAt: Date,
    // Held while a worker is running the slot; refreshed after every location.
    leaseUntil: Date,
    reason: String,
    done: Number,
    failed: Number,
    total: Number,
  },
  { _id: false },
);

const locationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ['circle', 'upazila'], required: true },
    name: { type: String, default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    radiusKm: { type: Number, required: true },
  },
  { _id: false },
);

const campaignSchema = new mongoose.Schema(
  {
    // One campaign per deployment; the unique key makes concurrent creation race-safe.
    key: { type: String, required: true, unique: true, default: 'lightning' },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Dhaka' },
    slotTimes: [String],
    maxSlots: { type: Number, required: true },
    graceMinutes: { type: Number, required: true },
    // Locked at creation: never switched after any spend.
    mode: { type: String, enum: ['A', 'B'], required: true },
    modeReason: { type: String, required: true },
    modeReasonBn: { type: String, default: null },
    locations: [locationSchema],
    slots: [slotSchema],
    budget: {
      remaining: { type: Number, required: true },
      reserve: { type: Number, required: true },
      usedByCampaign: { type: Number, default: 0 },
      costPerRequest: { type: Number, required: true },
      source: { type: String, enum: ['config', 'headers'], default: 'config' },
      updatedAt: Date,
    },
    rateLimit: {
      perMinute: Number,
      remainingMinute: { type: Number, default: null },
    },
    haltedReason: { type: String, default: null },
    lastRefreshAt: Date,
  },
  { timestamps: true, versionKey: false },
);

export const LightningCampaign = mongoose.model('LightningCampaign', campaignSchema);
