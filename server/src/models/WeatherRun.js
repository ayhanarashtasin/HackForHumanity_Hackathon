import mongoose from 'mongoose';

// One row per distinct forecast run (a new BMD model run, or one Open-Meteo pull), kept as a compact per-district summary.
// The full run is ~3 MB (544 locations x 32 steps x 8 variables) and only the newest one is kept in ForecastSnapshot; a summary of
// 64 districts is ~20 KB, so weeks of history fit in the database and can feed trends, back-testing and the alert rules later.
const weatherRunSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['bmd', 'openMeteo'], required: true },
    // BMD's own `updated_at` for BMD runs; the fetch time for Open-Meteo (it publishes no run id).
    runId: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    sourceUpdatedAt: { type: String, default: null },
    stepHours: { type: Number, default: 3 },
    steps: { type: Number, default: 0 },
    firstStep: { type: String, default: null },
    lastStep: { type: String, default: null },
    // { [districtPcode]: { w24: {...}, all: {...} } } — see services/weatherHistory.js for the metric keys.
    districts: { type: mongoose.Schema.Types.Mixed, required: true },
    // Cleanup only; readers do not depend on TTL deletion being instantaneous.
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, minimize: false },
);

weatherRunSchema.index({ source: 1, runId: 1 }, { unique: true });
weatherRunSchema.index({ source: 1, fetchedAt: -1 });
weatherRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WeatherRun = mongoose.model('WeatherRun', weatherRunSchema);
