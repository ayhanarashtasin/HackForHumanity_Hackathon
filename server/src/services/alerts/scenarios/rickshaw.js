import { timing } from '../../../config/alertRules.js';
import {
  activityOf, eventUntilMs, heatClassFor, heatSeverity, heatTimingOk, shiftHours, shiftOf, windowOverlap, withinLead,
} from './helpers.js';
import { locationByPcode } from '../../geo.js';

const HEAVIER = ['moderate', 'heavy'];

export const rickshawScenarios = [
  {
    // WORK-01 is the heat advice before the hottest hours. WORK-02 (urban exposure) and WORK-05 (long shifts) are added to it as
    // extra sentences instead of separate notifications, so one heat event never sends three messages. They stay traceable in evidence.relatedRules.
    id: 'WORK-01',
    hazards: ['HEAT_STRESS'],
    areaRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs, area }) {
      if (subscriber.occupation !== 'rickshaw_labourer') return null;
      const shift = shiftOf(subscriber.occupationData);
      const className = heatClassFor(subscriber);
      const severity = heatSeverity(event, className);
      if (!severity || !heatTimingOk(event, shift, nowMs)) return null;

      const related = [];
      const advice = [{ key: 'heat_labour' }];
      const actions = ['rest_shade', 'drink_water', 'shift_hours', 'seek_medical'];
      const location = locationByPcode.get(area.upazilaPcode);

      // WORK-02: concrete and direct sun make street-level heat vary. A precaution only: thresholds are NOT lowered.
      if (location?.kind === 'thana') {
        advice.push({ key: 'heat_urban' });
        related.push('WORK-02');
      }
      // WORK-05: a long, physically demanding shift in the heat.
      if (shiftHours(shift) >= 8 && HEAVIER.includes(subscriber.occupationData.workload)) {
        advice.push({ key: 'heat_long_shift' });
        actions.push('check_on_coworkers');
        related.push('WORK-05');
      }

      return {
        severity,
        advice,
        actions,
        details: [{ en: `your shift is ${shift.start} to ${shift.end} and counts as ${className} work`, bn: `আপনার শিফট ${shift.start} থেকে ${shift.end} এবং কাজটি ${{ light: 'হালকা', moderate: 'মাঝারি', heavy: 'ভারী' }[className]} পরিশ্রমের হিসেবে ধরা হয়` }],
        evidence: { heatClass: className, relatedRules: related },
      };
    },
  },
  {
    // The catalogue's WORK-03 also covers anyone who says they are on the road (a farmer who drives in the evening).
    id: 'WORK-03',
    hazards: ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'],
    areaRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      const usual = subscriber.occupation === 'rickshaw_labourer' && ['on_road', 'mixed'].includes(subscriber.occupationData.outdoorExposure);
      const viaActivity = !usual && activityOf(subscriber, nowMs) === 'on_road';
      if ((!usual && !viaActivity) || eventUntilMs(event) <= nowMs) return null;
      return {
        severity: 'CRITICAL',
        advice: [{ key: 'lightning_road' }],
        actions: ['stop_vehicle', 'avoid_trees'],
        details: usual ? [{ en: 'you work on the road', bn: 'আপনি রাস্তায় কাজ করেন' }] : [],
        ...(viaActivity ? { activityKey: 'on_road' } : {}),
      };
    },
  },
  {
    // Rain during working hours: extra travel time and a local road check. flood_claim stays false: rain is not proof of waterlogging.
    id: 'WORK-04',
    hazards: ['HEAVY_RAIN'],
    areaRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'rickshaw_labourer' || !withinLead(event, timing.rainLeadHours, nowMs)) return null;
      const shift = shiftOf(subscriber.occupationData);
      if (!shift || !windowOverlap(shift, event, nowMs)) return null;
      return {
        severity: 'ADVISORY',
        advice: [{ key: 'rain_work' }],
        actions: ['extra_travel_time', 'check_roads', 'check_forecast'],
        details: [{ en: `your shift is ${shift.start} to ${shift.end}`, bn: `আপনার শিফট ${shift.start} থেকে ${shift.end}` }],
        evidence: { floodClaim: false },
      };
    },
  },
];
