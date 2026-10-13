import { Subscriber } from '../../models/Subscriber.js';

// Stage 2: which subscribers could this event matter to? Location first; occupation advice comes later (stage 3).
//   upazila coverage   -> subscribers with that upazila among their areas
//   district coverage  -> subscribers with an area in that district (the message says "district-wide", never "your upazila")
//   marine-zone        -> coastal and open-sea fishermen
// `roles` and `audience` narrow an administrator send: roles = occupations, audience = live | demo | all.
export async function findRecipients(event, {
  roles = null, audience = 'all', nowMs = Date.now(), areaCodes = null, subscriberIds = null, limit = 20_000,
} = {}) {
  // The audience of an administrator declaration survives later ticks and subscriber backfill.
  if (event.origin === 'admin-declared') {
    if (event.evidence?.roles?.length) roles = roles?.length ? roles.filter((role) => event.evidence.roles.includes(role)) : event.evidence.roles;
    if (roles && !roles.length) return [];
    audience = event.evidence?.audience ?? (event.isDemo ? 'demo' : 'live');
  }
  const query = { status: 'active', expiresAt: { $gt: new Date(nowMs) } };
  if (subscriberIds?.length) query._id = { $in: subscriberIds };

  if (event.coverage.scope === 'marine-zone') {
    query.occupation = 'fisherman';
    query['occupationData.waterBody'] = { $in: ['coastal', 'marine'] };
  } else {
    const or = [];
    if (event.coverage.upazilaPcodes?.length) or.push({ relevantUpazilas: { $in: event.coverage.upazilaPcodes } });
    if (event.coverage.districtPcodes?.length) or.push({ relevantDistricts: { $in: event.coverage.districtPcodes } });
    const current = { 'currentArea.expiresAt': { $gt: new Date(nowMs) } };
    if (event.coverage.upazilaPcodes?.length) or.push({ ...current, 'currentArea.upazilaPcode': { $in: event.coverage.upazilaPcodes } });
    if (event.coverage.districtPcodes?.length) or.push({ ...current, 'currentArea.districtPcode': { $in: event.coverage.districtPcodes } });
    if (!or.length) return [];
    query.$or = or;
  }

  if (roles?.length) query.occupation = query.occupation ? { $in: roles.filter((role) => role === query.occupation) } : { $in: roles };
  if (audience === 'live') query.isDemo = { $ne: true };
  if (audience === 'demo') query.isDemo = true;
  // An administrator may narrow a send to some upazilas or districts of the event's coverage.
  if (areaCodes?.length) {
    const valid = { 'currentArea.expiresAt': { $gt: new Date(nowMs) } };
    const narrowed = { $or: [
      { relevantUpazilas: { $in: areaCodes } }, { relevantDistricts: { $in: areaCodes } },
      { ...valid, 'currentArea.upazilaPcode': { $in: areaCodes } },
      { ...valid, 'currentArea.districtPcode': { $in: areaCodes } },
    ] };
    query.$and = [narrowed];
  }

  return Subscriber.find(query).limit(limit).lean();
}
