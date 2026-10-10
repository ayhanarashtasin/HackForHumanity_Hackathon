import mongoose from 'mongoose';

// One shared admin passcode, so a session is just a hashed random token with an absolute expiry.
const adminSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// TTL cleanup is not instantaneous; middleware/admin.js also checks `expiresAt` on every request.
adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminSession = mongoose.model('AdminSession', adminSessionSchema);
