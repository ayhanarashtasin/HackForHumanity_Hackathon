import { timing } from '../../../config/alertRules.js';
import {
  activityOf, eventUntilMs, heatClassFor, heatSeverity, heatTimingOk, shiftOf, withinLead,
} from './helpers.js';

const ELEVATED_TYPES = ['roof', 'scaffolding', 'other_elevated'];
const ELEVATED_ACTIVITIES = ['roof_work', 'scaffolding', 'elevated_work'];

// Exposed work at height: the usual activity type, or the activity the person said they are doing right now (CTX-01).
// Returns 'profile', the activity key, or null.
function atHeight(subscriber, nowMs, types, activities) {
  if (subscriber.occupation === 'construction' && types.includes(subscriber.occupationData.activityType)) return 'profile';
  const activity = activityOf(subscriber, nowMs);
  return activities.includes(activity) ? activity : null;
}

export const constructionScenarios = [
  {
    id: 'CONS-01',
    hazards: ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'],
    ownOccupation: 'construction',
    areaRoles: ['site'],
    crossRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      const via = atHeight(subscriber, nowMs, ['roof', 'scaffolding'], ['roof_work', 'scaffolding']);
      if (eventUntilMs(event) <= nowMs || !via) return null;
      return {
        severity: 'CRITICAL',
        advice: [{ key: 'lightning_height' }],
        actions: ['stop_elevated_work', 'come_down', 'go_to_building'],
        details: via === 'profile' ? [{ en: 'you work on roofs or scaffolding', bn: 'আপনি ছাদে বা ভারায় কাজ করেন' }] : [],
        ...(via === 'profile' ? {} : { activityKey: via }),
      };
    },
  },
  {
    // Heavy work in protective gear: the heat load class already moves one class heavier for heavy PPE.
    id: 'CONS-02',
    hazards: ['HEAT_STRESS'],
    areaRoles: ['site'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'construction') return null;
      const className = heatClassFor(subscriber);
      const severity = heatSeverity(event, className);
      if (!severity || !heatTimingOk(event, shiftOf(subscriber.occupationData), nowMs)) return null;

      return {
        severity,
        advice: [{ key: 'heat_cons' }],
        actions: ['rest_shade', 'drink_water', 'ask_supervisor', 'seek_medical'],
        details: [{
          en: `your work counts as ${className} work${subscriber.occupationData.ppeHeatBurden === 'heavy' ? ' in heavy protective gear' : ''}`,
          bn: `আপনার কাজ ${{ light: 'হালকা', moderate: 'মাঝারি', heavy: 'ভারী' }[className]} পরিশ্রমের হিসেবে ধরা হয়${subscriber.occupationData.ppeHeatBurden === 'heavy' ? ' (ভারী সুরক্ষা সরঞ্জামসহ)' : ''}`,
        }],
        evidence: { heatClass: className },
      };
    },
  },
  {
    id: 'CONS-03',
    hazards: ['STRONG_WIND'],
    ownOccupation: 'construction',
    areaRoles: ['site'],
    crossRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      const via = atHeight(subscriber, nowMs, ELEVATED_TYPES, ELEVATED_ACTIVITIES);
      if (!withinLead(event, timing.windLeadHours, nowMs) || !via) return null;
      return {
        severity: 'WARNING',
        advice: [{ key: 'wind_height' }],
        actions: ['stop_elevated_work', 'check_forecast'],
        details: via === 'profile' ? [{ en: 'you work at height', bn: 'আপনি উঁচু জায়গায় কাজ করেন' }] : [],
        ...(via === 'profile' ? {} : { activityKey: via }),
      };
    },
  },
];
