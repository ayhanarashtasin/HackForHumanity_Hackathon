// design.md: the only three UI colors. Everything in the interface is one of these or a tint/alpha of them.
export const PALETTE = {
  cream: '#E8E9DF', // Soft White
  sage: '#A9BE87', // Sage Green
  olive: '#2E3D28', // Deep Olive
};

// Data-status colors (design.md "Data status"): never a calm color for missing data.
export const STATUS_COLORS = {
  ok: PALETTE.sage,
  stale: '#8C9A80',
  unavailable: '#6B7568',
  'not-checked': '#6B7568',
};

// Basemap shades derived from the palette so data layers stand out on the Deep Olive canvas.
export const BASEMAP = {
  land: '#2E3D28',
  country: '#344731',
  water: '#222E1E',
  road: '#3E5136',
  label: '#E8E9DF',
  labelDim: '#A9BE87',
  halo: '#2E3D28',
};
