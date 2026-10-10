import mongoose from 'mongoose';

// The audit trail of everything the administrator did. There is one shared passcode, so there is no admin identity beyond "admin".
const adminActionSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    // login | send-weather | declare | message | withdraw | settings | demo-create | demo-delete | discard
    action: { type: String, required: true },
    batchId: { type: String, default: null },
    eventKey: { type: String, default: null },
    roles: { type: [String], default: [] },
    areas: { type: mongoose.Schema.Types.Mixed, default: null },
    severity: { type: String, default: null },
    audience: { type: String, default: null },
    recipientCount: { type: Number, default: 0 },
    summary: { type: String, default: null },
    outcome: { type: String, default: 'ok' },
    reason: { type: String, default: null },
    // One click = one key: a retry or a double click cannot send twice.
    idempotencyKey: { type: String, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false, minimize: false },
);

adminActionSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
adminActionSchema.index({ at: -1 });
adminActionSchema.index({ batchId: 1 });

export const AdminAction = mongoose.model('AdminAction', adminActionSchema);
