import { SEVERITY_RANK } from '../../config/alertConstants.js';
import { notifyRules } from '../../config/alertRules.js';
import { env } from '../../config/env.js';
import { Notification } from '../../models/Notification.js';
import { dhakaDate, dhakaWallTime } from '../time.js';
import { composeAdminMessage, composeNotification } from './compose.js';
import { metricsChanged } from './events.js';
import { findRecipients } from './recipients.js';
import { evaluateSubscriber, scenariosFor } from './scenarios/index.js';

// Stage 4: compose, de-duplicate, publish and store. The unique index (subscriber, event, scenario) is the de-duplication key:
// create once, update when the evidence or severity materially changes, re-notify only under the escalation rules.
const DAY_MS = 86_400_000;
const FINAL = new Set(['expired', 'withdrawn', 'discarded', 'expired_unsent']);
const CHUNK = 500;

const purgeAfter = (validUntil) => new Date(+new Date(validUntil) + notifyRules.purgeAfterDays * DAY_MS);

// Fields rewritten when a notification changes. Identity (subscriber, event, scenario), creation time and read state are never touched here.
const CONTENT_FIELDS = [
  'severity', 'title', 'message', 'recommendedActions', 'lang', 'templateKey', 'params', 'affectedArea', 'sourceReferences',
  'reasonForSelection', 'evidence', 'hazardType', 'hazardLevel', 'validFrom', 'validUntil', 'dataStatus', 'ruleVersion', 'ruleStatus',
];

function pickContent(content) {
  const picked = Object.fromEntries(CONTENT_FIELDS.map((field) => [field, content[field]]));
  picked.purgeAfter = purgeAfter(content.validUntil);
  return picked;
}

const sameInstant = (a, b) => +new Date(a) === +new Date(b);

// Any visible difference at all (a silent refresh), as opposed to a material one.
function differs(existing, content) {
  return existing.message !== content.message
    || existing.title !== content.title
    || existing.reasonForSelection !== content.reasonForSelection
    || existing.severity !== content.severity
    || !sameInstant(existing.validFrom, content.validFrom)
    || !sameInstant(existing.validUntil, content.validUntil)
    || JSON.stringify(existing.evidence ?? null) !== JSON.stringify(content.evidence ?? null);
}

export function isMaterial(existing, content) {
  return existing.severity !== content.severity
    || existing.hazardLevel !== content.hazardLevel
    || existing.dataStatus !== content.dataStatus
    || Math.abs(+new Date(existing.validUntil) - +new Date(content.validUntil)) > notifyRules.materialValidityExtensionMs
    || metricsChanged(existing.evidence?.metrics, content.evidence?.metrics);
}

async function writeOps(ops) {
  for (let i = 0; i < ops.length; i += CHUNK) {
    try {
      await Notification.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    } catch (error) {
      // A duplicate insert means another pass already created that notification: that is the idempotency guarantee, not a failure.
      const errors = error?.writeErrors ?? error?.results ?? [];
      const onlyDuplicates = error?.code === 11000 || (errors.length > 0 && errors.every((item) => (item.code ?? item.err?.code) === 11000));
      if (!onlyDuplicates) throw error;
    }
  }
}

