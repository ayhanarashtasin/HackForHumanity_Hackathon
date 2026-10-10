// Display thresholds. These are provisional values for map symbols only, NOT alert rules:
// the scenario catalogue requires expert review and data testing before any numeric alert threshold is adopted.

// Thunderstorm *potential* (0 = none, 1-3 = rising). Derived from Open-Meteo CAPE, precipitation probability and WMO weather code.
// CAPE is high across the tropics most afternoons (Bangladesh median ~1,700 J/kg), so it only counts together with a precipitation signal.
export const thunderPotential = {
  thunderCodeFrom: 95, // WMO 95-99 = thunderstorm forecast
  level3: { cape: 2000, pop: 70 },
  level2: { cape: 1500, pop: 60 },
  level1: { cape: 1000, pop: 50 },
  showerCodes: [80, 81, 82, 85, 86],
  showerCape: 1500,
};

// Heat index categories (NWS edges, °C) used for legend labels only.
export const heatIndexCategories = [
  { from: 27, label: 'Caution' },
  { from: 32, label: 'Extreme caution' },
  { from: 39, label: 'Danger' },
  { from: 51, label: 'Extreme danger' },
];
