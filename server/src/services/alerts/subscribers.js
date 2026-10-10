import { env } from '../../config/env.js';
import { notifyRules } from '../../config/alertRules.js';
import { Delivery } from '../../models/Delivery.js';
import { Notification } from '../../models/Notification.js';
import { Subscriber } from '../../models/Subscriber.js';
import { districts, locationByPcode } from '../geo.js';
import { badRequest, serviceUnavailable } from './errors.js';
import {
  CONSENT_VERSION, SCHEMA_VERSION, initialActivity, validateActivity, validateSubscription,
} from './schema.js';
import { hashToken, newToken } from './tokens.js';

// Subscribers: people who completed the alert form. No accounts: the browser holds an opaque token, only its hash is stored here.
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const districtByPcode = new Map(districts.map((district) => [district.pcode, district]));

const expiryFrom = (now) => new Date(now.getTime() + notifyRules.inactivityExpiryDays * DAY_MS);

function validate(input) {
  const { value, errors } = validateSubscription(input, { locations: locationByPcode });
  if (!value) throw badRequest('Please check the highlighted answers.', errors);
  return value;
}

export async function createSubscriber(input, { now = new Date(), isDemo = false } = {}) {
  const value = validate(input);

  if (await Subscriber.estimatedDocumentCount() >= env.alerts.maxSubscribers) {
    throw serviceUnavailable('Alert sign-up is full for this prototype. Please try again later.');
  }

  const token = newToken();
  const subscriber = await Subscriber.create({
    tokenHash: hashToken(token),
    occupation: value.occupation,
    occupationData: value.occupationData,
    schemaVersion: SCHEMA_VERSION,
    areas: value.areas,
    relevantUpazilas: value.relevantUpazilas,
    relevantDistricts: value.relevantDistricts,
    activeActivity: initialActivity(value, now, env.alerts.activityTtlHours),
    language: value.language,
    isHeatSensitive: value.isHeatSensitive,
    guardianManaged: value.guardianManaged,
    preferences: value.preferences,
    consent: { version: CONSENT_VERSION, at: now },
    status: 'active',
    isDemo,
    lastSeenAt: now,
    expiresAt: expiryFrom(now),
  });
  return { subscriber: subscriber.toObject(), token };
}

// Looks a subscriber up by the cookie token. Expiry is checked here as well as by the TTL index (TTL deletion is not instantaneous).
// `lastSeenAt` and the sliding expiry are written at most once an hour, never on every inbox poll.
export async function findByToken(token, now = new Date()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const subscriber = await Subscriber.findOne({ tokenHash: hashToken(token) }).lean();
  if (!subscriber || subscriber.expiresAt <= now) return null;

  if (now - subscriber.lastSeenAt > HOUR_MS) {
    const expiresAt = expiryFrom(now);
    await Subscriber.updateOne({ _id: subscriber._id }, { $set: { lastSeenAt: now, expiresAt } });
    subscriber.lastSeenAt = now;
    subscriber.expiresAt = expiresAt;
  }
  return subscriber;
}

// The fisherman's "right now" answer is a status with an expiry; other activities set through the quick-status control are kept.
function activityAfterEdit(previousActivity, value, now) {
  const statusKeys = ['on_water', 'pre_departure'];
  const previous = previousActivity && previousActivity.expiresAt > now ? previousActivity : null;
  const next = initialActivity(value, now, env.alerts.activityTtlHours);
  if (value.occupation === 'fisherman') {
    if (next) return previous?.key === next.key ? previous : next;
    // "On shore" ends a water status but leaves any other activity alone.
    return previous && statusKeys.includes(previous.key) ? null : previous;
  }
  return previous;
}

export async function updateProfile(subscriber, input, now = new Date()) {
  const value = validate(input);
  const updated = await Subscriber.findByIdAndUpdate(
    subscriber._id,
    {
      $set: {
        occupation: value.occupation,
        occupationData: value.occupationData,
        schemaVersion: SCHEMA_VERSION,
        areas: value.areas,
        relevantUpazilas: value.relevantUpazilas,
        relevantDistricts: value.relevantDistricts,
        activeActivity: activityAfterEdit(subscriber.activeActivity, value, now),
        language: value.language,
        isHeatSensitive: value.isHeatSensitive,
        guardianManaged: value.guardianManaged,
        preferences: value.preferences,
        consent: { version: CONSENT_VERSION, at: subscriber.consent?.at ?? now },
      },
    },
    { returnDocument: 'after' },
  ).lean();
  return updated;
}

export async function setActivity(subscriber, input, now = new Date()) {
  const parsed = validateActivity(input, env.alerts.activityTtlHours);
  if (parsed.error) throw badRequest('Choose one of the listed activities, for up to the maximum number of hours.');
  const activeActivity = parsed.key === null
    ? null
    : { key: parsed.key, since: now, expiresAt: new Date(now.getTime() + parsed.hours * HOUR_MS) };
  return Subscriber.findByIdAndUpdate(subscriber._id, { $set: { activeActivity } }, { returnDocument: 'after' }).lean();
}

export async function setStatus(subscriber, status) {
  if (!['active', 'paused'].includes(status)) throw badRequest('Status must be active or paused.');
  return Subscriber.findByIdAndUpdate(subscriber._id, { $set: { status } }, { returnDocument: 'after' }).lean();
}

// "Delete my alert profile": the subscriber and everything stored for them.
export async function deleteSubscriber(subscriber) {
  await Delivery.deleteMany({ subscriberId: subscriber._id });
  await Notification.deleteMany({ subscriberId: subscriber._id });
  await Subscriber.deleteOne({ _id: subscriber._id });
}

// What the client may see about its own profile: names resolved, never the token hash or internal flags.
export function profileView(subscriber, now = new Date()) {
  const activity = subscriber.activeActivity && subscriber.activeActivity.expiresAt > now ? subscriber.activeActivity : null;
  return {
    occupation: subscriber.occupation,
    occupationData: subscriber.occupationData,
    language: subscriber.language,
    isHeatSensitive: subscriber.isHeatSensitive,
    guardianManaged: subscriber.guardianManaged,
    preferences: subscriber.preferences,
    status: subscriber.status,
    createdAt: subscriber.createdAt,
    activeActivity: activity ? { key: activity.key, since: activity.since, expiresAt: activity.expiresAt } : null,
    areas: subscriber.areas.map((area) => {
      const location = locationByPcode.get(area.upazilaPcode);
      const district = districtByPcode.get(area.districtPcode);
      return {
        role: area.role,
        upazilaPcode: area.upazilaPcode,
        districtPcode: area.districtPcode,
        matchMethod: area.matchMethod,
        name: location?.name ?? area.upazilaPcode,
        nameBn: location?.nameBn ?? null,
        districtName: district?.name ?? null,
        districtNameBn: district?.nameBn ?? null,
      };
    }),
    consent: subscriber.consent,
  };
}
