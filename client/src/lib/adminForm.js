// Pure logic behind the administrator page (no React, no DOM, so node --test can cover it): request bodies for the three kinds of send,
// validation before a preview, "is this still the previewed send?", grouping of a preview, confirmation rules, area helpers and wording.
// The server stays the authority (it re-validates everything and refuses a send that was not previewed); this file only keeps the page honest.

export const MODES = ['weather', 'declare', 'message'];
export const CONFIRM_TYPED = 'SEND';
export const CRITICAL_HELD_MINUTES = 10;
export const SENDER_LABEL = 'Sent as: Administrator (not BMD)';
export const SEVERITIES = ['ADVISORY', 'WARNING', 'CRITICAL'];

const sorted = (list) => [...new Set(list)].sort();
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// ---------- names ----------
export const ROLE_NAMES = {
  farmer: 'Farmer',
  fisherman: 'Fisherman',
  construction: 'Construction worker',
  vendor: 'Vendor',
  student_public: 'Student or general public',
  rickshaw_labourer: 'Rickshaw puller or day labourer',
};

export const HAZARD_NAMES = {
  HEAVY_RAIN: 'Heavy rain',
  HEAT_STRESS: 'Heat stress',
  STRONG_WIND: 'Strong wind',
  OBSERVED_LIGHTNING: 'Lightning (observed)',
  LIGHTNING_THREAT: 'Lightning (threat)',
  MARINE_WEATHER: 'Rough marine weather',
  DRY_SPELL: 'Dry spell',
  OFFICIAL_NOTICE: 'Official notice',
  ADMIN_NOTICE: 'Administrator notice',
};

export const ACTION_NAMES = {
  'send-weather': 'Weather send',
  declare: 'Declared hazard',
  message: 'Free message',
  withdraw: 'Withdrawal',
  settings: 'Settings change',
  'demo-create': 'Demo subscribers created',
  'demo-delete': 'Demo subscribers deleted',
  discard: 'Held alerts discarded',
};

export const roleLabel = (options, value) => options?.roles?.find((role) => role.value === value)?.label?.en ?? ROLE_NAMES[value] ?? value;

