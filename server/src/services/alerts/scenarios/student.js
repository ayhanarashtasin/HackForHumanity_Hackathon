import { timing } from '../../../config/alertRules.js';
import {
  DEFAULT_OUTDOOR, activityOf, eventUntilMs, heatClassFor, heatSeverity, heatTimingOk, windowOverlap, withinLead,
} from './helpers.js';

const OTHER_HEAT_SCENARIOS = ['farmer', 'construction', 'vendor', 'rickshaw_labourer'];

export const studentScenarios = [
  {
    // A forecast is not proof that roads are flooded: advice is about leaving early and checking locally.
    id: 'PUBLIC-01',
    hazards: ['HEAVY_RAIN'],
    areaRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'student_public' || !withinLead(event, timing.rainLeadHours, nowMs)) return null;
      const data = subscriber.occupationData;
      const window = { start: data.commuteStart ?? '07:00', end: data.commuteEnd ?? '09:00' };
      if (!windowOverlap(window, event, nowMs)) return null;
      return {
        severity: 'ADVISORY',
        advice: [{ key: 'rain_commute' }],
        actions: ['leave_early', 'check_roads', 'check_forecast'],
        details: [{ en: `you travel between ${window.start} and ${window.end}`, bn: `আপনি ${window.start} থেকে ${window.end}-এর মধ্যে যাতায়াত করেন` }],
      };
    },
  },
  {
    id: 'PUBLIC-02',
    hazards: ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'],
    areaRoles: ['home', 'work'],
    evaluate({ subscriber, event, nowMs }) {
      const usual = subscriber.occupation === 'student_public' && subscriber.occupationData.outdoorPlay === true;
      const viaActivity = !usual && activityOf(subscriber, nowMs) === 'outdoor_play';
      if ((!usual && !viaActivity) || eventUntilMs(event) <= nowMs) return null;
      return {
        severity: 'CRITICAL',
        advice: [{ key: 'lightning_play' }],
        actions: ['leave_field', 'go_to_building', 'wait_30'],
        details: usual ? [{ en: 'you play or exercise outdoors', bn: 'আপনি বাইরে খেলাধুলা বা ব্যায়াম করেন' }] : [],
        ...(viaActivity ? { activityKey: 'outdoor_play' } : {}),
      };
    },
  },
  {
    // Voluntary: a person who says they are sensitive to heat gets the moderate-class lines. No medical detail is collected.
    // Occupations that already have a heat scenario treat sensitivity as a class change instead (heatClassFor), so no second alert is sent.
    id: 'PUBLIC-03',
    hazards: ['HEAT_STRESS'],
    areaRoles: ['home', 'work'],
    evaluate({ subscriber, event, nowMs }) {
      if (!subscriber.isHeatSensitive || OTHER_HEAT_SCENARIOS.includes(subscriber.occupation)) return null;
      const className = heatClassFor(subscriber);
      const severity = heatSeverity(event, className);
      if (!severity || !heatTimingOk(event, DEFAULT_OUTDOOR, nowMs)) return null;
      return {
        severity,
        advice: [{ key: 'heat_sensitive' }],
        actions: ['rest_shade', 'drink_water', 'move_cooler', 'seek_medical'],
        details: [{ en: 'you chose to receive extra heat guidance', bn: 'আপনি গরম সম্পর্কে বাড়তি নির্দেশনা পেতে চেয়েছেন' }],
        evidence: { heatClass: className },
      };
    },
  },
];
