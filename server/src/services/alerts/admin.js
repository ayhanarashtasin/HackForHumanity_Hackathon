import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  ADMIN_MESSAGE_DEFAULT_HOURS, ADMIN_MESSAGE_MAX_HOURS, DELIVERY_CHANNELS, MARINE_ZONES, OCCUPATIONS, SEVERITIES,
} from '../../config/alertConstants.js';
import { RULE_STATUS, RULE_VERSION, hazardRules, ruleCatalogue } from '../../config/alertRules.js';
import { env } from '../../config/env.js';
import { AdminAction } from '../../models/AdminAction.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import { JobState } from '../../models/JobState.js';
import { Notification } from '../../models/Notification.js';
import { RuleSetting } from '../../models/RuleSetting.js';
import { Subscriber } from '../../models/Subscriber.js';
import { sharedChannels } from '../delivery/channels/index.js';
import { deliveryStats } from '../delivery/queue.js';
import { districts, locationByPcode } from '../geo.js';
import { dhakaIso } from '../time.js';
import { createXweatherBudget } from '../xweatherBudget.js';
import { detectAll } from './engine.js';
import { newBatchId, withdrawEvent } from './events.js';
import {
  detectDrySpell, detectHeat, detectHeavyRain, detectWind, primarySource,
} from './hazards.js';
import { listInbox, unreadCount } from './inbox.js';
import { ACTIONS, HAZARD_LABELS, lintText } from './messages.js';
import { OCCUPATION_DEFS } from './schema.js';
import { buildAreaForecast, loadSources } from './normalize.js';
import { applyAdminMessage, applyEvent, applyGenericDeclaration } from './notify.js';
import { HttpError, badRequest, notFound } from './errors.js';
import { createSubscriber } from './subscribers.js';
import { getSettings, updateSettings } from './settings.js';
import { loadShelterSnapshot, nearestShelters, shelterSnapshotStatus } from './floodShelters.js';
import { loadForecastInputs } from './snapshots.js';
import { sourceRows } from './status.js';

// The administrator's actions (ALERT_ENGINE_PLAN.md section 6): send now from weather, declare a hazard, free message, withdraw, history.
// Every send is previewed first (the server enforces it), idempotent, audited, and never labelled as BMD.
const HOUR = 3_600_000;
const PREVIEW_TTL_MS = 10 * 60_000;
const SEND_LIMIT = { windowMs: HOUR, max: 20 };
const SUPPORT_CHECK_MAX_AREAS = 40;
const DECLARABLE = ['HEAVY_RAIN', 'HEAT_STRESS', 'STRONG_WIND', 'OBSERVED_LIGHTNING', 'LIGHTNING_THREAT', 'MARINE_WEATHER', 'DRY_SPELL', 'RIVER_FLOOD'];
const LIGHTNING = ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'];
const districtByPcode = new Map(districts.map((district) => [district.pcode, district]));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (list) => [...new Set(list)];

// ---------- audit ----------
export async function audit(entry) {
  return AdminAction.create({ at: new Date(), outcome: 'ok', ...entry });
}

// ---------- input ----------
function normalizeRoles(body, { required = true } = {}) {
  const roles = body.roles;
  if (roles === undefined || roles === null) {
    if (required) throw badRequest('Choose at least one role.');
    return [];
  }
  if (!Array.isArray(roles) || roles.some((role) => !OCCUPATIONS.includes(role))) throw badRequest('Roles must come from the list of roles.');
  const list = unique(roles).sort();
  if (required && !list.length) throw badRequest('Choose at least one role.');
  return list;
}

// areas = null / { all: true } = everywhere, or { districts: [4-digit codes], upazilas: [6-digit codes] }.
function normalizeAreas(body, { required = false } = {}) {
  const areas = body.areas;
  if (areas === undefined || areas === null || (isObject(areas) && areas.all === true)) {
    if (required && !(isObject(areas) && areas.all === true)) throw badRequest('Choose where this applies.');
    return { all: true, districts: [], upazilas: [], codes: null };
  }
  if (!isObject(areas)) throw badRequest('Areas must be an object.');
  const chosenDistricts = unique(areas.districts ?? []).sort();
  const chosenUpazilas = unique(areas.upazilas ?? []).sort();
  if (chosenDistricts.some((code) => !districtByPcode.has(code))) throw badRequest('Unknown district code.');
  if (chosenUpazilas.some((code) => !locationByPcode.has(code))) throw badRequest('Unknown upazila code.');
  if (!chosenDistricts.length && !chosenUpazilas.length) throw badRequest('Choose where this applies.');
  return { all: false, districts: chosenDistricts, upazilas: chosenUpazilas, codes: [...chosenDistricts, ...chosenUpazilas] };
}

function normalizeAudience(body) {
  const audience = body.audience ?? 'live';
  if (!['live', 'demo'].includes(audience)) throw badRequest('Audience must be live or demo.');
  return audience;
}

