import { timing } from '../../../config/alertRules.js';
import {
  DEFAULT_VENDOR, activityOf, heatClassFor, heatSeverity, heatTimingOk, windowOverlap, withinLead,
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
  {
    // A vendor can work one market in the morning and another in the afternoon. Rain at any of them (the main market, a saved
    // market or the shared live location) is one advisory for the person, not one per market: oncePerHazard skips a second card
    // while an earlier one for the same rain is still live. A shared location that has gone out of date is said so, not guessed.
    id: 'VEND-03',
    hazards: ['HEAVY_RAIN'],
    areaRoles: ['market'],
    oncePerHazard: true,
    evaluate({ subscriber, event, nowMs, area }) {
      if (subscriber.occupation !== 'vendor' || !withinLead(event, timing.rainLeadHours, nowMs)) return null;
      if (!windowOverlap(DEFAULT_VENDOR, event, nowMs)) return null;
      const locationOld = Boolean(subscriber.currentArea && +new Date(subscriber.currentArea.expiresAt) <= nowMs);
      const main = area.role === 'market' && area.upazilaPcode === subscriber.occupationData.marketAreaPcode;
      const where = area.role === 'current'
        ? { en: 'you shared your location near this market', bn: 'আপনি এই বাজারের কাছ থেকে অবস্থান জানিয়েছেন' }
        : main
          ? { en: 'this is your main market', bn: 'এটি আপনার প্রধান বাজার' }
          : { en: 'this is one of the other markets you work at', bn: 'এটি আপনার কাজের অন্য একটি বাজার' };
      return {
        severity: 'ADVISORY',
        advice: [{ key: 'rain_market' }, ...(locationOld ? [{ key: 'location_old' }] : [])],
        actions: locationOld ? ['cover_goods', 'check_forecast', 'share_location'] : ['cover_goods', 'check_forecast'],
        details: [where],
        evidence: locationOld ? { scopeUncertain: true } : {},
      };
    },
  },
];
