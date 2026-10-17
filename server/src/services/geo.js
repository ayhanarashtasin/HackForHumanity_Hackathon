import fs from 'node:fs';

// Committed static catalogue: BMD locations joined with HDX boundaries.
let catalogue;
try {
  catalogue = JSON.parse(fs.readFileSync(new URL('../../data/locations.json', import.meta.url), 'utf8'));
} catch (error) {
  throw new Error(`server/data/locations.json is missing or invalid. Restore it from the repository. (${error.message})`);
}

export const locations = catalogue.locations;
export const districts = catalogue.districts;
export const polygons = catalogue.polygons;
export const pcodes = locations.map((location) => location.pcode);
export const locationByPcode = new Map(locations.map((location) => [location.pcode, location]));

export function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}