// The same parameters must be previewed before they are sent: this is the fingerprint that ties the two together.
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalizeDeclare(body) {
  const hazardType = body.hazardType;
  if (!DECLARABLE.includes(hazardType)) throw badRequest('Choose a hazard type to declare.');
  const level = Number(body.level);
  const minimum = LIGHTNING.includes(hazardType) ? 2 : 1;
  const maximum = hazardType === 'DRY_SPELL' ? 1 : 3;
  if (!Number.isInteger(level) || level < minimum || level > maximum) throw badRequest(`Level must be ${minimum} to ${maximum} for this hazard.`);
  const hours = body.hours === undefined ? ADMIN_MESSAGE_DEFAULT_HOURS : Number(body.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > ADMIN_MESSAGE_MAX_HOURS) throw badRequest(`Validity must be 1 to ${ADMIN_MESSAGE_MAX_HOURS} hours.`);
  const marine = hazardType === 'MARINE_WEATHER';
  return {
    mode: 'declare',
    hazardType,
    level,
    hours,
    roles: normalizeRoles(body),
    areas: marine ? { all: false, districts: [], upazilas: [], codes: [] } : normalizeAreas(body, { required: true }),
    audience: normalizeAudience(body),
    marineZone: marine ? MARINE_ZONES[0].id : null,
  };
}

function normalizeMessage(body) {
  const severity = body.severity;
  if (!SEVERITIES.includes(severity)) throw badRequest('Choose a severity.');
  const clean = (value, max, label, { required = false } = {}) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (required && !text) throw badRequest(`${label} is required.`);
    if (text.length > max) throw badRequest(`${label} must be at most ${max} characters.`);
    return text || null;
  };
  const text = { en: clean(body.text?.en, 600, 'The English text', { required: true }), bn: clean(body.text?.bn, 600, 'The Bangla text') };
  const title = { en: clean(body.title?.en, 80, 'The English title'), bn: clean(body.title?.bn, 80, 'The Bangla title') };
  const actions = unique(body.actions ?? []).sort();
  if (actions.some((key) => !ACTIONS[key])) throw badRequest('Unknown action.');
  let referenceUrl = null;
  if (body.referenceUrl) {
    try {
      const url = new URL(String(body.referenceUrl));
      if (!['http:', 'https:'].includes(url.protocol) || String(body.referenceUrl).length > 300) throw new Error('bad');
      referenceUrl = url.toString();
    } catch {
      throw badRequest('The reference link must be a web address starting with http:// or https://.');
    }
  }
  const hours = body.hours === undefined ? ADMIN_MESSAGE_DEFAULT_HOURS : Number(body.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > ADMIN_MESSAGE_MAX_HOURS) throw badRequest(`Validity must be 1 to ${ADMIN_MESSAGE_MAX_HOURS} hours.`);
  return {
    mode: 'message',
    severity,
    text,
    title,
    actions,
    referenceUrl,
    hours,
    roles: normalizeRoles(body),
    areas: normalizeAreas(body, { required: true }),
    audience: normalizeAudience(body),
  };
}

function normalizeWeather(body) {
  return { mode: 'weather', roles: normalizeRoles(body), areas: normalizeAreas(body), audience: normalizeAudience(body) };
}

export function normalizeRequest(body) {
  if (!isObject(body)) throw badRequest('Request body must be an object.');
  if (body.mode === 'weather') return normalizeWeather(body);
  if (body.mode === 'declare') return normalizeDeclare(body);
  if (body.mode === 'message') return normalizeMessage(body);
  throw badRequest('mode must be weather, declare or message.');
}

// ---------- preview tokens: the server, not the page, makes a preview mandatory ----------
const previews = new Map();

function remember(params, extra) {
  const now = Date.now();
  for (const [token, entry] of previews) if (entry.expiresAt <= now) previews.delete(token);
  const token = randomUUID();
  previews.set(token, { hash: fingerprint(params), expiresAt: now + PREVIEW_TTL_MS, ...extra });
  return token;
}

export function checkPreview(token, params) {
  const entry = typeof token === 'string' ? previews.get(token) : null;
  if (!entry || entry.expiresAt <= Date.now()) throw new HttpError(409, 'Preview this send first (the preview expires after 10 minutes).');
  if (entry.hash !== fingerprint(params)) throw new HttpError(409, 'The send no longer matches the preview. Preview it again.');
  return entry;
}

export const forgetPreview = (token) => previews.delete(token);

