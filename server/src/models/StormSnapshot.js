import mongoose from 'mongoose';

// One row per satellite frame the storm tracker analysed (ml-service, storm/tracker.py). Kept for 30 days: the live history is the
// test set for checking the tracker's projections against where storms really went, which the six-week GIBS archive cannot provide.
const stormSnapshotSchema = new mongoose.Schema(
  {
    observedAt: { type: Date, required: true },
    frames: { type: [String], default: [] },
    motionMinutes: { type: Number, default: 0 },
    // The tracker's cells as it returned them: centre, outline, motion, 30/60/90-minute projection and upazilas reached.
    cells: { type: mongoose.Schema.Types.Mixed, default: [] },
    assumptions: { type: mongoose.Schema.Types.Mixed, default: null },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, minimize: false },
);

stormSnapshotSchema.index({ observedAt: 1 }, { unique: true });
stormSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const StormSnapshot = mongoose.model('StormSnapshot', stormSnapshotSchema);
