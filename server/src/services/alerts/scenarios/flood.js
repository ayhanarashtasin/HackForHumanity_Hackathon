import { AREA_ROLES } from '../../../config/alertConstants.js';
import { activityOf, eventUntilMs } from './helpers.js';

// A river gauge at or near its danger level applies to everyone in the upazila, not only the occupation that happens to be first in the
// catalogue. The wording never says a flood is happening or that a place is safe: it reports FFWC's measured level and tells the person
// what to check. WARNING at or above the danger level; ADVISORY only in the half-metre approach band.

const ROLES = ['field', 'operating', 'site', 'market', 'work', 'home'].filter((role) => AREA_ROLES.includes(role));

function adviceFor(subscriber, nowMs) {
  const activity = activityOf(subscriber, nowMs);
  if (activity === 'on_water') return { key: 'flood_water', actions: ['return_to_shore', 'check_ffwc_bulletin'] };
  switch (subscriber.occupation) {
    case 'farmer': return { key: 'flood_field', actions: ['move_livestock', 'avoid_river_banks', 'check_ffwc_bulletin'] };
    case 'fisherman': return { key: 'flood_boat', actions: ['secure_boat', 'avoid_river_banks', 'check_ffwc_bulletin'] };
    case 'construction': return { key: 'flood_site', actions: ['avoid_river_banks', 'follow_local_authority', 'check_ffwc_bulletin'] };
    case 'vendor': return { key: 'flood_market', actions: ['protect_goods', 'avoid_river_banks', 'check_ffwc_bulletin'] };
    case 'rickshaw_labourer': return { key: 'flood_road', actions: ['avoid_water_crossing', 'avoid_river_banks'] };
    default: return { key: 'flood_home', actions: ['check_shelter', 'avoid_river_banks', 'check_ffwc_bulletin'] };
  }
}

export const floodScenarios = [
  {
    id: 'FLOOD-01',
    hazards: ['RIVER_FLOOD'],
    areaRoles: ROLES,
    evaluate({ subscriber, event, nowMs }) {
      if (eventUntilMs(event) <= nowMs) return null;
      const severity = event.level >= 2 ? 'WARNING' : 'ADVISORY';
      const advice = adviceFor(subscriber, nowMs);
      return {
        severity,
        advice: [{ key: advice.key }],
        actions: advice.actions,
        details: [],
      };
    },
  },
];