// ---------- coverage of declared / message events ----------
function coverageOf(params) {
  if (params.hazardType === 'MARINE_WEATHER') {
    return { scope: 'marine-zone', upazilaPcodes: [], districtPcodes: [], marineZone: params.marineZone, matchMethod: 'marine_zone' };
  }
  const allDistricts = params.areas.all ? districts.map((district) => district.pcode) : params.areas.districts;
  return {
    scope: params.areas.upazilas.length && !allDistricts.length ? 'upazila' : 'district',
    upazilaPcodes: params.areas.upazilas,
    districtPcodes: allDistricts,
    marineZone: null,
    matchMethod: allDistricts.length ? 'district' : 'representative_point',
  };
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function findDeclared(params) {
  const candidates = await HazardEvent.find({ origin: 'admin-declared', hazardType: params.hazardType, isDemo: params.audience === 'demo', lifecycle: 'active', validUntil: { $gt: new Date() } });
  const coverage = coverageOf(params);
  return candidates.find((event) => sameSet(event.coverage.upazilaPcodes ?? [], coverage.upazilaPcodes)
    && sameSet(event.coverage.districtPcodes ?? [], coverage.districtPcodes) && (event.coverage.marineZone ?? null) === coverage.marineZone) ?? null;
}

// A plain (unsaved) event for dry runs: same shape, so the engine treats it exactly like the real one.
function draftEvent(params, nowMs, existing) {
  const now = new Date(nowMs);
  return {
    _id: existing?._id ?? new mongoose.Types.ObjectId(),
    eventKey: existing?.eventKey ?? `adm:${randomUUID()}`,
    hazardType: params.hazardType ?? 'ADMIN_NOTICE',
    origin: params.mode === 'message' ? 'admin-message' : 'admin-declared',
    source: { provider: 'admin', product: params.mode === 'message' ? 'message' : 'declared', referenceId: null },
    coverage: coverageOf(params.mode === 'message' ? { ...params, hazardType: 'ADMIN_NOTICE' } : params),
    level: params.mode === 'message' ? 0 : params.level,
    evidence: { asserted: { by: 'administrator', at: now }, metrics: null, agreement: null, coverage: 'declared', rule: null, audience: params.audience, roles: [...new Set([...(existing?.evidence?.roles ?? []), ...params.roles])] },
    validFrom: now,
    validUntil: new Date(nowMs + params.hours * HOUR),
    lifecycle: 'active',
    dataStatus: 'FRESH',
    isDemo: params.audience === 'demo',
  };
}

function eventDocument(params, nowMs, overrides) {
  const { _id, ...document } = draftEvent(params, nowMs, null);
  const now = new Date(nowMs);
  return { ...document, firstDetectedAt: now, lastConfirmedAt: now, lastUpdatedAt: now, revision: 1, ...overrides };
}

// A declared flood has no gauge behind it, but when it names exactly one upazila the cached DDM list can still say where the nearest
// shelters are. Several areas share one event, so no single list would be right for all of them and none is attached.
async function declaredFloodShelters(params, nowMs) {
  if (params.hazardType !== 'RIVER_FLOOD' || !env.flood.sheltersEnabled) return null;
  if (params.areas.all || params.areas.districts.length || params.areas.upazilas.length !== 1) return null;
  const point = locationByPcode.get(params.areas.upazilas[0]);
  if (!point) return null;
  const row = await loadShelterSnapshot();
  return { shelters: nearestShelters(row?.data?.shelters ?? [], point.lat, point.lon), shelterStatus: shelterSnapshotStatus(row, nowMs) };
}

// ---------- does current cached data support what the administrator is declaring? ----------
const DETECTORS = { HEAVY_RAIN: detectHeavyRain, HEAT_STRESS: detectHeat, STRONG_WIND: detectWind, DRY_SPELL: detectDrySpell };

export async function supportCheck(params, nowMs) {
  const detect = DETECTORS[params.hazardType];
  if (!detect) return { supported: 'unknown', reason: 'no-forecast-check', checked: 0 };

  const pcodes = unique([
    ...params.areas.upazilas,
    ...params.areas.districts.flatMap((code) => districtByPcode.get(code)?.upazilas ?? []),
  ]);
  if (params.areas.all || pcodes.length > SUPPORT_CHECK_MAX_AREAS || !pcodes.length) return { supported: 'unknown', reason: 'too-many-areas', checked: 0 };

  const sources = loadSources(nowMs);
  const inputs = await loadForecastInputs(pcodes, nowMs);
  const rows = [];
  for (const pcode of pcodes) {
    const area = buildAreaForecast(pcode, { now: nowMs, sources, xweather: inputs.get(pcode) ?? null });
    if (!area) continue;
    const source = primarySource(area, params.hazardType);
    const detection = detect(area, nowMs);
    rows.push({ pcode, name: area.name, status: source?.status ?? 'UNAVAILABLE', level: detection?.level ?? 0 });
  }

  const usable = rows.filter((row) => ['FRESH', 'PARTIAL'].includes(row.status));
  if (!usable.length) return { supported: 'unknown', reason: 'data-unavailable', checked: rows.length, rows: rows.slice(0, 5) };
  const best = Math.max(...usable.map((row) => row.level));
  const supported = best >= params.level ? 'yes' : best > 0 ? 'partly' : 'no';
  return { supported, reason: null, checked: usable.length, bestLevel: best, rows: rows.filter((row) => row.level > 0).slice(0, 5) };
}

// ---------- the weather-based send ----------
async function weatherGroups(params, { nowMs, dryRun, batchId }) {
  const { settings } = await detectAll({ nowMs });
  const events = await HazardEvent.find({ origin: 'detected', lifecycle: 'active', validUntil: { $gt: new Date(nowMs) } }).lean();
  const groups = [];
  const totals = { recipients: 0, inserted: 0, released: 0, unchanged: 0, held: 0 };

  for (const event of events) {
    if (settings.hazardEnabled?.[event.hazardType] === false) continue;
    const summary = await applyEvent(event, {
      nowMs,
      settings,
      roles: params.roles,
      audience: params.audience,
      areaCodes: params.areas.codes,
      dryRun,
      publishNow: true,
      bypassCap: true,
      publishedBy: 'admin',
      batchId,
    });
    totals.recipients += summary.recipients;
    totals.inserted += summary.inserted;
    totals.released += summary.released;
    totals.unchanged += summary.unchanged;
    for (const group of summary.groups) {
      groups.push({
        ...group,
        event: {
          id: String(event._id), hazardType: event.hazardType, level: event.level, validFrom: event.validFrom, validUntil: event.validUntil,
          dataStatus: event.dataStatus, provider: event.source?.provider ?? null,
        },
      });
    }
  }
  return { groups, totals, settings };
}

// Why a role has nothing to send: never "all clear", always which sources were looked at.
async function nothingDetected(params, groups, nowMs) {
  const covered = new Set(groups.filter((group) => group.newCount || group.released || group.alreadySent).map((group) => group.occupation));
  const sources = await sourceRows(nowMs);
  const rows = [];
  for (const role of params.roles) {
    if (covered.has(role)) continue;
    const query = { status: 'active', occupation: role, expiresAt: { $gt: new Date(nowMs) } };
    if (params.audience === 'live') query.isDemo = { $ne: true };
    if (params.audience === 'demo') query.isDemo = true;
    if (params.areas.codes) query.$or = [{ relevantUpazilas: { $in: params.areas.codes } }, { relevantDistricts: { $in: params.areas.codes } }];
    const subscribers = await Subscriber.countDocuments(query);
    const forecastStatuses = sources.filter((source) => ['bmd', 'openMeteo'].includes(source.key)).map((source) => source.status);
    let reason = 'no-hazard';
    if (!subscribers) reason = 'no-subscribers';
    else if (!forecastStatuses.includes('FRESH')) reason = forecastStatuses.includes('STALE') ? 'source-stale' : 'source-unavailable';
    rows.push({ role, reason, subscribers, sources: sources.map((source) => ({ key: source.key, label: source.label, status: source.status, checkedAt: source.checkedAt })) });
  }
  return rows;
}

// ---------- preview ----------
export async function preview(body, { nowMs = Date.now() } = {}) {
  const params = normalizeRequest(body);
  const common = { mode: params.mode, roles: params.roles, audience: params.audience, generatedAt: dhakaIso(new Date(nowMs)) };

  if (params.mode === 'weather') {
    const { groups, totals } = await weatherGroups(params, { nowMs, dryRun: true, batchId: null });
    const sendable = groups.filter((group) => group.newCount || group.released);
    const requires = { critical: sendable.some((group) => group.severity === 'CRITICAL'), typed: null };
    const token = remember(params, { requires, recipients: totals.inserted + totals.released });
    return {
      ...common,
      previewToken: token,
      groups,
      totals: { newRecipients: totals.inserted, released: totals.released, alreadySent: groups.reduce((sum, group) => sum + group.alreadySent, 0) },
      nothing: await nothingDetected(params, groups, nowMs),
      requires,
      warnings: [],
    };
  }

  const existing = params.mode === 'declare' ? await findDeclared(params) : null;
  const event = draftEvent(params, nowMs, existing);

  if (params.mode === 'declare') {
    Object.assign(event.evidence, await declaredFloodShelters(params, nowMs));
    const support = await supportCheck(params, nowMs);
    const summary = await applyEvent(event, {
      nowMs, settings: {}, roles: params.roles, audience: params.audience, dryRun: true, publishNow: true, bypassCap: true, publishedBy: 'admin',
    });
    // A declared hazard reaches everyone in the chosen area and role, not only the occupations and conditions the catalogue happens to
    // cover: anyone the scenarios left out (summary.matchedSubscriberIds) gets the same declaration in generic, occupation-neutral wording.
    const general = await applyGenericDeclaration(event, {
      nowMs, roles: params.roles, audience: params.audience, excludeIds: summary.matchedSubscriberIds, dryRun: true, publishedBy: 'admin',
    });
    const groups = [...summary.groups, ...general.groups];
    const critical = LIGHTNING.includes(params.hazardType) || groups.some((group) => group.severity === 'CRITICAL');
    const requires = { critical, typed: support.supported === 'no' ? 'SEND' : null };
    const token = remember(params, { requires, recipients: summary.inserted + general.inserted });
    return {
      ...common,
      previewToken: token,
      hazardType: params.hazardType,
      level: params.level,
      validUntil: dhakaIso(event.validUntil),
      updatesExisting: Boolean(existing),
      support,
      groups,
      totals: {
        newRecipients: summary.inserted + general.inserted,
        released: 0,
        alreadySent: groups.reduce((sum, group) => sum + group.alreadySent, 0),
      },
      requires,
      warnings: support.supported === 'no' ? ['The cached weather data does not show this hazard for the chosen areas.'] : [],
    };
  }

  const summary = await applyAdminMessage(event, {
    nowMs, roles: params.roles, audience: params.audience, severity: params.severity, title: params.title, text: params.text,
    actions: params.actions, referenceUrl: params.referenceUrl, batchId: 'preview', dryRun: true,
  });
  const requires = { critical: params.severity === 'CRITICAL', typed: null };
  const token = remember(params, { requires, recipients: summary.inserted });
  return {
    ...common,
    previewToken: token,
    severity: params.severity,
    validUntil: dhakaIso(event.validUntil),
    groups: summary.groups,
    totals: { newRecipients: summary.inserted, released: 0, alreadySent: summary.unchanged },
    requires,
    warnings: [...new Set([...lintText(params.text.en), ...lintText(params.text.bn), ...lintText(params.title.en)])],
  };
}

// ---------- send ----------
const sendTimes = [];

function checkRateLimit(nowMs) {
  while (sendTimes.length && nowMs - sendTimes[0] > SEND_LIMIT.windowMs) sendTimes.shift();
  if (sendTimes.length >= SEND_LIMIT.max) throw new HttpError(429, `At most ${SEND_LIMIT.max} sends an hour. Please wait before sending again.`);
  sendTimes.push(nowMs);
}

export function resetSendLimit() {
  sendTimes.length = 0;
}

function checkConfirmations(entry, body) {
  if (entry.requires.typed && body.confirm?.typed !== entry.requires.typed) {
    throw new HttpError(409, `The cached weather data does not support this declaration. Type ${entry.requires.typed} to send it anyway.`);
  }
  if (entry.requires.critical && body.confirm?.critical !== true) {
    throw new HttpError(409, `This sends a CRITICAL alert to ${entry.recipients} people. Confirm once more to send it.`);
  }
}

// A retry or a double click with the same key gets the first result back and sends nothing — but only once that first attempt actually
// finished. An attempt recorded as 'failed' sent nothing usable, so it must never be replayed as if it had: the caller gets a real
// retry instead (claim() below reclaims the same key rather than leaving it permanently stuck on the dead attempt).
async function previousSend(key) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 80) return null;
  const previous = await AdminAction.findOne({ idempotencyKey: key }).lean();
  if (!previous || previous.outcome === 'failed') return null;
  if (previous.outcome === 'pending') throw new HttpError(409, 'This send is already in progress.');
  return { replayed: true, outcome: previous.outcome, result: previous.result ?? null };
}

