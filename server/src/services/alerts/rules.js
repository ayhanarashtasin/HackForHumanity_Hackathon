import { RULE_STATUS, RULE_VERSION, ruleCatalogue } from '../../config/alertRules.js';
import { Area } from '../../models/Area.js';
import { RuleSetting } from '../../models/RuleSetting.js';
import { districts, locations } from '../geo.js';
import { scenarioIds } from './scenarios/index.js';
import { loadGeoData } from '../lightningCampaign.js';
import { haversineKm } from '../time.js';

// Reference data written at start-up. Both are idempotent upserts, so a restart never duplicates or loses anything.
export async function seedRules() {
  const rows = ruleCatalogue();
  const operations = rows.map((row) => ({
    updateOne: {
      filter: { key: row.id, version: RULE_VERSION },
      // $setOnInsert only: a rule that was validated by a reviewer is never overwritten by a restart.
      update: {
        $setOnInsert: {
          key: row.id, kind: 'hazard', hazard: row.hazard, level: row.level, version: RULE_VERSION, status: RULE_STATUS, enabled: true, rule: row.rule, basis: row.basis,
        },
      },
      upsert: true,
    },
  }));
  const scenarios = scenarioIds.map((id) => ({
    updateOne: {
      filter: { key: id, version: RULE_VERSION },
      update: { $setOnInsert: { key: id, kind: 'scenario', version: RULE_VERSION, status: RULE_STATUS, enabled: true } },
      upsert: true,
    },
  }));
  await RuleSetting.bulkWrite([...operations, ...scenarios], { ordered: false });
}

export async function seedAreas() {
  const geo = loadGeoData();
  const divisionOf = new Map(districts.map((district) => [district.pcode, district.division]));

  const operations = [
    ...districts.map((district) => ({
      updateOne: {
        filter: { pcode: district.pcode },
        update: { $set: { pcode: district.pcode, kind: 'district', name: district.name, nameBn: district.nameBn ?? null, parentPcode: null, division: district.division, lat: district.lat, lon: district.lon } },
        upsert: true,
      },
    })),
    ...locations.map((location) => ({
      updateOne: {
        filter: { pcode: location.pcode },
        update: {
          $set: {
            pcode: location.pcode,
            kind: location.kind === 'thana' ? 'thana' : 'upazila',
            name: location.name,
            nameBn: location.nameBn ?? null,
            parentPcode: location.district,
            division: divisionOf.get(location.district) ?? null,
            lat: location.lat,
            lon: location.lon,
            forecastApproximate: false,
            urban: location.kind === 'thana',
            lightningCircleIds: geo.circles.filter((circle) => haversineKm(location.lat, location.lon, circle.lat, circle.lon) <= geo.apiRadiusKm).map((circle) => circle.id),
          },
        },
        upsert: true,
      },
    })),
  ];
  await Area.bulkWrite(operations, { ordered: false });
  return operations.length;
}
