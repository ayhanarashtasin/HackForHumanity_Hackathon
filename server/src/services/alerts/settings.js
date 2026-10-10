import { SEVERITIES } from '../../config/alertConstants.js';
import { HAZARD_TYPES } from '../../config/alertRules.js';
import { EngineSettings } from '../../models/EngineSettings.js';

// The administrator's switches: per-severity "hold" (wait for the admin) and per-hazard kill switches.
// Defaults (decision D8): automatic sending on, nothing held, every hazard enabled.
const CACHE_MS = 5_000;
let cache = { at: 0, value: null };

export const defaultSettings = () => ({
  hold: Object.fromEntries(SEVERITIES.map((severity) => [severity, false])),
  hazardEnabled: Object.fromEntries(HAZARD_TYPES.map((hazard) => [hazard, true])),
});

function normalize(doc) {
  const base = defaultSettings();
  return {
    hold: { ...base.hold, ...(doc?.hold ?? {}) },
    hazardEnabled: { ...base.hazardEnabled, ...(doc?.hazardEnabled ?? {}) },
    updatedAt: doc?.updatedAt ?? null,
  };
}

export async function getSettings({ force = false, now = Date.now() } = {}) {
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;
  const doc = await EngineSettings.findOneAndUpdate(
    { key: 'engine' },
    { $setOnInsert: { key: 'engine' } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  cache = { at: now, value: normalize(doc) };
  return cache.value;
}

// patch = { hold?: { WARNING: true }, hazardEnabled?: { HEAVY_RAIN: false } }. Unknown keys are rejected, never silently stored.
export async function updateSettings(patch) {
  const set = {};
  for (const [key, value] of Object.entries(patch?.hold ?? {})) {
    if (!SEVERITIES.includes(key) || typeof value !== 'boolean') throw Object.assign(new Error('Invalid hold setting.'), { status: 400 });
    set[`hold.${key}`] = value;
  }
  for (const [key, value] of Object.entries(patch?.hazardEnabled ?? {})) {
    if (!HAZARD_TYPES.includes(key) || typeof value !== 'boolean') throw Object.assign(new Error('Invalid hazard setting.'), { status: 400 });
    set[`hazardEnabled.${key}`] = value;
  }
  if (!Object.keys(set).length) throw Object.assign(new Error('Nothing to change.'), { status: 400 });

  const doc = await EngineSettings.findOneAndUpdate({ key: 'engine' }, { $set: set, $setOnInsert: { key: 'engine' } }, { upsert: true, returnDocument: 'after' }).lean();
  cache = { at: Date.now(), value: normalize(doc) };
  return cache.value;
}

export function resetSettingsCache() {
  cache = { at: 0, value: null };
}
