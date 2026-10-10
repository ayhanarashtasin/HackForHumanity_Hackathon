import fs from 'node:fs';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { LightningCampaign } from '../models/LightningCampaign.js';
import { LightningSample } from '../models/LightningSample.js';
import { TIMEZONE, addDays, dhakaDate, dhakaIso, dhakaParts, dhakaWallTime, haversineKm } from './time.js';
import { createXweatherClient, redactSecrets } from './xweather.js';

export { TIMEZONE, addDays, dhakaDate, dhakaIso, dhakaWallTime, haversineKm };

export const SLOT_TIMES = ['07:00', '15:00', '23:00'];
export const UPAZILA_RADIUS_KM = 20; // Mode A: "near this upazila" scale; the API radius is only used by Mode B circles.
export const MAX_ATTEMPTS = 3; // one try plus two retries per location per slot
export const CONCURRENCY = 2;

const CAMPAIGN_KEY = 'lightning';
const pad = (n) => String(n).padStart(2, '0');
const SLOT_INTERVAL_MINUTES = 8 * 60;
const SAMPLE_WINDOW_MS = 5 * 60_000;
const LEASE_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
const TERMINAL_SLOTS = new Set(['completed', 'partial', 'skipped_budget', 'missed']);
const DONE_CLASSES = new Set(['ok', 'no-data', 'warning', 'invalid']);

export const LIMITATIONS = [
  'Three daily 5-minute snapshots (07:00, 15:00, 23:00 Bangladesh time): not continuous lightning monitoring and not whole-day totals.',
  'A search circle is not an administrative boundary: counts are circle-wide totals, not counts inside a particular upazila.',
  'Overlapping circles can include the same events and must never be summed into a national total; circles near the border include neighbouring countries.',
];

// Asia/Dhaka time helpers and haversineKm live in ./time.js; they are re-exported here for existing importers.

// ---------- static geography ----------
let geoCache;

