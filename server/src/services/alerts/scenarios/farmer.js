import { hazardRules, timing } from '../../../config/alertRules.js';
import {
  DEFAULT_OUTDOOR, eventFromMs, eventUntilMs, heatClassFor, heatSeverity, heatTimingOk, matchAreas, withinLead,
} from './helpers.js';

const HOUR = 3_600_000;
const HARVEST_STAGES = ['harvesting', 'post_harvest'];
const PLANTING_STAGES = ['planting', 'growing'];

export const farmerScenarios = [
  {
    // Rain at harvest: harvested paddy that gets wet loses quality and is hard to store. Rain probability alone is not an amount.
    id: 'FARM-01',
    hazards: ['HEAVY_RAIN'],
    areaRoles: ['field'],
    evaluate({ subscriber, event, nowMs }) {
      const stage = subscriber.occupationData.cropStage;
      if (subscriber.occupation !== 'farmer' || !HARVEST_STAGES.includes(stage) || !withinLead(event, timing.rainLeadHours, nowMs)) return null;

      const soon = eventFromMs(event) - nowMs <= timing.harvestWarningLeadHours * HOUR;
      const harvesting = stage === 'harvesting';
      return {
        severity: event.level >= 2 && soon ? 'WARNING' : 'ADVISORY',
        advice: [{ key: harvesting ? 'rain_harvest' : 'rain_post_harvest' }],
        actions: ['cover_harvest', 'check_forecast'],
        details: [harvesting
          ? { en: 'your crop is at the harvest stage', bn: 'আপনার ফসল কাটার পর্যায়ে আছে' }
          : { en: 'your harvested crop is drying or in storage', bn: 'আপনার কাটা ফসল শুকানো বা মজুতের অবস্থায় আছে' }],
      };
    },
  },
  {
    // Planting and growing get planning advice, not crop-protection advice, even under the same forecast.
    id: 'FARM-02',
    hazards: ['HEAVY_RAIN'],
    areaRoles: ['field'],
    evaluate({ subscriber, event, nowMs }) {
      const stage = subscriber.occupationData.cropStage;
      if (subscriber.occupation !== 'farmer' || !PLANTING_STAGES.includes(stage) || !withinLead(event, timing.rainLeadHours, nowMs)) return null;

      const planting = stage === 'planting';
      return {
        severity: 'ADVISORY',
        advice: [{ key: planting ? 'rain_planting' : 'rain_growing' }],
        actions: planting ? ['plan_fieldwork', 'check_drainage', 'check_forecast'] : ['check_drainage', 'check_forecast'],
        details: [planting
          ? { en: 'your crop is at the planting stage', bn: 'আপনার ফসল রোপণ বা বপনের পর্যায়ে আছে' }
          : { en: 'your crop is growing', bn: 'আপনার ফসল বেড়ে উঠছে' }],
      };
    },
  },
  {
    // A dry spell is not a drought: forecast days only, a field check rather than an irrigation volume.
    id: 'FARM-03',
    hazards: ['DRY_SPELL'],
    areaRoles: ['field'],
    evaluate({ subscriber, event }) {
      if (subscriber.occupation !== 'farmer' || !hazardRules.DRY_SPELL.cropStages.includes(subscriber.occupationData.cropStage)) return null;

      const irrigated = subscriber.occupationData.irrigationAccess !== 'none';
      return {
        severity: 'ADVISORY',
        advice: [{ key: 'dry_spell' }, { key: irrigated ? 'dry_spell_irrigation' : 'dry_spell_rainfed' }],
        actions: irrigated ? ['check_field_moisture', 'use_irrigation'] : ['check_field_moisture', 'save_water'],
        details: [
          { en: 'your crop is still growing or being planted', bn: 'আপনার ফসল এখনো রোপণ বা বেড়ে ওঠার পর্যায়ে' },
          irrigated
            ? { en: 'you have some irrigation', bn: 'আপনার কিছু সেচের ব্যবস্থা আছে' }
            : { en: 'you rely on rain', bn: 'আপনি বৃষ্টির ওপর নির্ভরশীল' },
        ],
        evidence: { forecastOnly: true },
      };
    },
  },
  {
    // Lightning can strike before the rain starts. Open fields and isolated trees are not shelter. CRITICAL for observed strikes and threats alike.
    id: 'FARM-04',
    hazards: ['OBSERVED_LIGHTNING', 'LIGHTNING_THREAT'],
    areaRoles: ['field'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'farmer' || eventUntilMs(event) <= nowMs) return null;
      return {
        severity: 'CRITICAL',
        advice: [{ key: 'lightning_field' }],
        actions: ['stop_fieldwork', 'go_to_building', 'avoid_trees'],
        details: [{ en: 'you work in open fields', bn: 'আপনি খোলা মাঠে কাজ করেন' }],
      };
    },
  },
  {
    // Midday heat during fieldwork, judged against the farmer's workload class, never a flat air temperature.
    id: 'FARM-05',
    hazards: ['HEAT_STRESS'],
    areaRoles: ['field'],
    evaluate({ subscriber, event, nowMs }) {
      if (subscriber.occupation !== 'farmer') return null;
      const className = heatClassFor(subscriber);
      const severity = heatSeverity(event, className);
      if (!severity || !heatTimingOk(event, DEFAULT_OUTDOOR, nowMs)) return null;

      return {
        severity,
        advice: [{ key: 'heat_farm' }],
        actions: ['rest_shade', 'drink_water', 'shift_hours', 'seek_medical'],
        details: [{ en: `your fieldwork counts as ${className} work in the heat`, bn: `গরমে আপনার মাঠের কাজ ${{ light: 'হালকা', moderate: 'মাঝারি', heavy: 'ভারী' }[className]} পরিশ্রমের হিসেবে ধরা হয়` }],
        evidence: { heatClass: className },
      };
    },
  },
];