// Claims the idempotency key before anything is sent: of two simultaneous clicks, only one can insert it. A key whose only previous
// attempt failed is reclaimed (put back to pending and reused) instead of blocking every later retry forever.
async function claim(key, fields) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 80) throw badRequest('A send needs an idempotency key of 8 to 80 characters.');
  try {
    return { action: await audit({ ...fields, idempotencyKey: key, outcome: 'pending' }), replay: null };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const reclaimed = await AdminAction.findOneAndUpdate(
      { idempotencyKey: key, outcome: 'failed' },
      { $set: { ...fields, outcome: 'pending', reason: null } },
      { new: true },
    );
    if (reclaimed) return { action: reclaimed, replay: null };
    const previous = await AdminAction.findOne({ idempotencyKey: key }).lean();
    if (previous?.outcome === 'pending') throw new HttpError(409, 'This send is already in progress.');
    return { action: null, replay: { replayed: true, outcome: previous?.outcome, result: previous?.result ?? null } };
  }
}

export async function send(body, { nowMs = Date.now() } = {}) {
  const params = normalizeRequest(body);
  const replay = await previousSend(body.idempotencyKey);
  if (replay) return replay;
  const entry = checkPreview(body.previewToken, params);
  checkConfirmations(entry, body);

  const base = {
    action: params.mode === 'weather' ? 'send-weather' : params.mode,
    roles: params.roles,
    areas: params.areas.all ? 'all' : { districts: params.areas.districts, upazilas: params.areas.upazilas },
    audience: params.audience,
    severity: params.severity ?? null,
  };
  const { action, replay: raced } = await claim(body.idempotencyKey, { at: new Date(nowMs), ...base });
  if (raced) return raced;

  const batchId = newBatchId();
  try {
    checkRateLimit(nowMs);
    let result;
    if (params.mode === 'weather') {
      const { groups, totals } = await weatherGroups(params, { nowMs, dryRun: false, batchId });
      result = { batchId, sent: totals.inserted, released: totals.released, alreadySent: groups.reduce((sum, group) => sum + group.alreadySent, 0), groups: groups.length };
    } else if (params.mode === 'declare') {
      const existing = await findDeclared(params);
      const now = new Date(nowMs);
      const floodShelters = await declaredFloodShelters(params, nowMs);
      let event;
      if (existing) {
        existing.level = params.level;
        existing.validUntil = new Date(nowMs + params.hours * HOUR);
        existing.lastConfirmedAt = now;
        existing.lastUpdatedAt = now;
        existing.revision += 1;
        existing.batchId = batchId;
        existing.set('evidence.roles', [...new Set([...(existing.evidence?.roles ?? []), ...params.roles])]);
        existing.set('evidence.audience', params.audience);
        if (floodShelters) {
          existing.set('evidence.shelters', floodShelters.shelters);
          existing.set('evidence.shelterStatus', floodShelters.shelterStatus);
        }
        await existing.save();
        event = existing;
      } else {
        const document = eventDocument(params, nowMs, { batchId });
        Object.assign(document.evidence, floodShelters);
        event = await HazardEvent.create(document);
      }
      const summary = await applyEvent(event, {
        nowMs, settings: {}, roles: params.roles, audience: params.audience, publishNow: true, bypassCap: true, publishedBy: 'admin', batchId,
      });
      const general = await applyGenericDeclaration(event, {
        nowMs, roles: params.roles, audience: params.audience, excludeIds: summary.matchedSubscriberIds, publishedBy: 'admin', batchId,
      });
      result = {
        batchId,
        eventId: String(event._id),
        sent: summary.inserted + general.inserted,
        updated: summary.updated + summary.escalated,
        alreadySent: summary.groups.reduce((sum, group) => sum + group.alreadySent, 0) + general.groups.reduce((sum, group) => sum + group.alreadySent, 0),
        updatesExisting: Boolean(existing),
      };
    } else {
      const event = await HazardEvent.create(eventDocument(params, nowMs, { eventKey: `adm:${batchId}`, batchId }));
      const summary = await applyAdminMessage(event, {
        nowMs, roles: params.roles, audience: params.audience, severity: params.severity, title: params.title, text: params.text,
        actions: params.actions, referenceUrl: params.referenceUrl, batchId,
      });
      result = { batchId, eventId: String(event._id), sent: summary.inserted, alreadySent: summary.unchanged };
    }

    forgetPreview(body.previewToken);
    await AdminAction.updateOne({ _id: action._id }, {
      $set: {
        batchId, recipientCount: result.sent + (result.released ?? 0), result, summary: summaryLine(params, result), outcome: 'ok',
      },
    });
    return { replayed: false, outcome: 'ok', result };
  } catch (error) {
    await AdminAction.updateOne({ _id: action._id }, { $set: { outcome: 'failed', reason: String(error.message).slice(0, 200) } });
    throw error;
  }
}

