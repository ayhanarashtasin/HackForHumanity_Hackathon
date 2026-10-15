import { constructionScenarios } from './construction.js';
import { farmerScenarios } from './farmer.js';
import { fishermanScenarios } from './fisherman.js';
import { activityOf, matchAreas } from './helpers.js';
import { rickshawScenarios } from './rickshaw.js';
import { stormScenarios } from './storm.js';
import { studentScenarios } from './student.js';
import { vendorScenarios } from './vendor.js';

// The catalogue's rule IDs (AkashSathi_Occupation_Based_Scenario_Catalogue.md) implemented as occupation scenarios.
// A scenario turns one occupation-neutral hazard event into advice for one subscriber, or returns null when it does not apply.
export const scenarios = [
  ...farmerScenarios,
  ...fishermanScenarios,
  ...constructionScenarios,
  ...vendorScenarios,
  ...studentScenarios,
  ...rickshawScenarios,
  ...stormScenarios,
];

const byHazard = new Map();
for (const scenario of scenarios) {
  for (const hazard of scenario.hazards) {
    if (!byHazard.has(hazard)) byHazard.set(hazard, []);
    byHazard.get(hazard).push(scenario);
  }
}

export const scenarioIds = scenarios.map((scenario) => scenario.id);

export function scenariosFor(hazardType) {
  return byHazard.get(hazardType) ?? [];
}

// Areas of the subscriber that this scenario cares about and the event covers (most specific role first).
// Someone from another occupation who triggers a scenario through what they are doing now (CTX-01) has no site, market or field,
// so they are matched through their work and home areas (`crossRoles`).
// VEND-03 follows a vendor's shared location too, because the market they are at today may not be a saved one. PUBLIC-06 (a storm
// heading for the place) is about wherever the person is now.
const PORTABLE = new Set(['PUBLIC-01', 'PUBLIC-02', 'PUBLIC-03', 'PUBLIC-06', 'WORK-01', 'WORK-03', 'WORK-04', 'VEND-03']);

export function matchFor(scenario, subscriber, event, nowMs = Date.now()) {
  if (scenario.match) return scenario.match(subscriber, event);
  const cross = scenario.crossRoles && subscriber.occupation !== scenario.ownOccupation;
  // Place-specific field/site/market/boat rules do not follow a traveller. Portable personal exposure rules do.
  const roles = cross ? scenario.crossRoles : scenario.areaRoles;
  const activity = activityOf(subscriber, nowMs);
  const activeWork = ((scenario.id === 'CONS-01' && ['roof_work', 'scaffolding'].includes(activity))
    || (scenario.id === 'CONS-03' && ['roof_work', 'scaffolding', 'elevated_work'].includes(activity))
    || (scenario.id === 'VEND-01' && activity === 'stall_outdoor'));
  return matchAreas(subscriber, event, PORTABLE.has(scenario.id) || activeWork ? ['current', ...roles] : roles, nowMs);
}

// Runs every scenario for one hazard event and one subscriber. Returns [{ scenario, area, result }].
export function evaluateSubscriber({ subscriber, event, nowMs, activity }) {
  const out = [];
  for (const scenario of scenariosFor(event.hazardType)) {
    const areas = matchFor(scenario, subscriber, event, nowMs);
    if (!areas.length) continue;
    const result = scenario.evaluate({ subscriber, event, nowMs, area: areas[0], areas, activity });
    if (result) out.push({ scenario, area: areas[0], result });
  }
  return out;
}
