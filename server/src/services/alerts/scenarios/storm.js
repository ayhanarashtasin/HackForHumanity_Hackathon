import { AREA_ROLES } from '../../../config/alertConstants.js';
import { activityOf, eventUntilMs } from './helpers.js';

// A thunderstorm cell on the satellite image is heading for one of the person's areas (STORM_APPROACH). Unlike the lightning rules,
// which speak to the people most exposed, this warns everyone with an area in the storm's path, with advice for their occupation:
// the point is to be under cover before the storm arrives. WARNING, not CRITICAL: it is a satellite estimate (about 30 km off after an
// hour) and not observed lightning; delivery still lets it through quiet hours because it is over within the hour (delivery/policy.js).

// The most specific place first, so the message names the field, boat area, site or market rather than the home.
const ROLES = ['field', 'operating', 'site', 'market', 'work', 'home'].filter((role) => AREA_ROLES.includes(role));

function adviceFor(subscriber, nowMs) {
  const activity = activityOf(subscriber, nowMs);
  if (activity === 'on_water') return { key: 'storm_water', actions: ['return_to_shore', 'seek_shelter'], activityKey: 'on_water' };
  switch (subscriber.occupation) {
    case 'farmer': return { key: 'storm_field', actions: ['stop_fieldwork', 'go_to_building', 'avoid_trees'] };
    case 'fisherman': return { key: 'storm_departure', actions: ['postpone_departure', 'go_to_building'] };
    case 'construction': return { key: 'storm_site', actions: ['come_down', 'stop_elevated_work', 'go_to_building'] };
    case 'vendor': return { key: 'storm_stall', actions: ['secure_stall', 'go_to_building', 'avoid_trees'] };
    case 'rickshaw_labourer': return { key: 'storm_road', actions: ['stop_vehicle', 'avoid_trees'] };
    default: return { key: 'storm_public', actions: ['go_to_building', 'avoid_trees', 'wait_30'] };
  }
}

export const stormScenarios = [
  {
    id: 'PUBLIC-06',
    hazards: ['STORM_APPROACH'],
    areaRoles: ROLES,
    evaluate({ subscriber, event, nowMs }) {
      if (eventUntilMs(event) <= nowMs) return null;
      const advice = adviceFor(subscriber, nowMs);
      return {
        severity: 'WARNING',
        advice: [{ key: advice.key }],
        actions: advice.actions,
        details: [],
        ...(advice.activityKey ? { activityKey: advice.activityKey } : {}),
      };
    },
  },
];
