import { useState } from 'react';
import { BD_DIVISIONS, BD_OUTLINE } from '../lib/bdOutline.js';
import { outlinePoint } from '../lib/geometry.js';
import { prefetchPage } from '../pages/pageLoader.js';
import { Icon } from './Icon.jsx';
import { Link } from './Link.jsx';

const prefetchMap = prefetchPage('map');

// Categorical brand tints distinguish administrative areas, not weather conditions.
const REGION_TINTS = [42, 16, 62, 18, 32, 56, 20, 50];
const GRATICULE_LONS = [89, 90, 91, 92];
const GRATICULE_LATS = [21, 22, 23, 24, 25, 26];

export function BangladeshFigure() {
  const [hovered, setHovered] = useState(null);
  const [focused, setFocused] = useState(null);
  const active = hovered ?? focused;
  const { width, height, path } = BD_OUTLINE;
  const lonX = (lon) => outlinePoint(BD_OUTLINE, lon, 0).x;
  const latY = (lat) => outlinePoint(BD_OUTLINE, 0, lat).y;
  const divisionProps = (division, index) => ({
    to: `/map#view=${division.lat.toFixed(4)},${division.lon.toFixed(4)},${division.name === 'Chattogram' ? '6.8' : '7.5'}z`,
    'aria-label': `Explore ${division.name} division, ${division.districts} districts`,
    style: { '--division-fill': `color-mix(in srgb, var(--sage) ${REGION_TINTS[index]}%, var(--cream))` },
    onPointerEnter: () => { setHovered(division.name); prefetchMap(); },
    onPointerLeave: () => setHovered(null),
    onFocus: () => { setFocused(division.name); prefetchMap(); },
    onBlur: () => setFocused(null),
  });

  return (
    <figure className="bd-figure">
      <div className="bd-map-heading">
        <span>Find your division</span>
        <span className="bd-boundary-key"><span aria-hidden="true" />Division boundary</span>
      </div>
      <div className="bd-card">
        <div className="bd-stage" style={{ '--ar': width / height }}>
          <svg viewBox={`-8 -8 ${width + 16} ${height + 16}`} role="group" aria-label="Bangladesh's eight administrative divisions">
            <g className="bd-graticule" aria-hidden="true">
              {GRATICULE_LONS.map((lon) => <line key={lon} x1={lonX(lon)} x2={lonX(lon)} y1="0" y2={height} />)}
              {GRATICULE_LATS.map((lat) => <line key={lat} x1="0" x2={width} y1={latY(lat)} y2={latY(lat)} />)}
            </g>
            {BD_DIVISIONS.map((division, index) => (
              <Link
                key={division.name}
                {...divisionProps(division, index)}
                className={`bd-region${active === division.name ? ' is-active' : ''}`}
              >
                <title>{division.name} division · {division.districts} districts</title>
                <path className="bd-region-shape" d={division.path} fillRule="evenodd" />
              </Link>
            ))}
            <path className="bd-national-border" d={path} aria-hidden="true" />
            <g className="bd-region-labels" aria-hidden="true">
              {BD_DIVISIONS.map((division, index) => (
                <g key={division.name} className={`bd-area-label${active === division.name ? ' is-active' : ''}`} transform={`translate(${division.label.join(' ')})`}>
                  <circle r="17" />
                  <text className="bd-region-number" textAnchor="middle" dominantBaseline="central">{String(index + 1).padStart(2, '0')}</text>
                  <text className="bd-region-name" textAnchor="middle" y="35">{division.name}</text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      </div>
      <ul className="bd-division-list" aria-label="Choose a division">
        {BD_DIVISIONS.map((division, index) => (
          <li key={division.name}>
            <Link {...divisionProps(division, index)} className={`bd-division-link${active === division.name ? ' is-active' : ''}`}>
              <span className="bd-division-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <span className="bd-division-info"><strong>{division.name}</strong><span>{division.districts} districts</span></span>
              <Icon name="arrow" size={15} />
            </Link>
          </li>
        ))}
      </ul>
      <figcaption>Each outlined area is a division. Select a region or its name to explore the weather map.</figcaption>
    </figure>
  );
}
