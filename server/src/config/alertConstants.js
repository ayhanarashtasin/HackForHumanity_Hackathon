// Shared vocabulary of the alert engine: models, services and controllers all import these instead of repeating string literals.

export const OCCUPATIONS = ['farmer', 'fisherman', 'construction', 'vendor', 'student_public', 'rickshaw_labourer'];

// AkashSathi's own levels. They never replace or relabel official BMD signals.
export const SEVERITIES = ['ADVISORY', 'WARNING', 'CRITICAL'];
export const SEVERITY_RANK = { ADVISORY: 1, WARNING: 2, CRITICAL: 3 };

// Data availability, shared by every source.
export const DATA_STATUSES = ['FRESH', 'NO_MATCH', 'STALE', 'PARTIAL', 'UNAVAILABLE'];

export const AREA_ROLES = ['home', 'work', 'field', 'site', 'market', 'operating'];
export const MATCH_METHODS = ['manual', 'gps_nearest'];

// What a subscriber is doing right now (CTX-01): overrides the usual occupation while it lasts.
export const ACTIVITIES = [
  'on_water',
  'pre_departure',
  'on_road',
  'roof_work',
  'scaffolding',
  'elevated_work',
  'stall_outdoor',
  'outdoor_play',
  'in_field',
];

export const NOTIFICATION_STATUSES = ['active', 'expired', 'withdrawn', 'draft', 'discarded', 'expired_unsent'];
export const VISIBLE_STATUSES = ['active', 'expired', 'withdrawn'];
export const NOTIFICATION_ORIGINS = ['automatic', 'admin-declared', 'admin-message'];
export const EVENT_ORIGINS = ['detected', 'admin-declared', 'admin-message'];
export const EVENT_LIFECYCLES = ['active', 'expired', 'withdrawn', 'superseded'];
export const EVENT_SCOPES = ['upazila', 'district', 'circle', 'marine-zone', 'polygon'];
export const RULE_STATUSES = ['prototype', 'validated', 'admin'];

// Marine zones the engine can monitor. Only North Bay has been verified against Xweather and BMD products (plan spike S5).
export const MARINE_ZONES = [
  { id: 'north_bay', name: { en: 'North Bay', bn: 'উত্তর বঙ্গোপসাগর' }, lat: 21.5, lon: 91.0 },
];

export const ADMIN_MESSAGE_MAX_HOURS = 72;
export const ADMIN_MESSAGE_DEFAULT_HOURS = 6;

// External delivery channels (services/delivery). The in-app inbox is not a channel: it is always on.
export const DELIVERY_CHANNELS = ['telegram', 'whatsapp', 'sms'];
export const PHONE_CHANNELS = ['whatsapp', 'sms'];
export const DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];
