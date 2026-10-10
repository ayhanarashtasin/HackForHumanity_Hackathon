import mongoose from 'mongoose';

// Read-only reference data seeded from server/data/locations.json at start-up (idempotent upsert by pcode).
// The hot path keeps using the in-memory catalogue in services/geo.js; this collection serves joins and tooling.
const areaSchema = new mongoose.Schema(
  {
    pcode: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['district', 'upazila', 'thana'], required: true },
    name: { type: String, required: true },
    nameBn: { type: String, default: null },
    parentPcode: { type: String, default: null },
    division: { type: String, default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    // A newer upazila or a city corporation that borrows the nearest BMD location's forecast.
    forecastApproximate: { type: Boolean, default: false },
    urban: { type: Boolean, default: false },
    lightningCircleIds: { type: [String], default: [] },
  },
  { versionKey: false },
);

areaSchema.index({ parentPcode: 1, kind: 1 });

export const Area = mongoose.model('Area', areaSchema);
