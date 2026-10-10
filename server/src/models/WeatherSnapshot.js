import mongoose from 'mongoose';
import { DATA_STATUSES } from '../config/alertConstants.js';

// The latest normalised result of one shared provider query (for example Xweather forecast for one upazila, or the lightning summary for
// one 100 km circle). Many subscribers are evaluated against the same snapshot, so a provider is asked once per area/query, never per user.
const weatherSnapshotSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    product: { type: String, required: true },
    queryKey: { type: String, required: true },
    // What was actually asked: { lat, lon, radiusKm, from, to }
    scope: { type: mongoose.Schema.Types.Mixed, default: {} },
    // When the data was last fetched successfully; attemptedAt is the last try, so a failed refresh keeps the last good data and says so.
    fetchedAt: { type: Date, required: true },
    attemptedAt: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    status: { type: String, enum: DATA_STATUSES, required: true },
    costTokens: { type: Number, default: null },
    httpStatus: { type: Number, default: null },
    errorClass: { type: String, default: null },
    message: { type: String, default: null },
    // Normalised payload only; the raw provider response is never stored.
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    // Cleanup only: readers still check freshness themselves because TTL deletion is not instantaneous.
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, minimize: false },
);

weatherSnapshotSchema.index({ provider: 1, product: 1, queryKey: 1 }, { unique: true });
weatherSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WeatherSnapshot = mongoose.model('WeatherSnapshot', weatherSnapshotSchema);
