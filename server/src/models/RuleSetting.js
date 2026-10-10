import mongoose from 'mongoose';
import { RULE_STATUSES } from '../config/alertConstants.js';

// A record of each rule version. Defaults live in config/alertRules.js and are seeded here; a changed rule never rewrites old
// notifications because each notification stores its own ruleVersion. Validation (reviewer, date) is recorded here.
const ruleSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    kind: { type: String, enum: ['hazard', 'scenario'], required: true },
    hazard: { type: String, default: null },
    level: { type: Number, default: null },
    version: { type: String, required: true },
    status: { type: String, enum: RULE_STATUSES, default: 'prototype' },
    enabled: { type: Boolean, default: true },
    rule: { type: String, default: null },
    basis: { type: [String], default: [] },
    validatedBy: { type: String, default: null },
    validatedAt: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

ruleSettingSchema.index({ key: 1, version: 1 }, { unique: true });

export const RuleSetting = mongoose.model('RuleSetting', ruleSettingSchema);
