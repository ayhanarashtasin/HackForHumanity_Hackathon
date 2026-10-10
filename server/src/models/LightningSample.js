import mongoose from 'mongoose';

export const sampleStatuses = ['claimed', 'done', 'failed', 'skipped_budget'];
export const sampleStates = ['reported', 'none', 'unavailable'];

const sampleSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, required: true },
    slotId: { type: String, required: true },
    locationId: { type: String, required: true },
    status: { type: String, enum: sampleStatuses, required: true },
    // Every API attempt, including retries; each one is charged to the budget.
    attempts: { type: Number, default: 0 },
    claimedAt: Date,
    leaseUntil: Date,
    state: { type: String, enum: sampleStates },
    count: { type: Number, default: null },
    cloudToGround: { type: Number, default: null },
    intracloud: { type: Number, default: null },
    window: { from: Date, to: Date },
    sampledAt: Date,
    detail: { type: String, default: null },
    warningCode: { type: String, default: null },
    errorClass: { type: String, default: null },
    httpStatus: { type: Number, default: null },
    cost: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false },
);

// The idempotency key: a (campaign, slot, location) can only ever exist once.
sampleSchema.index({ campaignId: 1, slotId: 1, locationId: 1 }, { unique: true });
sampleSchema.index({ campaignId: 1, locationId: 1, sampledAt: -1 });

export const LightningSample = mongoose.model('LightningSample', sampleSchema);