// Advisories already sent today per subscriber, for the daily cap. Counted by when they were published (held drafts do not count).
async function advisoryCounts(subscriberIds, nowMs) {
  const dayStart = dhakaWallTime(dhakaDate(new Date(nowMs)), '00:00');
  const rows = await Notification.aggregate([
    { $match: { subscriberId: { $in: subscriberIds }, severity: 'ADVISORY', origin: 'automatic', status: { $ne: 'discarded' }, publishedAt: { $gte: dayStart } } },
    { $group: { _id: '$subscriberId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.n]));
}

function groupKey(subscriber, scenarioId, content) {
  const where = content.affectedArea.upazilaPcode ?? content.affectedArea.districtPcode ?? content.affectedArea.name;
  return `${subscriber.occupation}|${scenarioId}|${content.affectedArea.scope}:${where}`;
}

function newGroup(subscriber, scenarioId, content, sample) {
  return {
    occupation: subscriber.occupation,
    scenarioId,
    hazardType: content.hazardType,
    level: content.hazardLevel,
    severity: content.severity,
    affectedArea: { scope: content.affectedArea.scope, name: content.affectedArea.name, nameBn: content.affectedArea.nameBn, upazilaPcode: content.affectedArea.upazilaPcode, districtPcode: content.affectedArea.districtPcode },
    dataStatus: content.dataStatus,
    recipients: 0,
    newCount: 0,
    alreadySent: 0,
    updated: 0,
    held: 0,
    released: 0,
    capped: 0,
    sample,
  };
}

// Evaluates one event against its recipients and creates / updates / releases their notifications.
// dryRun reports what would happen without writing anything (the administrator's preview).
export async function applyEvent(event, {
  nowMs = Date.now(), settings, roles = null, audience = 'all', areaCodes = null, subscriberIds = null,
  dryRun = false, publishNow = false, bypassCap = false, publishedBy = 'engine', batchId = null,
} = {}) {
  const recipients = await findRecipients(event, { roles, audience, nowMs, areaCodes, subscriberIds });
  const summary = { recipients: recipients.length, inserted: 0, updated: 0, escalated: 0, released: 0, refreshed: 0, unchanged: 0, skippedCap: 0, held: 0, groups: [] };
  if (!recipients.length) return summary;

  const ids = recipients.map((subscriber) => subscriber._id);
  const existingRows = await Notification.find({ hazardEventId: event._id, subscriberId: { $in: ids } }).lean();
  const existing = new Map(existingRows.map((row) => [`${row.subscriberId}:${row.scenarioId}`, row]));
  // Scenarios marked oncePerHazard (VEND-03) send one card per person for one hazard, even when it reaches several of their areas as
  // separate events: a live card from another event whose validity overlaps this one already covers it.
  const onceIds = scenariosFor(event.hazardType).filter((scenario) => scenario.oncePerHazard).map((scenario) => scenario.id);
  const siblingRows = onceIds.length ? await Notification.find({
    subscriberId: { $in: ids },
    scenarioId: { $in: onceIds },
    hazardType: event.hazardType,
    hazardEventId: { $ne: event._id },
    status: { $in: ['active', 'draft'] },
    validUntil: { $gt: new Date(Math.max(nowMs, +new Date(event.validFrom))) },
    validFrom: { $lt: new Date(event.validUntil) },
  }, { subscriberId: 1, scenarioId: 1 }).lean() : [];
  const covered = new Set(siblingRows.map((row) => `${row.subscriberId}:${row.scenarioId}`));
  const caps = bypassCap || dryRun ? new Map() : await advisoryCounts(ids, nowMs);
  const groups = new Map();
  const ops = [];
  const now = new Date(nowMs);

  for (const subscriber of recipients) {
    for (const { scenario, area, result } of evaluateSubscriber({ subscriber, event, nowMs })) {
      if (areaCodes?.length && !areaCodes.includes(area.upazilaPcode) && !areaCodes.includes(area.districtPcode)) continue;

      const content = composeNotification({ scenarioId: scenario.id, result, event, subscriber, area, nowMs });
      const key = groupKey(subscriber, scenario.id, content);
      let group = groups.get(key);
      if (!group) {
        const sample = dryRun
          ? { en: composeNotification({ scenarioId: scenario.id, result, event, subscriber, area, nowMs, lang: 'en' }), bn: composeNotification({ scenarioId: scenario.id, result, event, subscriber, area, nowMs, lang: 'bn' }) }
          : null;
        group = newGroup(subscriber, scenario.id, content, sample);
        groups.set(key, group);
      }
      group.recipients += 1;
      group.severity = SEVERITY_RANK[content.severity] > SEVERITY_RANK[group.severity] ? content.severity : group.severity;

      const current = existing.get(`${subscriber._id}:${scenario.id}`);
      const holding = settings?.hold?.[content.severity] === true && !publishNow;

      // ----- nothing yet: create it -----
      if (!current) {
        if (['STALE', 'UNAVAILABLE'].includes(event.dataStatus)) continue;
        if (covered.has(`${subscriber._id}:${scenario.id}`)) { group.alreadySent += 1; summary.unchanged += 1; continue; }
        if (content.severity === 'ADVISORY' && !bypassCap && !dryRun) {
          const today = caps.get(String(subscriber._id)) ?? 0;
          if (today >= env.alerts.dailyAdvisoryCap) { group.capped += 1; summary.skippedCap += 1; continue; }
          caps.set(String(subscriber._id), today + 1);
        }
        if (holding) { group.held += 1; summary.held += 1; } else group.newCount += 1;
        summary.inserted += 1;
        if (dryRun) continue;
        ops.push({
          insertOne: {
            document: {
              ...content,
              subscriberId: subscriber._id,
              occupation: subscriber.occupation,
              hazardEventId: event._id,
              isDemo: Boolean(subscriber.isDemo || event.isDemo),
              status: holding ? 'draft' : 'active',
              publishedAt: holding ? null : now,
              publishedBy: holding ? null : publishedBy,
              batchId,
              readAt: null,
              revision: 1,
              // Someone who joins an episode that has already re-notified starts at its current stage: the next tick must not re-flag the card as new.
              renotifications: Math.min(Number(event.evidence?.renotifyStage ?? 0) || 0, notifyRules.lightningMaxRenotifications),
              lifecycle: [{ at: now, type: 'created', note: holding ? 'Prepared; waiting for the administrator.' : (publishedBy === 'admin' ? 'Sent by the administrator.' : 'Sent automatically.') }],
              purgeAfter: purgeAfter(content.validUntil),
            },
          },
        });
        continue;
      }

      // ----- finished notifications are never resurrected -----
      if (FINAL.has(current.status) && !(current.status === 'withdrawn' && current.withdrawalReason === 'location-changed')) {
        summary.unchanged += 1;
        continue;
      }

      // Coming back during the same event reuses the original notification (unique subscriber/event/rule key).
      // Do not resend an already delivered external notification for the same stage.
      if (current.status === 'withdrawn') {
        if (['STALE', 'UNAVAILABLE'].includes(event.dataStatus)) { summary.unchanged += 1; continue; }
        summary.updated += 1;
        if (!dryRun) ops.push({ updateOne: { filter: { _id: current._id, status: 'withdrawn', withdrawalReason: 'location-changed' }, update: {
          $set: { ...pickContent(content), status: 'active', withdrawalReason: null, reasonForSelection: content.reasonForSelection },
          $push: { lifecycle: { $each: [{ at: now, type: 'updated', note: 'The current area matches this alert again.' }], $slice: -20 } },
        } } });
        continue;
      }

      const set = {};
      const push = [];
      const inc = {};
      let touched = false;

      // An administrator "send now" releases a held notification.
      if (current.status === 'draft' && publishNow) {
        Object.assign(set, { status: 'active', publishedAt: now, publishedBy: 'admin', readAt: null, batchId: batchId ?? current.batchId });
        push.push({ at: now, type: 'published', note: 'Released by the administrator.' });
        group.released += 1;
        summary.released += 1;
        touched = true;
      } else if (current.status === 'draft') {
        group.held += 1;
      } else {
        group.alreadySent += 1;
      }

      // Stale or unavailable data may only annotate a card that already exists. It cannot change what the card says or how serious it is,
      // even when the rule's own clock moves (FARM-01 turns ADVISORY into WARNING as the peak nears): that is a claim the data cannot back.
      const dataUsable = !['STALE', 'UNAVAILABLE'].includes(event.dataStatus);
      const escalated = dataUsable && SEVERITY_RANK[content.severity] > SEVERITY_RANK[current.severity];
      const stage = Number(event.evidence?.renotifyStage ?? 0);
      const renotify = dataUsable && stage > (current.renotifications ?? 0) && stage <= notifyRules.lightningMaxRenotifications;
      const material = isMaterial(current, content);

      if (!dataUsable) {
        if (current.dataStatus !== event.dataStatus) {
          set.dataStatus = event.dataStatus;
          inc.revision = 1;
          push.push({ at: now, type: 'updated', note: 'The source data is stale or unavailable; the alert was not changed.' });
          summary.updated += 1;
          group.updated += 1;
          touched = true;
        }
      } else if (holding && current.status === 'active' && (escalated || renotify)) {
        // A hold keeps a severity back for the administrator. That includes raising a live card to a held severity.
        group.held += 1;
        summary.held += 1;
      } else if (escalated || renotify) {
        Object.assign(set, pickContent(content));
        if (current.status === 'active') set.readAt = null;
        if (renotify) set.renotifications = stage;
        inc.revision = 1;
        push.push({
          at: now,
          type: 'escalated',
          note: current.status === 'draft' ? 'Escalated since it was prepared.' : (escalated ? `Severity rose to ${content.severity}.` : 'New development in the same episode.'),
        });
        summary.escalated += 1;
        group.updated += 1;
        touched = true;
      } else if (material) {
        Object.assign(set, pickContent(content));
        inc.revision = 1;
        push.push({ at: now, type: 'updated', note: 'Evidence or validity changed.' });
        summary.updated += 1;
        group.updated += 1;
        touched = true;
      } else if (differs(current, content)) {
        Object.assign(set, pickContent(content));
        summary.refreshed += 1;
        touched = true;
      }

      if (!touched) { summary.unchanged += 1; continue; }
      if (dryRun) continue;

      const update = { $set: set };
      if (push.length) update.$push = { lifecycle: { $each: push, $slice: -20 } };
      if (Object.keys(inc).length) update.$inc = inc;
      ops.push({ updateOne: { filter: { _id: current._id, status: { $in: ['active', 'draft'] } }, update } });
    }
  }

  summary.groups = [...groups.values()];
  if (!dryRun && ops.length) await writeOps(ops);
  return summary;
}

// Administrator free messages (ADMIN-MSG): no scenario, no weather evidence. The click is the approval, so they are sent at once.
export async function applyAdminMessage(event, {
  nowMs = Date.now(), roles, audience = 'live', areaCodes = null, severity, title, text, actions = [], referenceUrl = null, batchId, dryRun = false,
}) {
  const recipients = await findRecipients(event, { roles, audience, nowMs, areaCodes });
  const summary = { recipients: 0, inserted: 0, unchanged: 0, groups: [] };
  const groups = new Map();
  const ops = [];
  const now = new Date(nowMs);

  const existingRows = recipients.length
    ? await Notification.find({ hazardEventId: event._id, subscriberId: { $in: recipients.map((subscriber) => subscriber._id) } }).lean()
    : [];
  const existing = new Set(existingRows.map((row) => String(row.subscriberId)));

  for (const subscriber of recipients) {
    const areas = subscriber.areas.filter((item) => (event.coverage.upazilaPcodes?.includes(item.upazilaPcode) || event.coverage.districtPcodes?.includes(item.districtPcode))
      && (!areaCodes?.length || areaCodes.includes(item.upazilaPcode) || areaCodes.includes(item.districtPcode)));
    if (!areas.length) continue;
    const area = areas.find((item) => item.role === 'home') ?? areas[0];
    summary.recipients += 1;

    const content = composeAdminMessage({ event, subscriber, area, severity, title, text, actions, referenceUrl, nowMs });
    const key = `${subscriber.occupation}|ADMIN-MSG|${content.affectedArea.scope}:${content.affectedArea.upazilaPcode ?? content.affectedArea.districtPcode}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        ...newGroup(subscriber, 'ADMIN-MSG', content, dryRun
          ? { en: composeAdminMessage({ event, subscriber, area, severity, title, text, actions, referenceUrl, nowMs, lang: 'en' }), bn: composeAdminMessage({ event, subscriber, area, severity, title, text, actions, referenceUrl, nowMs, lang: 'bn' }) }
          : null),
      };
      groups.set(key, group);
    }
    group.recipients += 1;

    if (existing.has(String(subscriber._id))) { summary.unchanged += 1; group.alreadySent += 1; continue; }
    summary.inserted += 1;
    group.newCount += 1;
    if (dryRun) continue;
    ops.push({
      insertOne: {
        document: {
          ...content,
          subscriberId: subscriber._id,
          occupation: subscriber.occupation,
          hazardEventId: event._id,
          isDemo: Boolean(subscriber.isDemo || event.isDemo),
          status: 'active',
          publishedAt: now,
          publishedBy: 'admin',
          batchId,
          readAt: null,
          revision: 1,
          renotifications: 0,
          lifecycle: [{ at: now, type: 'created', note: 'Sent by the administrator.' }],
          purgeAfter: purgeAfter(content.validUntil),
        },
      },
    });
  }

  summary.groups = [...groups.values()];
  if (!dryRun && ops.length) await writeOps(ops);
  return summary;
}
