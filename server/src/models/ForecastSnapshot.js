import mongoose from 'mongoose';

// Latest normalized payload per source ('bmd', 'openMeteo'), kept so a restart serves data immediately.
const forecastSnapshotSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    fetchedAt: { type: Date, required: true },
    sourceUpdatedAt: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { versionKey: false, minimize: false },
);

export const ForecastSnapshot = mongoose.model('ForecastSnapshot', forecastSnapshotSchema);