function summaryLine(params, result) {
  const who = params.roles.join(', ');
  if (params.mode === 'weather') return `Weather alerts for ${who}: ${result.sent} sent, ${result.released} released, ${result.alreadySent} already sent.`;
  if (params.mode === 'declare') return `Declared ${params.hazardType} level ${params.level} for ${who}: ${result.sent} sent.`;
  return `${params.severity} message to ${who}: ${result.sent} sent.`;
}

// ---------- withdraw ----------
export async function withdraw({ batchId = null, eventId = null, reason = null }, { nowMs = Date.now() } = {}) {
  const text = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  if (!batchId && !eventId) throw badRequest('Say which send to withdraw.');
  let events = [];

  if (eventId) {
    const event = await HazardEvent.findById(eventId).catch(() => null);
    if (!event) throw notFound('That alert was not found.');
    // Already withdrawn (or expired): say so below, through the same "nothing to withdraw" path as an exhausted batch, instead of
    // silently re-withdrawing it and overwriting who withdrew it, when and why with a second, unrelated reason.
    if (event.lifecycle === 'active') events = [event];
  } else {
    events = await HazardEvent.find({ batchId, lifecycle: 'active' });
  }

  let withdrawn = 0;
  let notifications = 0;
  for (const event of events) {
    notifications += await withdrawEvent(event, { source: 'administrator', reason: text || null, nowMs });
    withdrawn += 1;
  }

  // A weather send publishes notifications of events the engine owns: those notifications are withdrawn, the events are left alone.
  if (batchId && !events.length) {
    const now = new Date(nowMs);
    const result = await Notification.updateMany(
      { batchId, status: { $in: ['active', 'draft'] } },
      {
        $set: { status: 'withdrawn', withdrawalReason: text || 'administrator' },
        $push: { lifecycle: { $each: [{ at: now, type: 'withdrawn', note: `The administrator withdrew this alert. This is not an all-clear.${text ? ` Reason: ${text}` : ''}` }], $slice: -20 } },
      },
    );
    notifications += result.modifiedCount;
  }
  if (!withdrawn && !notifications) throw notFound('Nothing to withdraw: those alerts have already ended.');

  await audit({ at: new Date(nowMs), action: 'withdraw', batchId, eventKey: events[0]?.eventKey ?? null, reason: text || null, summary: `Withdrew ${withdrawn} event(s) and ${notifications} notification(s).` });
  return { events: withdrawn, notifications };
}

