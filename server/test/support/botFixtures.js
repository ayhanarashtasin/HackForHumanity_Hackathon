import { aggregateDistricts } from '../../src/services/aggregate.js';
import { districts, locationByPcode } from '../../src/services/geo.js';

// Forecast data for the bot's tests: the shape the BMD and Open-Meteo jobs store, built for a handful of places with values the tests can
// predict. "Now" is 10:00 in Bangladesh, which falls inside the 09:00-12:00 step (index 3).
export const HOUR = 3_600_000;
export const NOW = Date.parse('2026-10-11T04:00:00Z');
export const BADDA = '302604'; // a Dhaka city thana
export const SAVAR = '302672'; // a Dhaka-district upazila
export const AMTALI = '100409'; // Barguna
export const DHAKA = '3026';
export const NOW_INDEX = 3;
export const STEP_COUNT = 32; // four days

// 2026-10-10T18:00:00Z is 00:00 on the 11th in Bangladesh; steps are written the way the providers write them: +06:00 local time.
const FIRST_STEP_MS = Date.parse('2026-10-10T18:00:00Z');
export const steps = Array.from({ length: STEP_COUNT }, (_, i) => `${new Date(FIRST_STEP_MS + i * 3 * HOUR + 6 * HOUR).toISOString().slice(0, 19)}+06:00`);

// Overrides are { column: { index: value } }. Everything else follows a gentle daily curve.
function columnsFor(overrides = {}, { meteo = false } = {}) {
  const make = (fn) => Array.from({ length: STEP_COUNT }, (_, i) => fn(i));
  const temp = make((i) => 24 + 8 * Math.sin(((i % 8) - 2) * (Math.PI / 6)));
  const columns = {
    temp: temp.map((v) => Math.round(v * 10) / 10),
    hi: temp.map((v) => Math.round((v + 5) * 10) / 10),
    rh: make(() => 70),
    ws: make(() => 12),
    wd: make(() => 315),
    wg: make(() => 25),
    cc: make(() => 3),
    rf: make(() => 0),
  };
  if (meteo) {
    Object.assign(columns, {
      wmo: make(() => 2), ts: make(() => 0), pop: make(() => 20), cape: make(() => 500),
    });
  }
  for (const [key, changes] of Object.entries(overrides)) {
    if (!columns[key]) continue;
    for (const [index, value] of Object.entries(changes)) columns[key][Number(index)] = value;
  }
  return columns;
}

// One provider's stored data for some BMD locations plus its app-built district summaries.
export function sourceData(pcodes, overrides = {}, options = {}) {
  const locations = {};
  for (const pcode of pcodes) locations[pcode] = columnsFor(overrides[pcode] ?? overrides.all ?? {}, options);
  const wanted = districts.filter((district) => district.upazilas.some((pcode) => locations[pcode]));
  return { steps, locations, districts: aggregateDistricts(wanted, locations, STEP_COUNT) };
}

export const status = (value = 'ok', { dataTime = '2026-10-11T08:00:00+06:00', checkedAt = '2026-10-11T03:50:00Z' } = {}) => ({
  name: 'x', status: value, dataTime, fetchedAt: checkedAt, checkedAt, message: null,
});

// What loadForecast() takes instead of reading the live store.
export function forecastInputs({
  bmdOverrides = {}, meteoOverrides = {}, bmdStatus = 'ok', meteoStatus = 'ok', pcodes = [BADDA, SAVAR, AMTALI], bmd, openMeteo,
} = {}) {
  return {
    now: NOW,
    bmd: bmd === undefined ? sourceData(pcodes, bmdOverrides) : bmd,
    openMeteo: openMeteo === undefined ? sourceData(pcodes, meteoOverrides, { meteo: true }) : openMeteo,
    statuses: { bmd: status(bmdStatus), openMeteo: status(meteoStatus, { dataTime: null }) },
  };
}

export const locationName = (pcode) => locationByPcode.get(pcode)?.name;
