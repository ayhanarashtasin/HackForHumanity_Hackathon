import mongoose from 'mongoose';

// "Record the last completed fetch in MongoDB": one small row per background task, plus a lease so a second process cannot run it too.
const jobStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    lastStartedAt: { type: Date, default: null },
    lastCompletedAt: { type: Date, default: null },
    lastStatus: { type: String, default: null },
    lastError: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    // Free-form per task (counts, cursors).
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false, minimize: false },
);

export const JobState = mongoose.model('JobState', jobStateSchema);