// Held notifications (only exist while a hold is on) that the administrator decides not to send.
export async function discardHeld({ roles = null, severity = null } = {}, { nowMs = Date.now() } = {}) {
  const query = { status: 'draft' };
  if (roles) query.occupation = { $in: normalizeRoles({ roles }) };
  if (severity) {
    if (!SEVERITIES.includes(severity)) throw badRequest('Unknown severity.');
    query.severity = severity;
  }
  const now = new Date(nowMs);
  const result = await Notification.updateMany(query, {
    $set: { status: 'discarded', withdrawalReason: 'discarded-by-administrator' },
    $push: { lifecycle: { $each: [{ at: now, type: 'withdrawn', note: 'Discarded by the administrator before it was sent.' }], $slice: -20 } },
  });
  await audit({ at: now, action: 'discard', roles: roles ?? [], severity, summary: `Discarded ${result.modifiedCount} held notification(s).` });
  return { discarded: result.modifiedCount };
}

// What the administrator can choose from (labels for the forms).
export function options() {
  const label = (type) => ({ type, label: HAZARD_LABELS[type] });
  return {
    roles: OCCUPATIONS.map((value) => ({ value, label: OCCUPATION_DEFS[value].label })),
    severities: SEVERITIES,
    hazards: DECLARABLE.map((type) => ({
      ...label(type),
      minLevel: LIGHTNING.includes(type) ? 2 : 1,
      maxLevel: type === 'DRY_SPELL' ? 1 : 3,
      needsArea: type !== 'MARINE_WEATHER',
    })),
    actions: Object.entries(ACTIONS).map(([key, text]) => ({ key, label: text })),
    marineZones: MARINE_ZONES.map((zone) => ({ id: zone.id, name: zone.name })),
    limits: { maxHours: ADMIN_MESSAGE_MAX_HOURS, defaultHours: ADMIN_MESSAGE_DEFAULT_HOURS, textMax: 600, titleMax: 80, sendsPerHour: SEND_LIMIT.max },
  };
}