export function loadGeoData() {
  if (geoCache) return geoCache;
  const read = (name) => JSON.parse(fs.readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8'));
  const circles = read('lightning-circles.json');
  const upazilas = read('lightning-upazilas.json');
  const catalogue = read('locations.json');
  geoCache = {
    apiRadiusKm: circles.apiRadiusKm,
    circles: circles.circles,
    upazilas: upazilas.upazilas,
    locationsByPcode: new Map(catalogue.locations.map((l) => [l.pcode, l])),
  };
  return geoCache;
}

const circleLocations = (geo) => geo.circles.map((c) => ({ id: c.id, kind: 'circle', name: null, lat: c.lat, lon: c.lon, radiusKm: geo.apiRadiusKm }));
const upazilaLocations = (geo) => geo.upazilas.map((u) => ({ id: u.id, kind: 'upazila', name: u.name, lat: u.lat, lon: u.lon, radiusKm: UPAZILA_RADIUS_KM }));

// ---------- mode choice, projections and slot planning (pure) ----------
const format = (n) => n.toLocaleString('en-US');

// Every slot, including the initial refresh, counts toward the cap.
export function plannedSlotCount({ days, maxSlots, slotTimes = SLOT_TIMES }) {
  return Math.min(maxSlots, days * slotTimes.length + 1);
}

export function projectCost({ locationCount, slots, costPerRequest }) {
  return locationCount * slots * costPerRequest;
}

export function chooseMode({ upazilaCount, slots, costPerRequest, remaining, reserve, setupCost = 0 }) {
  const available = remaining - reserve - setupCost;
  const requiredA = projectCost({ locationCount: upazilaCount, slots, costPerRequest });
  const fitsA = requiredA <= available;
  const reason = fitsA
    ? `Mode A (upazila-location summaries): ${format(upazilaCount)} locations × ${slots} slots × ${costPerRequest} = ${format(requiredA)} accesses fits within the ${format(available)} available after the ${format(reserve)}-access reserve.`
    : `Mode B (regional-circle summaries): Mode A would need ${format(upazilaCount)} locations × ${slots} slots × ${costPerRequest} = ${format(requiredA)} accesses, but only ${format(available)} are available after the ${format(reserve)}-access reserve.`;
  return { mode: fitsA ? 'A' : 'B', requiredA, available, reason };
}

// The first slot is the initial population refresh unless a wall-clock slot is already due, in which case that slot is slot #1.
export function planSlots({ now, startDate, days, maxSlots, slotTimes = SLOT_TIMES, graceMinutes }) {
  const wall = [];
  for (let day = 0; day < days; day++) {
    const date = addDays(startDate, day);
    for (const time of slotTimes) wall.push({ slotId: `${date}T${time}`, scheduledAt: dhakaWallTime(date, time), kind: 'scheduled' });
  }

  const nowMs = now.getTime();
  const graceMs = graceMinutes * 60_000;
  const due = wall.find((s) => s.scheduledAt.getTime() <= nowMs && nowMs <= s.scheduledAt.getTime() + graceMs);
  const first = due ?? {
    slotId: `initial-${dhakaDate(now)}T${pad(dhakaParts(now).hh)}:${pad(dhakaParts(now).mm)}`,
    scheduledAt: now,
    kind: 'initial',
  };
  const future = wall.filter((s) => s.scheduledAt.getTime() > nowMs);
  return [first, ...future].slice(0, maxSlots);
}

function modeLabel(mode) {
  if (mode === 'A') return 'Upazila-location summaries';
  if (mode === 'B') return 'Regional-circle summaries';
  return null;
}

function planFromConfig(config, now, geo) {
  const slots = plannedSlotCount({ days: config.lightning.campaignDays, maxSlots: config.lightning.maxSlots });
  const choice = chooseMode({
    upazilaCount: geo.upazilas.length,
    slots,
    costPerRequest: config.xweather.assumedCostPerRequest,
    remaining: config.xweather.budgetRemaining,
    reserve: config.xweather.budgetReserve,
  });
  return { ...choice, slots, locations: choice.mode === 'A' ? upazilaLocations(geo) : circleLocations(geo) };
}

// ---------- read side (Mongo only: HTTP handlers never call Xweather) ----------
async function findCampaign() {
  if (mongoose.connection.readyState !== 1) return null;
  return LightningCampaign.findOne({ key: CAMPAIGN_KEY }).lean();
}

function isEnded(campaign, now) {
  const open = campaign.slots.some((s) => s.status === 'pending' || s.status === 'running');
  return !open || dhakaDate(now) > campaign.endDate;
}

export async function buildStatus({ config = env, now = () => new Date(), geo = loadGeoData() } = {}) {
  const nowDate = now();
  const campaign = await findCampaign();
  const credentials = Boolean(config.xweather.clientId && config.xweather.clientSecret);
  const plan = planFromConfig(config, nowDate, geo);

  let state;
  let reason = null;
  if (!config.lightning.enabled) {
    state = 'disabled';
    reason = 'Lightning collection is turned off.';
  } else if (campaign?.haltedReason) {
    state = 'disabled';
    reason = campaign.haltedReason;
  } else if (!credentials) {
    state = 'disabled';
    reason = 'Xweather credentials are not configured.';
  } else if (!campaign) {
    state = 'not-started';
    const start = config.lightning.campaignStart;
    reason = start && start > dhakaDate(nowDate) ? `The campaign starts on ${start}.` : 'The first refresh has not run yet.';
  } else if (isEnded(campaign, nowDate)) {
    state = 'ended';
    reason = 'The campaign has finished; scheduled collection has stopped.';
  } else {
    state = 'active';
  }

  const rateLimit = {
    perMinute: campaign?.rateLimit?.perMinute ?? config.xweather.requestsPerMinute,
    remainingMinute: campaign?.rateLimit?.remainingMinute ?? null,
  };

  if (!campaign) {
    const cost = config.xweather.assumedCostPerRequest;
    const projected = projectCost({ locationCount: plan.locations.length, slots: plan.slots, costPerRequest: cost });
    return {
      state,
      reason,
      mode: plan.mode,
      modeLabel: modeLabel(plan.mode),
      modeReason: plan.reason,
      campaign: null,
      budget: {
        remaining: config.xweather.budgetRemaining,
        reserve: config.xweather.budgetReserve,
        usedByCampaign: 0,
        costPerRequest: cost,
        locationCount: plan.locations.length,
        projectedCampaignCost: projected,
        projectedRemainingAfterCampaign: config.xweather.budgetRemaining - projected,
        updatedAt: null,
        source: 'config',
      },
      rateLimit,
      limitations: LIMITATIONS,
    };
  }

  const count = (...statuses) => campaign.slots.filter((s) => statuses.includes(s.status)).length;
  const pendingSlots = count('pending', 'running');
  const next = campaign.slots.find((s) => s.status === 'pending' || s.status === 'running');
  const { budget } = campaign;
  const outstanding = pendingSlots * campaign.locations.length * budget.costPerRequest;

  return {
    state,
    reason,
    mode: campaign.mode,
    modeLabel: modeLabel(campaign.mode),
    modeReason: campaign.modeReason,
    campaign: {
      id: String(campaign._id),
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      timezone: TIMEZONE,
      slotTimes: campaign.slotTimes,
      maxSlots: campaign.maxSlots,
      slotsCompleted: count('completed', 'partial'),
      slotsMissed: count('missed'),
      slotsSkipped: count('skipped_budget'),
      slotsRemaining: pendingSlots,
      nextSlotAt: state === 'ended' ? null : dhakaIso(next?.scheduledAt),
      lastRefreshAt: dhakaIso(campaign.lastRefreshAt),
    },
    budget: {
      remaining: budget.remaining,
      reserve: budget.reserve,
      usedByCampaign: budget.usedByCampaign,
      costPerRequest: budget.costPerRequest,
      locationCount: campaign.locations.length,
      projectedCampaignCost: budget.usedByCampaign + outstanding,
      projectedRemainingAfterCampaign: budget.remaining - outstanding,
      updatedAt: dhakaIso(budget.updatedAt),
      source: budget.source,
    },
    rateLimit,
    limitations: LIMITATIONS,
  };
}

function summaryItem(location, good, bad, nowMs, staleMs) {
  const item = {
    id: location.id,
    kind: location.kind,
    name: location.name ?? null,
    lat: location.lat,
    lon: location.lon,
    radiusKm: location.radiusKm,
    state: 'not-checked',
    count: null,
    cloudToGround: null,
    intracloud: null,
    window: null,
    sampledAt: null,
    slotId: null,
    detail: null,
  };

  const fill = (sample) => {
    item.sampledAt = dhakaIso(sample.sampledAt);
    item.slotId = sample.slotId;
    item.detail = sample.detail ?? null;
  };

  if (good) {
    fill(good);
    item.state = nowMs - good.sampledAt.getTime() > staleMs ? 'stale' : good.state;
    item.count = good.count ?? null;
    item.cloudToGround = good.cloudToGround ?? null;
    item.intracloud = good.intracloud ?? null;
    item.window = good.window?.from ? { from: dhakaIso(good.window.from), to: dhakaIso(good.window.to) } : null;
    if (item.state === 'stale') item.detail = [item.detail, 'This is the latest successful sample and it is out of date.'].filter(Boolean).join(' ');
    if (bad && bad.sampledAt > good.sampledAt) item.detail = [item.detail, `A later attempt failed: ${bad.detail ?? 'unavailable'}`].filter(Boolean).join(' ');
  } else if (bad) {
    fill(bad);
    item.state = 'unavailable';
  }
  return item;
}

async function latestSamples(campaignId) {
  const latest = (match) => LightningSample.aggregate([
    { $match: { campaignId, ...match } },
    { $sort: { sampledAt: -1 } },
    { $group: { _id: '$locationId', sample: { $first: '$$ROOT' } } },
  ]);
  const [goodRows, badRows] = await Promise.all([
    latest({ status: 'done', state: { $in: ['reported', 'none'] } }),
    latest({ state: 'unavailable', sampledAt: { $ne: null } }),
  ]);
  return {
    good: new Map(goodRows.map((row) => [row._id, row.sample])),
    bad: new Map(badRows.map((row) => [row._id, row.sample])),
  };
}

export async function buildSummaries({ config = env, now = () => new Date(), geo = loadGeoData() } = {}) {
  const nowDate = now();
  const campaign = await findCampaign();
  const plan = campaign ? null : planFromConfig(config, nowDate, geo);
  const locations = campaign ? campaign.locations : plan.locations;
  const staleAfterMinutes = SLOT_INTERVAL_MINUTES + config.lightning.graceMinutes;
  const { good, bad } = campaign ? await latestSamples(campaign._id) : { good: new Map(), bad: new Map() };

  return {
    mode: campaign ? campaign.mode : plan.mode,
    items: locations.map((l) => summaryItem(l, good.get(l.id), bad.get(l.id), nowDate.getTime(), staleAfterMinutes * 60_000)),
    latestRefreshAt: dhakaIso(campaign?.lastRefreshAt),
    staleAfterMinutes,
  };
}

// Returns null for an unknown location. Circle summaries are listed as circle-wide aggregates, never as upazila counts.
export async function buildUpazilaSummaries(pcode, options = {}) {
  const geo = options.geo ?? loadGeoData();
  const location = geo.locationsByPcode.get(pcode);
  if (!location) return null;

  const summaries = await buildSummaries({ ...options, geo });
  let items;
  let note;

  if (summaries.mode === 'B') {
    items = summaries.items.filter((i) => haversineKm(location.lat, location.lon, i.lat, i.lon) <= i.radiusKm);
    note = items.length
      ? `Lightning near this location: the listed ${items[0].radiusKm} km-radius circle summaries are circle-wide totals, not counts inside ${location.name}. Overlapping circles can include the same events and must not be summed.`
      : `No ${geo.apiRadiusKm} km search circle is centred within range of ${location.name}.`;
  } else {
    items = location.pid ? summaries.items.filter((i) => i.id === location.pid) : [];
    note = items.length
      ? `Lightning near this upazila: a ${items[0].radiusKm} km-radius summary around its representative point, not a count inside its boundary.`
      : `${location.name} has no upazila-location summary (it is a city thana or has no upazila point), so nothing is attached to it.`;
  }

  return { pcode, name: location.name, mode: summaries.mode, items, note };
}

// ---------- collection (job side) ----------
const defaultSleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function backoffMs(attempt, result) {
  if (result.class === 'rate-limit') {
    const retryAfter = result.headers.retryAfterSeconds;
    return Math.min(60_000, retryAfter ? retryAfter * 1000 : 5_000 * 2 ** (attempt - 1));
  }
  return 2_000 * 2 ** (attempt - 1);
}

function sampleFields(result, requestedAt) {
  const fields = {
    sampledAt: requestedAt,
    window: { from: new Date(requestedAt.getTime() - SAMPLE_WINDOW_MS), to: requestedAt },
    httpStatus: result.httpStatus,
    cost: result.headers.cost,
    warningCode: result.code && /^warn/i.test(result.code) ? result.code : null,
    errorClass: null,
    count: null,
    cloudToGround: null,
    intracloud: null,
    detail: null,
  };

  if (result.class === 'ok') {
    const s = result.summary;
    return {
      ...fields, status: 'done', state: s.count === 0 ? 'none' : 'reported',
      count: s.count, cloudToGround: s.cloudToGround, intracloud: s.intracloud, detail: s.detail,
    };
  }
  if (result.class === 'no-data') {
    return { ...fields, status: 'done', state: 'none', count: 0, detail: 'No lightning matched the search in the sampled window.' };
  }
  if (DONE_CLASSES.has(result.class)) {
    return { ...fields, status: 'done', state: 'unavailable', errorClass: result.class, detail: result.message };
  }
  return { ...fields, status: 'failed', state: 'unavailable', errorClass: result.class, detail: result.message };
}

export function createLightningService({
  client = createXweatherClient(),
  config = env,
  now = () => new Date(),
  sleep = defaultSleep,
  geo = loadGeoData(),
  log = console,
} = {}) {
  const rate = { perMinute: config.xweather.requestsPerMinute };
  let nextRequestAt = 0;
  let warnedNoCredentials = false;

  const lease = (from) => new Date(from.getTime() + LEASE_MS);

  async function throttle(signal) {
    const start = Math.max(now().getTime(), nextRequestAt);
    nextRequestAt = start + 60_000 / rate.perMinute;
    const delay = start - now().getTime();
    if (delay > 0) await sleep(delay, signal);
  }

  async function init() {
    await Promise.all([LightningCampaign.init(), LightningSample.init()]);
  }

  async function ensureCampaign() {
    const existing = await LightningCampaign.findOne({ key: CAMPAIGN_KEY }).lean();
    if (existing) return { campaign: existing };

    const nowDate = now();
    const today = dhakaDate(nowDate);
    const startDate = config.lightning.campaignStart || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('LIGHTNING_CAMPAIGN_START must be YYYY-MM-DD.');

    const endDate = addDays(startDate, config.lightning.campaignDays - 1);
    if (startDate > today) return { notStarted: true, startsAt: dhakaWallTime(startDate, '00:00') };
    if (today > endDate) return { ended: true };

    const slots = planSlots({
      now: nowDate,
      startDate,
      days: config.lightning.campaignDays,
      maxSlots: config.lightning.maxSlots,
      graceMinutes: config.lightning.graceMinutes,
    });
    const costPerRequest = config.xweather.assumedCostPerRequest;
    // Decided on the nominal slot count of the whole window (not the slots left on day one), so the choice
    // doesn't depend on what time of day the first run happens.
    const choice = chooseMode({
      upazilaCount: geo.upazilas.length,
      slots: plannedSlotCount({ days: config.lightning.campaignDays, maxSlots: config.lightning.maxSlots }),
      costPerRequest,
      remaining: config.xweather.budgetRemaining,
      reserve: config.xweather.budgetReserve,
    });

    try {
      const created = await LightningCampaign.create({
        key: CAMPAIGN_KEY,
        startDate,
        endDate,
        timezone: TIMEZONE,
        slotTimes: SLOT_TIMES,
        maxSlots: config.lightning.maxSlots,
        graceMinutes: config.lightning.graceMinutes,
        mode: choice.mode,
        modeReason: choice.reason,
        locations: choice.mode === 'A' ? upazilaLocations(geo) : circleLocations(geo),
        slots,
        budget: {
          remaining: config.xweather.budgetRemaining,
          reserve: config.xweather.budgetReserve,
          usedByCampaign: 0,
          costPerRequest,
          source: 'config',
          updatedAt: nowDate,
        },
        rateLimit: { perMinute: rate.perMinute, remainingMinute: null },
      });
      log.log(`[lightning] campaign ${startDate}..${endDate} created: ${choice.reason}`);
      return { campaign: created.toObject() };
    } catch (error) {
      if (error?.code === 11000) return { campaign: await LightningCampaign.findOne({ key: CAMPAIGN_KEY }).lean() };
      throw error;
    }
  }

  // The unique (campaign, slot, location) index makes this the single gate in front of every API call.
  async function claimSample({ campaignId, slotId, locationId }) {
    const nowDate = now();
    const claimed = await LightningSample.findOneAndUpdate(
      {
        campaignId,
        slotId,
        locationId,
        attempts: { $lt: MAX_ATTEMPTS },
        $or: [{ status: 'failed' }, { status: 'claimed', leaseUntil: { $lt: nowDate } }],
      },
      { $set: { status: 'claimed', claimedAt: nowDate, leaseUntil: lease(nowDate) }, $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (claimed) return claimed;

    try {
      return await LightningSample.create({
        campaignId, slotId, locationId, status: 'claimed', attempts: 1, claimedAt: nowDate, leaseUntil: lease(nowDate),
      });
    } catch (error) {
      if (error?.code === 11000) return null; // already done, exhausted, or held by another worker
      throw error;
    }
  }

  // Atomically takes the cost of one request out of the budget; fails if that would dip into the reserve.
  function reserveBudget(campaignId, costPerRequest, reserve) {
    return LightningCampaign.findOneAndUpdate(
      { _id: campaignId, 'budget.remaining': { $gte: reserve + costPerRequest } },
      {
        $inc: { 'budget.remaining': -costPerRequest, 'budget.usedByCampaign': costPerRequest },
        $set: { 'budget.updatedAt': now() },
      },
      { returnDocument: 'after' },
    );
  }

  async function settle(ctx, claim, result, requestedAt, reservedCost) {
    const { headers } = result;
    const actualCost = headers.cost ?? reservedCost;
    const delta = actualCost - reservedCost;
    const set = { 'budget.updatedAt': now() };
    const inc = {};

    if (headers.remainingPeriod !== null) {
      set['budget.remaining'] = headers.remainingPeriod;
      set['budget.source'] = 'headers';
    } else if (delta !== 0) {
      inc['budget.remaining'] = -delta;
    }
    if (delta !== 0) inc['budget.usedByCampaign'] = delta;

    // Only a successful response is allowed to change the per-request cost used for projections.
    if (result.httpStatus === 200 && headers.cost !== null && headers.cost !== ctx.cost) {
      set['budget.costPerRequest'] = headers.cost;
      log.log(`[lightning] observed cost per request is now ${headers.cost}`);
      ctx.cost = headers.cost;
    }
    if (headers.limitMinute !== null) {
      rate.perMinute = Math.max(1, Math.min(config.xweather.requestsPerMinute, Math.floor(headers.limitMinute * 0.8)));
      set['rateLimit.perMinute'] = rate.perMinute;
    }
    if (headers.remainingMinute !== null) set['rateLimit.remainingMinute'] = headers.remainingMinute;

    const update = { $set: set };
    if (Object.keys(inc).length) update.$inc = inc;
    await LightningCampaign.updateOne({ _id: ctx.campaignId }, update);
    await LightningSample.updateOne({ _id: claim._id }, { $set: sampleFields(result, requestedAt) });
  }

  async function processLocation(ctx, location) {
    while (!ctx.abort && !ctx.signal?.aborted) {
      const claim = await claimSample({ campaignId: ctx.campaignId, slotId: ctx.slotId, locationId: location.id });
      if (!claim) return;

      // Captured before any await: another worker may change ctx.cost while this request is in flight.
      const reservedCost = ctx.cost;
      const reserved = await reserveBudget(ctx.campaignId, reservedCost, ctx.reserve);
      if (!reserved) {
        await LightningSample.updateOne({ _id: claim._id }, {
          $set: { status: 'skipped_budget', state: 'unavailable', detail: 'Skipped: the remaining budget would fall below the reserve.' },
        });
        ctx.abort = { type: 'budget', reason: 'The remaining access budget would fall below the reserve, so collection for this refresh stopped.' };
        return;
      }

      await throttle(ctx.signal);
      const requestedAt = now();
      const result = await client.fetchSummary({ lat: location.lat, lon: location.lon, radiusKm: location.radiusKm });
      await settle(ctx, claim, result, requestedAt, reservedCost);

      if (DONE_CLASSES.has(result.class)) return;
      if (result.class === 'auth') {
        ctx.abort = { type: 'auth', reason: 'Xweather rejected the credentials or the subscription. Collection stopped; no further requests will be made.' };
        return;
      }
      if (result.class === 'quota') {
        ctx.abort = { type: 'quota', reason: 'Xweather reports that its access quota is exhausted.' };
        return;
      }
      if (claim.attempts >= MAX_ATTEMPTS) return; // retries exhausted; the sample stays failed/unavailable
      await sleep(backoffMs(claim.attempts, result), ctx.signal);
    }
  }

  async function finishSlot(ctx, status, reason, extra = {}) {
    const counts = await LightningSample.aggregate([
      { $match: { campaignId: ctx.campaignId, slotId: ctx.slotId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const done = counts.find((c) => c._id === 'done')?.n ?? 0;
    const failed = counts.filter((c) => c._id !== 'done').reduce((sum, c) => sum + c.n, 0);
    const finishedAt = now();

    const set = {
      'slots.$.status': status,
      'slots.$.finishedAt': finishedAt,
      'slots.$.leaseUntil': null,
      'slots.$.reason': reason,
      'slots.$.done': done,
      'slots.$.failed': failed,
      'slots.$.total': ctx.total,
      ...extra,
    };
    if (done > 0) set.lastRefreshAt = finishedAt;
    await LightningCampaign.updateOne({ _id: ctx.campaignId, 'slots.slotId': ctx.slotId }, { $set: set });
    log.log(`[lightning] slot ${ctx.slotId}: ${status} (${done}/${ctx.total} locations)${reason ? ` - ${reason}` : ''}`);
  }

  async function runSlot(campaign, slot, signal) {
    const nowDate = now();
    const claimFilter = {
      _id: campaign._id,
      slots: { $elemMatch: { slotId: slot.slotId, $or: [{ status: 'pending' }, { status: 'running', leaseUntil: { $lt: nowDate } }] } },
    };
    const set = { 'slots.$.status': 'running', 'slots.$.leaseUntil': lease(nowDate) };
    if (!slot.startedAt) set['slots.$.startedAt'] = nowDate;
    const claimed = await LightningCampaign.findOneAndUpdate(claimFilter, { $set: set }, { returnDocument: 'after' });
    if (!claimed) return; // another worker owns this slot
    const started = claimed.toObject();

    const existing = await LightningSample.find({ campaignId: campaign._id, slotId: slot.slotId }, 'locationId status attempts').lean();
    const byLocation = new Map(existing.map((s) => [s.locationId, s]));
    const todo = started.locations.filter((location) => {
      const sample = byLocation.get(location.id);
      if (!sample) return true;
      if (sample.status === 'done' || sample.status === 'skipped_budget') return false;
      return sample.attempts < MAX_ATTEMPTS;
    });

    const ctx = {
      campaignId: campaign._id,
      slotId: slot.slotId,
      total: started.locations.length,
      cost: started.budget.costPerRequest,
      reserve: started.budget.reserve,
      queue: [...todo],
      abort: null,
      signal,
    };

    const needed = todo.length * ctx.cost;
    if (started.budget.remaining - ctx.reserve < needed) {
      await finishSlot(ctx, 'skipped_budget',
        `Needs ${format(needed)} accesses but only ${format(Math.max(0, started.budget.remaining - ctx.reserve))} remain above the ${format(ctx.reserve)}-access reserve; cached results are kept.`);
      return;
    }

    const worker = async () => {
      while (!ctx.abort && !signal?.aborted) {
        const location = ctx.queue.shift();
        if (!location) return;
        await processLocation(ctx, location);
        await LightningCampaign.updateOne({ _id: ctx.campaignId, 'slots.slotId': ctx.slotId }, { $set: { 'slots.$.leaseUntil': lease(now()) } });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

    if (signal?.aborted && !ctx.abort) {
      // Shutting down mid-slot: release the lease so a restart resumes it without repeating finished locations.
      await LightningCampaign.updateOne({ _id: ctx.campaignId, 'slots.slotId': ctx.slotId }, { $set: { 'slots.$.leaseUntil': now() } });
      return;
    }

    if (ctx.abort?.type === 'auth') {
      await finishSlot(ctx, 'partial', ctx.abort.reason, { haltedReason: ctx.abort.reason });
    } else if (ctx.abort?.type === 'quota') {
      await finishSlot(ctx, 'skipped_budget', ctx.abort.reason, { 'budget.remaining': 0 });
    } else if (ctx.abort) {
      await finishSlot(ctx, 'skipped_budget', ctx.abort.reason);
    } else {
      const unfinished = await LightningSample.countDocuments({ campaignId: ctx.campaignId, slotId: ctx.slotId, status: { $ne: 'done' } });
      const missing = ctx.total - (await LightningSample.countDocuments({ campaignId: ctx.campaignId, slotId: ctx.slotId }));
      if (unfinished + missing === 0) await finishSlot(ctx, 'completed', null);
      else await finishSlot(ctx, 'partial', `${unfinished + missing} location(s) were unavailable after bounded retries.`);
    }
  }

  async function closeLateSlot(campaign, slot) {
    const interrupted = slot.status === 'running';
    await LightningCampaign.updateOne(
      { _id: campaign._id, 'slots.slotId': slot.slotId },
      {
        $set: {
          'slots.$.status': interrupted ? 'partial' : 'missed',
          'slots.$.finishedAt': now(),
          'slots.$.leaseUntil': null,
          'slots.$.reason': interrupted
            ? 'Interrupted, and the grace period passed before it could resume.'
            : 'Not run within the grace period of its scheduled time.',
        },
      },
    );
    log.log(`[lightning] slot ${slot.slotId}: ${interrupted ? 'partial' : 'missed'} (grace period elapsed)`);
  }

  // One scheduling decision: returns how long the job should wait, or null when collection is over.
  async function advance(campaign, signal) {
    const nowMs = now().getTime();
    const graceMs = campaign.graceMinutes * 60_000;

    for (const slot of campaign.slots) {
      if (TERMINAL_SLOTS.has(slot.status)) continue;
      const scheduled = slot.scheduledAt.getTime();

      if (scheduled > nowMs) return { type: 'wait', ms: Math.min(scheduled - nowMs, 15 * 60_000) };
      if (slot.status === 'running' && slot.leaseUntil && slot.leaseUntil.getTime() > nowMs) return { type: 'wait', ms: 30_000 };
      if (nowMs > scheduled + graceMs) {
        await closeLateSlot(campaign, slot);
        return { type: 'progress' };
      }

      await runSlot(campaign, slot, signal);
      return signal?.aborted ? { type: 'wait', ms: null } : { type: 'progress' };
    }
    return { type: 'finished' };
  }

  async function tick({ signal } = {}) {
    if (!config.lightning.enabled) return { waitMs: null };
    if (!client.hasCredentials()) {
      if (!warnedNoCredentials) log.log('[lightning] Xweather credentials are not configured; collection is idle.');
      warnedNoCredentials = true;
      return { waitMs: HOUR_MS };
    }

    const created = await ensureCampaign();
    if (created.notStarted) return { waitMs: Math.min(Math.max(created.startsAt.getTime() - now().getTime(), 1_000), HOUR_MS) };
    if (created.ended) return { waitMs: null };

    for (let step = 0; step < 100; step++) {
      if (signal?.aborted) return { waitMs: null };
      const campaign = await LightningCampaign.findById(created.campaign._id).lean();
      if (campaign.haltedReason) return { waitMs: null };

      const outcome = await advance(campaign, signal);
      if (outcome.type === 'wait') return { waitMs: outcome.ms };
      if (outcome.type === 'finished') return { waitMs: null };
    }
    return { waitMs: 1_000 };
  }

  return { init, ensureCampaign, claimSample, runSlot, tick, redact: (text) => redactSecrets(text, config.xweather) };
}