// Capitalised, and observed lightning is told apart from a lightning threat (the server's own labels are sentence fragments: both say "lightning").
export function hazardLabel(type, options) {
  if (HAZARD_NAMES[type]) return HAZARD_NAMES[type];
  const label = options?.hazards?.find((hazard) => hazard.type === type)?.label?.en ?? type;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Why a role has nothing to send. Never "all clear": it says what was (not) found and why.
export const NOTHING_REASONS = {
  'no-hazard': 'No hazard crosses a threshold in the cached weather data for this role and area. That is not an all-clear: it only describes the sources checked below.',
  'no-subscribers': 'No subscribers of this role are in the chosen scope.',
  'source-stale': 'The forecast sources are stale, so nothing can be created from them.',
  'source-unavailable': 'The forecast sources are unavailable, so nothing can be created from them.',
};

export const reasonText = (reason) => NOTHING_REASONS[reason] ?? 'Nothing to send.';

// ---------- areas: { all: true } or { all: false, districts: [4-digit], upazilas: [6-digit] } ----------
export const emptyAreas = () => ({ all: true, districts: [], upazilas: [] });

export const areaCount = (areas) => (areas.all ? 0 : areas.districts.length + areas.upazilas.length);

// null (everywhere) is only valid where the server does not require an area, so required modes send { all: true } instead.
export function areasPayload(areas, { required = false } = {}) {
  if (!areas || areas.all) return required ? { all: true } : null;
  return { districts: sorted(areas.districts), upazilas: sorted(areas.upazilas) };
}

export function buildAreaIndex(catalogue) {
  if (!catalogue) return [];
  const districtName = new Map(catalogue.districts.map((district) => [district.pcode, district.name]));
  const index = [
    ...catalogue.districts.map((district) => ({
      level: 'district', code: district.pcode, name: district.name, nameBn: district.nameBn ?? '', parent: district.division, kind: 'District',
    })),
    ...catalogue.locations.map((location) => ({
      level: 'upazila', code: location.pcode, name: location.name, nameBn: location.nameBn ?? '', parent: districtName.get(location.district) ?? '', kind: location.kind === 'thana' ? 'City thana' : 'Upazila',
    })),
  ];
  return index.map((item) => ({ ...item, haystack: `${item.name} ${item.nameBn}`.toLowerCase() }));
}

export function searchAreas(index, query, { limit = 8, level = null } = {}) {
  const text = trimmed(query).toLowerCase();
  if (text.length < 2) return [];
  return index
    .filter((item) => (!level || item.level === level) && (item.haystack.includes(text) || (item.level === 'upazila' && item.code.startsWith(text))))
    .sort((a, b) => (b.haystack.startsWith(text) - a.haystack.startsWith(text)) || (a.level === 'district' ? -1 : 1) - (b.level === 'district' ? -1 : 1) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function addArea(areas, level, code) {
  const key = level === 'district' ? 'districts' : 'upazilas';
  const next = { all: false, districts: [...areas.districts], upazilas: [...areas.upazilas] };
  if (!next[key].includes(code)) next[key].push(code);
  return next;
}

export function removeArea(areas, level, code) {
  const key = level === 'district' ? 'districts' : 'upazilas';
  const next = { all: false, districts: [...areas.districts], upazilas: [...areas.upazilas] };
  next[key] = next[key].filter((item) => item !== code);
  return next.districts.length || next.upazilas.length ? next : emptyAreas();
}

export function areaSummary(areas, index) {
  if (!areas || areas.all) return 'All Bangladesh';
  const names = new Map(index.map((item) => [`${item.level}:${item.code}`, item.name]));
  return [
    ...areas.districts.map((code) => `${names.get(`district:${code}`) ?? code} district`),
    ...areas.upazilas.map((code) => names.get(`upazila:${code}`) ?? code),
  ].join(', ');
}

// History stores what was sent as 'all', null or { districts, upazilas }.
export function describeStoredAreas(value, index) {
  if (!value || value === 'all') return 'All Bangladesh';
  return areaSummary({ all: false, districts: value.districts ?? [], upazilas: value.upazilas ?? [] }, index);
}

// ---------- request bodies ----------
export function buildBody(mode, form) {
  const roles = sorted(form.roles ?? []);
  const audience = form.audience ?? 'live';

  if (mode === 'weather') return { mode, roles, areas: areasPayload(form.areas), audience };

  if (mode === 'declare') {
    const body = { mode, hazardType: form.hazardType, level: Number(form.level), hours: Number(form.hours), roles, audience };
    // A marine declaration applies to a sea zone, not to upazilas.
    if (form.hazardType !== 'MARINE_WEATHER') body.areas = areasPayload(form.areas, { required: true });
    return body;
  }

  const body = {
    mode,
    severity: form.severity,
    roles,
    areas: areasPayload(form.areas, { required: true }),
    audience,
    hours: Number(form.hours),
    text: compact({ en: trimmed(form.textEn), bn: trimmed(form.textBn) }),
    actions: sorted(form.actions ?? []),
  };
  const title = compact({ en: trimmed(form.titleEn), bn: trimmed(form.titleBn) });
  if (Object.keys(title).length) body.title = title;
  if (trimmed(form.referenceUrl)) body.referenceUrl = trimmed(form.referenceUrl);
  return body;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value));
}

// Sorts object keys and string lists so two bodies that mean the same thing compare equal.
export function canonical(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.every((item) => typeof item === 'string') ? [...items].sort() : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// A preview only counts for exactly the parameters it was made for: any change invalidates it.
export function sameParameters(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// ---------- validation (before a preview) ----------
export const isWebUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
};

export function validateForm(mode, form, options) {
  const problems = [];
  const limits = options?.limits ?? { maxHours: 72, textMax: 600, titleMax: 80 };
  if (!form.roles?.length) problems.push({ field: 'roles', message: 'Choose at least one role.' });
  if (!['live', 'demo'].includes(form.audience ?? 'live')) problems.push({ field: 'audience', message: 'Choose live or demo subscribers.' });

  const hours = Number(form.hours);
  const checkHours = () => {
    if (!Number.isFinite(hours) || hours < 1 || hours > limits.maxHours) problems.push({ field: 'hours', message: `Validity must be 1 to ${limits.maxHours} hours.` });
  };
  const checkAreas = () => {
    if (!form.areas?.all && !areaCount(form.areas)) problems.push({ field: 'areas', message: 'Choose where this applies, or all of Bangladesh.' });
  };

  if (mode === 'declare') {
    const hazard = options?.hazards?.find((item) => item.type === form.hazardType);
    if (!hazard) problems.push({ field: 'hazardType', message: 'Choose a hazard to declare.' });
    else {
      const level = Number(form.level);
      if (!Number.isInteger(level) || level < hazard.minLevel || level > hazard.maxLevel) problems.push({ field: 'level', message: `Level must be ${hazard.minLevel} to ${hazard.maxLevel} for this hazard.` });
      if (hazard.needsArea !== false) checkAreas();
    }
    checkHours();
  }

  if (mode === 'message') {
    if (!SEVERITIES.includes(form.severity)) problems.push({ field: 'severity', message: 'Choose a severity.' });
    const en = trimmed(form.textEn);
    if (!en) problems.push({ field: 'textEn', message: 'The English text is required.' });
    if (en.length > limits.textMax) problems.push({ field: 'textEn', message: `The English text must be at most ${limits.textMax} characters.` });
    if (trimmed(form.textBn).length > limits.textMax) problems.push({ field: 'textBn', message: `The Bangla text must be at most ${limits.textMax} characters.` });
    if (trimmed(form.titleEn).length > limits.titleMax) problems.push({ field: 'titleEn', message: `The English title must be at most ${limits.titleMax} characters.` });
    if (trimmed(form.titleBn).length > limits.titleMax) problems.push({ field: 'titleBn', message: `The Bangla title must be at most ${limits.titleMax} characters.` });
    const link = trimmed(form.referenceUrl);
    if (link && (!isWebUrl(link) || link.length > 300)) problems.push({ field: 'referenceUrl', message: 'The reference link must be a web address starting with http:// or https://.' });
    checkAreas();
    checkHours();
  }
  return problems;
}

export const defaultHours = (options) => options?.limits?.defaultHours ?? 6;

export function initialForm(mode, options) {
  const base = { roles: [], areas: emptyAreas(), audience: 'live' };
  if (mode === 'declare') return { ...base, hazardType: '', level: 2, hours: defaultHours(options) };
  if (mode === 'message') return { ...base, severity: 'ADVISORY', hours: defaultHours(options), textEn: '', textBn: '', titleEn: '', titleBn: '', actions: [], referenceUrl: '' };
  return base;
}

// ---------- reading a preview ----------
export function summarisePreview(preview) {
  const groups = preview?.groups ?? [];
  const row = (group, count) => ({ ...group, count });
  return {
    fresh: groups.filter((group) => group.newCount > 0).map((group) => row(group, group.newCount)),
    already: groups.filter((group) => group.alreadySent > 0).map((group) => row(group, group.alreadySent)),
    held: groups.filter((group) => (group.released ?? 0) + (group.held ?? 0) > 0).map((group) => row(group, (group.released ?? 0) + (group.held ?? 0))),
    nothing: preview?.nothing ?? [],
    totals: preview?.totals ?? { newRecipients: 0, released: 0, alreadySent: 0 },
  };
}

// Roles that have something new (or held) to send: the per-role "Send only ..." buttons.
export function sendableRoles(preview) {
  return sorted((preview?.groups ?? []).filter((group) => group.newCount > 0 || (group.released ?? 0) > 0).map((group) => group.occupation));
}

export function recipientBreakdown(preview, options) {
  const byRole = new Map();
  const byArea = new Map();
  for (const group of preview?.groups ?? []) {
    const count = (group.newCount ?? 0) + (group.released ?? 0);
    if (!count) continue;
    byRole.set(group.occupation, (byRole.get(group.occupation) ?? 0) + count);
    const area = group.affectedArea?.name ?? 'Unknown area';
    byArea.set(area, (byArea.get(area) ?? 0) + count);
  }
  const list = (map, label) => [...map].map(([key, count]) => ({ key, label: label(key), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { byRole: list(byRole, (key) => roleLabel(options, key)), byArea: list(byArea, (key) => key) };
}

// ---------- confirmation ----------
export function confirmationNeeds(preview) {
  const totals = preview?.totals ?? { newRecipients: 0, released: 0 };
  return {
    recipients: (totals.newRecipients ?? 0) + (totals.released ?? 0),
    critical: Boolean(preview?.requires?.critical),
    typed: preview?.requires?.typed ?? null,
    updatesExisting: Boolean(preview?.updatesExisting),
  };
}

// Sending nothing is pointless; re-declaring an active hazard can still change its level, so that case is allowed.
export function canSend(needs) {
  return needs.recipients > 0 || needs.updatesExisting;
}

export function confirmationReady(needs, state) {
  if (!canSend(needs)) return false;
  if (needs.typed && state.typed !== needs.typed) return false;
  if (needs.critical && state.critical !== true) return false;
  return true;
}

export function confirmPayload(needs, state) {
  const confirm = {};
  if (needs.typed) confirm.typed = state.typed;
  if (needs.critical) confirm.critical = state.critical === true;
  return Object.keys(confirm).length ? confirm : undefined;
}

export function sendBody(body, preview, idempotencyKey, confirm) {
  const request = { ...body, previewToken: preview.previewToken, idempotencyKey };
  if (confirm) request.confirm = confirm;
  return request;
}

// One key per click, 8 to 80 characters as the server requires; the same key is reused when the same click is retried.
export function newIdempotencyKey(random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
  const id = random ? random() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `adm-${id}`.slice(0, 80);
}

export function isPreviewExpired(error) {
  return error?.status === 409 && /preview/i.test(error.message ?? '');
}

export function describeError(error, fallback = 'Something went wrong. Please try again.') {
  return error?.message || fallback;
}

export function describeResult(mode, response) {
  const result = response?.result ?? {};
  const parts = [];
  if (mode === 'weather') {
    parts.push(`${result.sent ?? 0} sent`, `${result.released ?? 0} released`, `${result.alreadySent ?? 0} already sent`);
  } else if (mode === 'declare') {
    parts.push(`${result.sent ?? 0} sent`, `${result.updated ?? 0} updated`, `${result.alreadySent ?? 0} already sent`);
  } else {
    parts.push(`${result.sent ?? 0} sent`, `${result.alreadySent ?? 0} already sent`);
  }
  return parts.join(' · ');
}

// ---------- time (always Bangladesh time) ----------
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function bdDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${dateTime.format(date)} BST`;
}

export function minutesSince(value, nowMs = Date.now()) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : Math.max(0, Math.floor((nowMs - time) / 60_000));
}

export function ageLabel(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Held alerts wait for the administrator. A CRITICAL one waiting longer than ten minutes is flagged.
export function heldStatus(held, nowMs = Date.now()) {
  const criticalMinutes = minutesSince(held?.criticalOldestAt, nowMs);
  return {
    total: held?.total ?? 0,
    oldestMinutes: minutesSince(held?.oldestAt, nowMs),
    criticalMinutes,
    criticalOverdue: criticalMinutes !== null && criticalMinutes > CRITICAL_HELD_MINUTES,
  };
}

// ---------- overview ----------
export function automaticMatrix(rows, options) {
  const roles = sorted(rows.map((row) => row.occupation).filter(Boolean));
  return roles.map((role) => ({
    role,
    label: roleLabel(options, role),
    ...Object.fromEntries(SEVERITIES.map((severity) => [severity, rows.find((row) => row.occupation === role && row.severity === severity)?.count ?? 0])),
  }));
}

export const formatNumber = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en') : '—');

export const BASIS_LEGEND = {
  B: 'BMD figure, as published or quoted in reports of BMD statements',
  A: 'ACGIH / NIOSH occupational heat guidance',
  M: 'AMS or NWS convention',
  P: 'Project choice: no published criterion found, chosen to be conservative and explainable',
};

export const HAZARD_SWITCH_NOTES = {
  HEAVY_RAIN: 'Stops new rain events. Existing rain alerts are left alone until you withdraw them.',
  HEAT_STRESS: 'Stops new heat events (WBGT and heat index).',
  STRONG_WIND: 'Stops new strong-wind events.',
  OBSERVED_LIGHTNING: 'Stops lightning episodes from observed strikes.',
  LIGHTNING_THREAT: 'Stops lightning episodes from threat polygons.',
  MARINE_WEATHER: 'Stops marine-weather events for fishermen.',
  DRY_SPELL: 'Stops dry-spell prompts for farmers.',
  OFFICIAL_NOTICE: 'Stops official-notice events.',
  ADMIN_NOTICE: 'Stops the notice event type used by free messages.',
};