// ---------- overview, history, rules, settings ----------
export async function overview(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const live = { status: 'active', expiresAt: { $gt: now } };
  const [byRole, byDistrict, total, demo, paused, areaCodes, engine, automatic, held, settings, sources, budget, lightning, delivery] = await Promise.all([
    Subscriber.aggregate([{ $match: live }, { $group: { _id: '$occupation', n: { $sum: 1 } } }]),
    Subscriber.aggregate([{ $match: live }, { $unwind: '$areas' }, { $match: { 'areas.role': 'home' } }, { $group: { _id: '$areas.districtPcode', n: { $sum: 1 } } }]),
    Subscriber.countDocuments({ expiresAt: { $gt: now } }),
    Subscriber.countDocuments({ ...live, isDemo: true }),
    Subscriber.countDocuments({ status: 'paused', expiresAt: { $gt: now } }),
    Subscriber.distinct('relevantUpazilas', live),
    JobState.findOne({ key: 'alert-engine' }).lean(),
    Notification.aggregate([
      { $match: { publishedBy: 'engine', publishedAt: { $gte: new Date(nowMs - 24 * HOUR) } } },
      { $group: { _id: { occupation: '$occupation', severity: '$severity' }, n: { $sum: 1 } } },
    ]),
    Notification.aggregate([
      { $match: { status: 'draft' } },
      { $group: { _id: '$severity', n: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
    ]),
    getSettings({ now: nowMs }),
    sourceRows(nowMs),
    createXweatherBudget().summary(),
    lightningTuning(nowMs),
    deliveryOverview(nowMs),
  ]);

  const divisions = {};
  for (const row of byDistrict) {
    const division = districtByPcode.get(row._id)?.division ?? 'Unknown';
    divisions[division] = (divisions[division] ?? 0) + row.n;
  }
  const heldCritical = held.find((row) => row._id === 'CRITICAL');

  return {
    generatedAt: dhakaIso(now),
    subscribers: { total, active: byRole.reduce((sum, row) => sum + row.n, 0), demo, paused, byRole: Object.fromEntries(byRole.map((row) => [row._id, row.n])), byDivision: divisions },
    monitoring: { areas: areaCodes.length },
    sources,
    budget,
    engine: {
      enabled: env.alerts.engineEnabled,
      lastCompletedAt: engine?.lastCompletedAt ? dhakaIso(new Date(engine.lastCompletedAt)) : null,
      lastStatus: engine?.lastStatus ?? null,
      lastError: engine?.lastError ?? null,
      lastStats: engine?.detail?.stats ?? null,
    },
    automatic24h: automatic.map((row) => ({ occupation: row._id.occupation, severity: row._id.severity, count: row.n })),
    held: {
      total: held.reduce((sum, row) => sum + row.n, 0),
      bySeverity: Object.fromEntries(held.map((row) => [row._id, row.n])),
      oldestAt: held.map((row) => row.oldest).filter(Boolean).sort((a, b) => +a - +b)[0] ?? null,
      criticalOldestAt: heldCritical?.oldest ?? null,
    },
    lightning24h: lightning,
    delivery,
    settings,
    rules: { version: RULE_VERSION, status: RULE_STATUS },
    adminAuthOff: env.admin.authOff,
  };
}

// Telegram, WhatsApp and SMS: which are set up, how many profiles connected each (counts only, never who), and what went out lately.
async function deliveryOverview(nowMs) {
  const channels = sharedChannels();
  const linkedFilter = (name) => (name === 'telegram' ? { 'channels.telegram.chatId': { $type: 'string' } } : { [`channels.${name}.verifiedAt`]: { $ne: null } });
  const [stats, job, ...linked] = await Promise.all([
    deliveryStats({ hours: 24, nowMs }),
    JobState.findOne({ key: 'delivery' }).lean(),
    ...DELIVERY_CHANNELS.map((name) => Subscriber.countDocuments({ ...linkedFilter(name), expiresAt: { $gt: new Date(nowMs) } })),
  ]);

  return {
    enabled: env.channels.deliveryEnabled,
    lastCompletedAt: job?.lastCompletedAt ? dhakaIso(new Date(job.lastCompletedAt)) : null,
    lastStatus: job?.lastStatus ?? null,
    minSeverity: env.channels.minSeverity,
    dailyCap: env.channels.dailyCap,
    channels: Object.fromEntries(DELIVERY_CHANNELS.map((name, index) => [name, {
      configured: Boolean(channels[name]?.configured),
      available: Boolean(channels[name]?.available),
      linkedProfiles: linked[index],
      last24h: stats.byChannel[name],
    }])),
  };
}

// The tuning view for alarm fatigue: lightning episodes in the last day and how many notifications each one produced.
async function lightningTuning(nowMs) {
  const since = new Date(nowMs - 24 * HOUR);
  const episodes = await HazardEvent.find({ hazardType: { $in: LIGHTNING }, firstDetectedAt: { $gte: since } }).select('_id').lean();
  if (!episodes.length) return { episodes: 0, notifications: 0, perEpisode: 0 };
  const notifications = await Notification.countDocuments({ hazardEventId: { $in: episodes.map((episode) => episode._id) }, status: { $ne: 'discarded' } });
  return { episodes: episodes.length, notifications, perEpisode: Math.round((notifications / episodes.length) * 10) / 10 };
}

export async function history({ limit = 40 } = {}, nowMs = Date.now()) {
  const size = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const actions = await AdminAction.find({ action: { $in: ['send-weather', 'declare', 'message', 'withdraw', 'settings', 'demo-create', 'demo-delete'] } }).sort({ at: -1 }).limit(size).lean();
  const batchIds = actions.map((action) => action.batchId).filter(Boolean);
  const stats = batchIds.length
    ? await Notification.aggregate([
      { $match: { batchId: { $in: batchIds } } },
      { $group: { _id: '$batchId', total: { $sum: 1 }, read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } }, withdrawn: { $sum: { $cond: [{ $eq: ['$status', 'withdrawn'] }, 1, 0] } }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
    ])
    : [];
  const byBatch = new Map(stats.map((row) => [row._id, row]));

  const events = await HazardEvent.find({ origin: 'detected', firstDetectedAt: { $gte: new Date(nowMs - 48 * HOUR) } }).sort({ firstDetectedAt: -1 }).limit(60).lean();
  const eventStats = events.length
    ? await Notification.aggregate([
      { $match: { hazardEventId: { $in: events.map((event) => event._id) } } },
      { $group: { _id: '$hazardEventId', total: { $sum: 1 }, read: { $sum: { $cond: [{ $ne: ['$readAt', null] }, 1, 0] } }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } },
    ])
    : [];
  const byEvent = new Map(eventStats.map((row) => [String(row._id), row]));

  return {
    sends: actions.map((action) => ({
      id: String(action._id),
      at: dhakaIso(action.at),
      action: action.action,
      batchId: action.batchId,
      roles: action.roles,
      areas: action.areas,
      severity: action.severity,
      audience: action.audience,
      recipientCount: action.recipientCount,
      summary: action.summary,
      outcome: action.outcome,
      reason: action.reason,
      delivery: byBatch.get(action.batchId) ?? null,
    })),
    automatic: events.map((event) => ({
      id: String(event._id),
      hazardType: event.hazardType,
      level: event.level,
      area: event.coverage.upazilaPcodes?.map((code) => locationByPcode.get(code)?.name ?? code).join(', ') || event.coverage.marineZone,
      firstDetectedAt: dhakaIso(event.firstDetectedAt),
      validUntil: dhakaIso(event.validUntil),
      lifecycle: event.lifecycle,
      dataStatus: event.dataStatus,
      delivery: byEvent.get(String(event._id)) ?? { total: 0, read: 0, active: 0 },
    })),
  };
}

export async function rules() {
  const stored = await RuleSetting.find({ version: RULE_VERSION }).lean();
  const byKey = new Map(stored.map((row) => [row.key, row]));
  return {
    version: RULE_VERSION,
    status: RULE_STATUS,
    thresholds: ruleCatalogue().map((row) => ({ ...row, status: byKey.get(row.id)?.status ?? row.status, validatedBy: byKey.get(row.id)?.validatedBy ?? null })),
    scenarios: stored.filter((row) => row.kind === 'scenario').map((row) => ({ id: row.key, status: row.status, enabled: row.enabled })),
    drySpell: hazardRules.DRY_SPELL.minDays,
  };
}

export async function changeSettings(patch) {
  const settings = await updateSettings(patch);
  await audit({ at: new Date(), action: 'settings', summary: `Settings changed: ${JSON.stringify(patch)}` });
  return settings;
}

// ---------- demo subscribers (one per role, so the dashboard can be demonstrated without a second device) ----------
const DEMO_PROFILES = {
  farmer: { cropType: 'rice_aman', cropStage: 'harvesting', irrigationAccess: 'pump', outdoorHours: '4to8', workload: 'moderate' },
  fisherman: { waterBody: 'coastal', status: 'ashore' },
  construction: { activityType: 'roof', workload: 'heavy', ppeHeatBurden: 'light', siteExposure: 'open', shiftStart: '08:00', shiftEnd: '17:00' },
  vendor: { outdoorStall: true, shelterAccess: 'partial', hoursOutdoor: '4to8' },
  student_public: { outdoorPlay: true },
  rickshaw_labourer: { shiftStart: '07:00', shiftEnd: '19:00', workload: 'heavy', outdoorExposure: 'on_road' },
};

export async function createDemoSubscribers(areaPcode) {
  if (typeof areaPcode !== 'string' || !locationByPcode.has(areaPcode)) throw badRequest('Choose an upazila for the demo subscribers.');
  const created = [];
  for (const occupation of OCCUPATIONS) {
    const exists = await Subscriber.exists({ isDemo: true, occupation, relevantUpazilas: areaPcode });
    if (exists) continue;
    const { subscriber } = await createSubscriber(
      { occupation, language: 'en', homeAreaPcode: areaPcode, occupationData: DEMO_PROFILES[occupation], consent: true },
      { isDemo: true },
    );
    created.push(subscriber._id);
  }
  await audit({ at: new Date(), action: 'demo-create', summary: `Created ${created.length} demo subscriber(s) in ${locationByPcode.get(areaPcode).name}.` });
  return listDemoSubscribers();
}

export async function listDemoSubscribers() {
  const rows = await Subscriber.find({ isDemo: true }).sort({ occupation: 1 }).lean();
  return Promise.all(rows.map(async (row) => {
    const home = row.areas.find((area) => area.role === 'home');
    return {
      id: String(row._id),
      occupation: row.occupation,
      area: locationByPcode.get(home?.upazilaPcode)?.name ?? home?.upazilaPcode ?? null,
      areaPcode: home?.upazilaPcode ?? null,
      unread: await unreadCount(row._id),
    };
  }));
}

export async function deleteDemoSubscribers() {
  const rows = await Subscriber.find({ isDemo: true }).select('_id').lean();
  const ids = rows.map((row) => row._id);
  await Notification.deleteMany({ subscriberId: { $in: ids } });
  await Subscriber.deleteMany({ _id: { $in: ids } });
  await audit({ at: new Date(), action: 'demo-delete', summary: `Deleted ${ids.length} demo subscriber(s).` });
  return { deleted: ids.length };
}

// A read-only look at a demo subscriber's inbox, exactly as that person would see it.
export async function viewAs(subscriberId, view = 'active') {
  const subscriber = await Subscriber.findOne({ _id: subscriberId, isDemo: true }).lean().catch(() => null);
  if (!subscriber) throw notFound('Demo subscriber not found.');
  return { occupation: subscriber.occupation, language: subscriber.language, ...(await listInbox(subscriber._id, { view })) };
}
