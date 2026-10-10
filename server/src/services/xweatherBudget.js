import { env } from '../config/env.js';
import { JobState } from '../models/JobState.js';
import { LightningCampaign } from '../models/LightningCampaign.js';
import { dhakaDate } from './time.js';

// The token governor (ALERT_ENGINE_PLAN.md section 14.4). The Xweather allowance (about 15,000 per period) is shared with the lightning
// campaign, and strikes and threats cost 10 tokens each, so every alert-engine request is reserved here first.
//
//   usable = remaining - reserve - what the lightning campaign still needs
//   perDay = usable / days until the allowance resets   (unspent budget automatically raises the later days)
//
// A request is refused when it would dip into the reserve, push the day past 1.5 x the daily average, or push one class past twice its
// share of that. Once the day is past its average, only the highest-priority classes may still spend.
const DAY_MS = 86_400_000;
export const BURST = 1.5;
export const CLASS_BURST = 2;
const KEY = 'xweather-budget';

// priority 1 is served first when the budget is tight.
export const CLASSES = {
  lightning_probe: { priority: 1, share: 0.25 },
  forecast: { priority: 2, share: 0.25 },
  maritime: { priority: 3, share: 0.1 },
  lightning_threats: { priority: 4, share: 0.2 },
  lightning_strikes: { priority: 5, share: 0.2 },
};
const TIGHT_PRIORITY = 2;

export function nextReset(resetAt, periodDays, nowMs) {
  let at = Date.parse(resetAt);
  if (Number.isNaN(at)) at = nowMs + periodDays * DAY_MS;
  while (at <= nowMs) at += periodDays * DAY_MS;
  return at;
}

export const daysUntil = (resetMs, nowMs) => Math.max(1, Math.ceil((resetMs - nowMs) / DAY_MS));

const sumOf = (record = {}) => Object.values(record).reduce((total, value) => total + (Number(value) || 0), 0);

// What the lightning campaign still has to spend on its remaining slots (0 once it has ended or been halted).
async function campaignOutstanding() {
  const campaign = await LightningCampaign.findOne({ key: 'lightning' }).lean();
  if (!campaign || campaign.haltedReason) return { outstanding: 0, remaining: null, at: null };
  const pending = campaign.slots.filter((slot) => slot.status === 'pending' || slot.status === 'running').length;
  return {
    outstanding: pending * campaign.locations.length * campaign.budget.costPerRequest,
    remaining: campaign.budget.source === 'headers' ? campaign.budget.remaining : null,
    at: campaign.budget.updatedAt ?? null,
  };
}

export function createXweatherBudget({ config = env.xweather, now = () => new Date(), pacing = true } = {}) {
  let nextRequestAt = 0;

  async function readState() {
    return (await JobState.findOne({ key: KEY }).lean()) ?? { detail: {} };
  }

  async function figures() {
    const nowMs = now().getTime();
    const state = await readState();
    const known = state.detail?.lastKnown ?? null;
    const campaign = await campaignOutstanding();

    // The most conservative observed value wins; the configured figure is only a starting point.
    const observed = [];
    if (known && Number.isFinite(known.remaining)) observed.push({ value: known.remaining, source: 'headers', at: known.at });
    if (campaign.remaining !== null) observed.push({ value: campaign.remaining, source: 'campaign', at: campaign.at });
    observed.sort((a, b) => a.value - b.value);
    const remaining = observed[0]?.value ?? config.budgetRemaining;
    const remainingSource = observed[0]?.source ?? 'config';

    const resetMs = nextReset(config.periodReset, config.periodDays, nowMs);
    const usable = Math.max(0, remaining - config.budgetReserve - campaign.outstanding);
    const daysLeft = daysUntil(resetMs, nowMs);
    const ledger = state.detail?.ledger ?? {};
    const today = ledger[dhakaDate(new Date(nowMs))] ?? {};
    const monthly = {};
    for (const day of Object.values(ledger)) for (const [cls, tokens] of Object.entries(day)) monthly[cls] = (monthly[cls] ?? 0) + tokens;

    return {
      remaining,
      remainingSource,
      reserve: config.budgetReserve,
      campaignOutstanding: campaign.outstanding,
      usable,
      resetAt: new Date(resetMs).toISOString(),
      daysLeft,
      perDay: usable / daysLeft,
      spentToday: { ...today, total: sumOf(today) },
      spentRecent: { ...monthly, total: sumOf(monthly) },
      lastKnownAt: known?.at ?? null,
      perMinute: config.requestsPerMinute,
    };
  }

  // Would this request be allowed? (No side effects.)
  async function check(cls, cost) {
    const rule = CLASSES[cls];
    if (!rule) throw new Error(`Unknown Xweather request class: ${cls}`);
    const f = await figures();
    const base = { ...f, class: cls, cost };
    if (cost > f.usable) return { ...base, ok: false, reason: 'reserve' };

    const classToday = f.spentToday[cls] ?? 0;
    if (f.spentToday.total + cost > f.perDay * BURST) return { ...base, ok: false, reason: 'daily-limit' };
    if (classToday + cost > f.perDay * rule.share * CLASS_BURST) return { ...base, ok: false, reason: 'class-limit' };
    if (f.spentToday.total + cost > f.perDay && rule.priority > TIGHT_PRIORITY) return { ...base, ok: false, reason: 'priority' };
    return { ...base, ok: true, reason: null };
  }

  // Check, then count the spend (before the request, so a crash can never leave it unrecorded). `cost` is the expected cost.
  async function reserve(cls, cost) {
    const decision = await check(cls, cost);
    if (!decision.ok) return decision;
    const day = dhakaDate(now());
    await JobState.updateOne({ key: KEY }, { $inc: { [`detail.ledger.${day}.${cls}`]: cost } }, { upsert: true });
    return decision;
  }

  // After the response: correct the ledger to the real cost and keep the remaining allowance the headers reported.
  async function settle({ cls, reserved, headers }) {
    const at = now();
    const set = {};
    const inc = {};
    if (headers?.cost !== null && headers?.cost !== undefined && headers.cost !== reserved) {
      inc[`detail.ledger.${dhakaDate(at)}.${cls}`] = headers.cost - reserved;
    }
    if (headers?.remainingPeriod !== null && headers?.remainingPeriod !== undefined) {
      set['detail.lastKnown'] = { remaining: headers.remainingPeriod, remainingMinute: headers.remainingMinute ?? null, at };
    }
    if (!Object.keys(set).length && !Object.keys(inc).length) return;
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(inc).length) update.$inc = inc;
    await JobState.updateOne({ key: KEY }, update, { upsert: true });
  }

  // An exhausted allowance reported by Xweather itself: nothing more is spent until the next period.
  async function markExhausted() {
    await JobState.updateOne(
      { key: KEY },
      { $set: { 'detail.lastKnown': { remaining: 0, remainingMinute: null, at: now() } } },
      { upsert: true },
    );
  }

  // Keeps requests under the per-minute limit (80 % of it, like the lightning campaign).
  async function pace(sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); })) {
    if (!pacing) return;
    const spacing = 60_000 / Math.max(1, Math.floor(config.requestsPerMinute * 0.8));
    const wait = nextRequestAt - Date.now();
    nextRequestAt = Math.max(Date.now(), nextRequestAt) + spacing;
    if (wait > 0) await sleep(wait);
  }

  return { check, reserve, settle, markExhausted, pace, summary: figures };
}
