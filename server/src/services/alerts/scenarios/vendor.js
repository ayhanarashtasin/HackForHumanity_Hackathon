import { timing } from '../../../config/alertRules.js';
import {
  DEFAULT_VENDOR, activityOf, heatClassFor, heatSeverity, heatTimingOk, withinLead,
} from './helpers.js';

export const vendorScenarios = [
  {
    // Wind around a temporary stall: secure it early, never go out to rescue goods once the storm is under way.
    id: 'VEND-01',
    hazards: ['STRONG_WIND'],
    ownOccupation: 'vendor',
    areaRoles: ['market'],
    crossRoles: ['work', 'home'],
    evaluate({ subscriber, event, nowMs }) {
      const usual = subscriber.occupation === 'vendor' && subscriber.occupationData.outdoorStall === true;
      const viaActivity = !usual && activityOf(subscriber, nowMs) === 'stall_outdoor';
      if ((!usual && !viaActivity) || !withinLead(event, timing.windLeadHours, nowMs)) return null;
      return {
        severity: 'WARNING',
        advice: [{ key: 'wind_stall' }],
        actions: ['secure_stall', 'stay_in', 'check_forecast'],
        details: usual ? [{ en: 'your stall is outdoors', bn: 'আপনার দোকান খোলা জায়গায়' }] : [],
        ...(viaActivity ? { activityKey: 'stall_outdoor' } : {}),
      };
    },
  },
  {
    // Heat in an open-air market: hours outdoors and missing shelter shift the class, the water and shade advice is the same.
    id: 'VEND-02',
    hazards: ['HEAT_STRESS'],
    areaRoles: ['market'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'vendor') return null;
      const className = heatClassFor(subscriber);
      const severity = heatSeverity(event, className);
      if (!severity || !heatTimingOk(event, DEFAULT_VENDOR, nowMs)) return null;
      return {
        severity,
        advice: [{ key: 'heat_vendor' }],
        actions: ['rest_shade', 'drink_water', 'seek_medical'],
        details: [{ en: 'you spend long hours in an open-air market', bn: 'আপনি খোলা বাজারে দীর্ঘ সময় কাটান' }],
        evidence: { heatClass: className },
      };
    },
  },
];
