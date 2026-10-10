import mongoose from 'mongoose';
import { SEVERITIES } from '../config/alertConstants.js';
import { HAZARD_TYPES } from '../config/alertRules.js';

// One document. By default the engine sends automatically, nothing is held and every hazard is enabled (decision D8).
const holdShape = Object.fromEntries(SEVERITIES.map((severity) => [severity, { type: Boolean, default: false }]));
const enabledShape = Object.fromEntries(HAZARD_TYPES.map((hazard) => [hazard, { type: Boolean, default: true }]));

const engineSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'engine' },
    // hold[severity] = notifications of that severity wait for an administrator instead of being sent automatically.
    hold: holdShape,
    // hazardEnabled[type] = false stops the engine creating events of that type (the per-hazard kill switch).
    hazardEnabled: enabledShape,
  },
  { timestamps: true, versionKey: false },
);

export const EngineSettings = mongoose.model('EngineSettings', engineSettingsSchema);
