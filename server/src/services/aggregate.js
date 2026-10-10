// BMD publishes no district-level forecast, so district values are app-derived summaries of their upazila forecasts.
// Mean values describe the district overall; *Max values keep the worst upazila so a single wet or hot upazila is not averaged away.
const MEAN_KEYS = ['temp', 'rh', 'cc', 'hi', 'rf', 'ws', 'wg'];
const MAX_OF_KEYS = ['temp', 'rf', 'hi', 'ws', 'wg'];
const MAX_ONLY_KEYS = ['ts', 'pop', 'wmo', 'cape'];

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

function mean(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function max(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  return present.length ? Math.max(...present) : null;
}

export function circularMeanDegrees(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (!present.length) return null;

  const x = present.reduce((sum, value) => sum + Math.cos((value * Math.PI) / 180), 0);
  const y = present.reduce((sum, value) => sum + Math.sin((value * Math.PI) / 180), 0);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export function aggregateDistricts(districtList, locations, length) {
  const result = {};

  for (const district of districtList) {
    const members = district.upazilas.map((pcode) => locations[pcode]).filter(Boolean);
    if (!members.length) continue;

    const column = (key, reducer, digits) => {
      if (!members.some((member) => member[key])) return undefined;
      return Array.from({ length }, (_, i) => {
        const value = reducer(members.map((member) => member[key]?.[i] ?? null));
        return value === null ? null : round(value, digits);
      });
    };

    const summary = {};
    for (const key of MEAN_KEYS) {
      const col = column(key, mean, key === 'rf' ? 2 : 1);
      if (col) summary[key] = col;
    }
    for (const key of MAX_OF_KEYS) {
      const col = column(key, max, key === 'rf' ? 2 : 1);
      if (col) summary[`${key}Max`] = col;
    }
    for (const key of MAX_ONLY_KEYS) {
      const col = column(key, max, 0);
      if (col) summary[key] = col;
    }
    const direction = column('wd', circularMeanDegrees, 0);
    if (direction) summary.wd = direction;

    result[district.pcode] = summary;
  }

  return result;
}
