import { timing } from '../../../config/alertRules.js';
import {
  activityOf, activitySince, eventUntilMs, matchAreas, withinLead,
} from './helpers.js';

const HOUR = 3_600_000;

// FISH-05: a status that is only "on the water" because nobody updated it cannot say where the boat is.
function staleStatus(subscriber, nowMs) {
  const since = activitySince(subscriber);
  if (activityOf(subscriber, nowMs) !== 'on_water' || since === null) return null;
  const hours = (nowMs - since) / HOUR;
  return hours >= timing.quickStatusStaleHours ? Math.floor(hours) : null;
}

function staleAdvice(hours) {
  return hours === null ? [] : [{ key: 'fish_stale_status', params: { hours } }];
}

const waterBodyDetail = (subscriber) => ({
  en: `you fish in ${{ river: 'rivers', coastal: 'coastal waters', marine: 'the open sea' }[subscriber.occupationData.waterBody] ?? 'open water'}`,
  bn: `আপনি ${{ river: 'নদীতে', coastal: 'উপকূলীয় জলে', marine: 'গভীর সমুদ্রে' }[subscriber.occupationData.waterBody] ?? 'পানিতে'} মাছ ধরেন`,
});

// A marine zone is not an upazila: coastal and open-sea fishermen are matched to the zone, named after their home area.
function matchMarine(subscriber, event) {
  const data = subscriber.occupationData;
  const exposed = subscriber.occupation === 'fisherman' && ['coastal', 'marine'].includes(data.waterBody);
  const zone = data.marineZone ?? 'north_bay';
  return exposed && event.coverage.marineZone === zone ? subscriber.areas.filter((area) => area.role === 'home') : [];
}

export const fishermanScenarios = [
  {
    // An official BMD marine warning, in BMD's own words. AkashSathi only chooses how urgently to show it: WARNING, or CRITICAL when BMD itself says "great danger".
    id: 'FISH-01',
    hazards: ['OFFICIAL_NOTICE'],
    areaRoles: ['home'],
    match: matchMarine,
    evaluate({ subscriber, event, nowMs }) {
      if (event.evidence?.kind !== 'warning' || eventUntilMs(event) <= nowMs) return null;
      const activity = activityOf(subscriber, nowMs);
      const actions = ['read_notice', 'check_official_forecast'];
      if (activity === 'on_water') actions.unshift('return_to_shore');
      else if (activity === 'pre_departure') actions.unshift('postpone_departure');
      return {
        severity: event.evidence.greatDanger ? 'CRITICAL' : 'WARNING',
        advice: [{ key: 'official_marine' }],
        actions,
        details: [waterBodyDetail(subscriber)],
      };
    },
  },
  {
    // After BMD withdraws a warning the water can stay rough, and there is no fixed waiting period: check the latest forecast.
    id: 'FISH-03',
    hazards: ['OFFICIAL_NOTICE'],
    areaRoles: ['home'],
    match: matchMarine,
    evaluate({ subscriber, event, nowMs }) {
      if (event.evidence?.kind !== 'withdrawal' || eventUntilMs(event) <= nowMs) return null;
      return {
        severity: 'ADVISORY',
        advice: [{ key: 'official_transition' }],
        actions: ['check_official_forecast', 'read_notice'],
        details: [waterBodyDetail(subscriber)],
      };
    },
  },
  {
    // Lightning near a boat that is already on the water. It never promises that travel is safe.
    id: 'FISH-02',
    hazards: ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'],
    areaRoles: ['operating', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      if (activityOf(subscriber, nowMs) !== 'on_water' || eventUntilMs(event) <= nowMs) return null;
      const stale = staleStatus(subscriber, nowMs);
      return {
        severity: 'CRITICAL',
        advice: [{ key: 'lightning_water' }, ...staleAdvice(stale)],
        actions: stale === null ? ['return_to_shore', 'seek_shelter'] : ['return_to_shore', 'seek_shelter', 'update_status'],
        details: [{ en: 'you said you are on the water', bn: 'আপনি জানিয়েছেন আপনি পানিতে আছেন' }],
        evidence: stale === null ? {} : { scopeUncertain: true, statusAgeHours: stale, relatedRules: ['FISH-05'] },
      };
    },
  },
  {
    // "Postpone departure" and "return to safety" are different actions for the same hazard (FISH-04), and FISH-05 flags an old status.
    id: 'FISH-04',
    hazards: ['STRONG_WIND', 'MARINE_WEATHER'],
    areaRoles: ['operating', 'home'],
    match(subscriber, event) {
      return event.hazardType === 'MARINE_WEATHER' ? matchMarine(subscriber, event) : matchAreas(subscriber, event, ['operating', 'home']);
    },
    evaluate({ subscriber, event, nowMs }) {
      const body = subscriber.occupationData.waterBody;
      if (subscriber.occupation !== 'fisherman') return null;
      // River fishermen are exposed to wind; coastal and open-sea fishermen to wind and to marine conditions.
      if (event.hazardType === 'MARINE_WEATHER' && body === 'river') return null;
      if (!withinLead(event, event.hazardType === 'MARINE_WEATHER' ? timing.marineLeadHours : timing.windLeadHours, nowMs)) return null;

      const activity = activityOf(subscriber, nowMs);
      const stale = staleStatus(subscriber, nowMs);
      let severity;
      let adviceKey;
      let actions;
      let status;

      if (activity === 'on_water') {
        severity = event.level >= 3 ? 'CRITICAL' : 'WARNING';
        adviceKey = body === 'river' ? 'wind_river' : 'marine_on_water';
        actions = ['return_to_shore', 'check_official_forecast'];
        status = { en: 'you said you are on the water', bn: 'আপনি জানিয়েছেন আপনি পানিতে আছেন' };
      } else if (activity === 'pre_departure') {
        severity = 'WARNING';
        adviceKey = body === 'river' ? 'wind_river' : 'marine_pre_departure';
        actions = ['postpone_departure', 'check_official_forecast'];
        status = { en: 'you said you are about to leave', bn: 'আপনি জানিয়েছেন রওনা দেওয়ার আগে আছেন' };
      } else {
        // On shore: only conditions that are clearly dangerous are worth interrupting for.
        if (event.level < 2) return null;
        severity = 'ADVISORY';
        adviceKey = 'marine_ashore';
        actions = ['check_official_forecast'];
        status = { en: 'you are on shore', bn: 'আপনি তীরে আছেন' };
      }

      return {
        severity: stale !== null && severity === 'ADVISORY' ? 'WARNING' : severity,
        advice: [{ key: adviceKey }, ...staleAdvice(stale)],
        actions: stale === null ? actions : [...actions, 'update_status'],
        details: [waterBodyDetail(subscriber), status],
        evidence: stale === null ? {} : { scopeUncertain: true, statusAgeHours: stale, relatedRules: ['FISH-05'] },
      };
    },
  },
];
