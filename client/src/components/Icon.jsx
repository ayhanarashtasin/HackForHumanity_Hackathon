// One outline icon family (24px grid, 1.75 stroke, round caps) across the site.
const SHAPES = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  maximize: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />,
  minimize: <path d="M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  map: <><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></>,
  route: <><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H12a3 3 0 0 0 3-3v-3a3 3 0 0 1 3-3" /></>,
  thermometer: <path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" />,
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6.4-6.4" /></>,
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 0 1 0 9z" />,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  locate: <><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z" /><circle cx="12" cy="10" r="2.5" /></>,
  layers: <><path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
  rain: <><path d="M18 14h.5a3.5 3.5 0 0 0 0-7H17A5.5 5.5 0 1 0 6 9a2.5 2.5 0 0 0 0 5h1M9 16l-1 4M14 16l-1 4M19 17l-1 3" /></>,
  drop: <path d="M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12z" />,
  wind: <><path d="M3 8h12a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h6a3 3 0 1 1-3 3" /></>,
  play: <path d="m8 5 11 7-11 7z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  chart: <><path d="M4 3v17h17M7 14l4-5 4 3 5-7" /></>,
  bell: <><path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  // Severity shapes: a circle, a triangle and an octagon, so the level never depends on colour alone.
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>,
  warning: <><path d="M12 3 2.5 20h19z" /><path d="M12 10v5M12 17.5v.01" /></>,
  critical: <><path d="M8.5 2.5h7L21.5 8.5v7l-6 6h-7l-6-6v-7z" /><path d="M12 7.5v6M12 16.5v.01" /></>,
  send: <><path d="M21 3 10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2M20 20v-5h-5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  logout: <><path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></>,
  list: <><path d="M8 6h12M8 12h12M8 18h12M4 6v.01M4 12v.01M4 18v.01" /></>,
  hospital: <><path d="M4 21V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12" /><path d="M9 21v-6h6v6" /><path d="M12 3v4M10 5h4" /></>,
  phone: <path d="M6 3h3l2 5-2.5 1.5a11 11 0 0 0 5 5L15 12l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z" />,
};

// Decorative by default: the text next to an icon carries the meaning.
export function Icon({ name, size = 22 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
