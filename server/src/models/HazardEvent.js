import mongoose from 'mongoose';
import {
  DATA_STATUSES, EVENT_LIFECYCLES, EVENT_ORIGINS, EVENT_SCOPES,
} from '../config/alertConstants.js';
import { HAZARD_TYPES } from '../config/alertRules.js';

// A detected (or administrator-declared) hazard. It knows nothing about occupations: scenarios turn it into personal advice.
const hazardEventSchema = new mongoose.Schema(
  {
    // Stable identity: see ALERT_ENGINE_PLAN.md section 10.1. Unique.
    eventKey: { type: String, required: true, unique: true },
    hazardType: { type: String, enum: HAZARD_TYPES, required: true },
    origin: { type: String, enum: EVENT_ORIGINS, default: 'detected' },
    source: {
      provider: { type: String, required: true },
      product: { type: String, default: null },
      referenceId: { type: String, default: null },
    },
    coverage: {
      scope: { type: String, enum: EVENT_SCOPES, required: true },
      upazilaPcodes: { type: [String], default: [] },
      districtPcodes: { type: [String], default: [] },
      marineZone: { type: String, default: null },
      // How the event was matched to the area: representative_point | boundary | district | marine_zone
      matchMethod: { type: String, default: 'representative_point' },
    },
    // Magnitude of the hazard (0-3). User-facing severity is decided per scenario, never here.
    level: { type: Number, min: 0, max: 3, default: 1 },
    // metrics, the rule that produced it, source agreement, coverage quality, administrator assertion, lightning episode parts...
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Original wording of an official notice. Never translated into AkashSathi levels.
    official: {
      type: new mongoose.Schema(
        {
          signalText: String,
          issuer: String,
          issuedAt: Date,
          documentUrl: String,
        },
        { _id: false },
      ),
      default: null,
    },
    validFrom: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    observedAt: { type: Date, default: null },
    forecastIssuedAt: { type: Date, default: null },
    lifecycle: { type: String, enum: EVENT_LIFECYCLES, default: 'active' },
    withdrawal: {
      type: new mongoose.Schema(
        {
          at: Date,
          // 'official' = a dated official cancellation; 'administrator'; 'system' = the forecast changed and it no longer applies
          source: { type: String, enum: ['official', 'administrator', 'system'] },
          reference: String,
          reason: String,
        },
        { _id: false },
      ),
      default: null,
    },
    firstDetectedAt: { type: Date, required: true },
    lastConfirmedAt: { type: Date, required: true },
    lastUpdatedAt: { type: Date, required: true },
    revision: { type: Number, default: 1 },
    // The revision the recipients were last evaluated at: the engine only re-evaluates events whose revision moved.
    evaluatedRevision: { type: Number, default: 0 },
    dataStatus: { type: String, enum: DATA_STATUSES, default: 'FRESH' },
    isDemo: { type: Boolean, default: false },
    // Set for administrator-declared and free-message events so History can group them.
    batchId: { type: String, default: null },
  },
  { versionKey: false, minimize: false },
);

hazardEventSchema.index({ 'coverage.upazilaPcodes': 1, validUntil: 1 });
hazardEventSchema.index({ 'coverage.districtPcodes': 1, validUntil: 1 });
hazardEventSchema.index({ lifecycle: 1, validUntil: 1 });
hazardEventSchema.index({ batchId: 1 });

export const HazardEvent = mongoose.model('HazardEvent', hazardEventSchema);
