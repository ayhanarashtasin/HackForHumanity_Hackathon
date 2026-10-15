import { useState } from 'react';
import { BangladeshFigure } from '../components/BangladeshFigure.jsx';
import { Icon } from '../components/Icon.jsx';
import { Link } from '../components/Link.jsx';
import { LogoMark } from '../components/Logo.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { STATUS_COLORS } from '../lib/palette.js';
import { useLanguage } from '../i18n/index.js';
import { LANDING } from '../i18n/landing.js';
import { prefetchPage } from './pageLoader.js';
import '../landing.css';

const prefetchMap = prefetchPage('map');

// Describe shipped features without implying expert validation or continuous lightning monitoring.
const FACTS = [
  { value: '64', label: 'districts' },
  { value: '544', label: 'upazilas and city thanas' },
  { value: '10 min', label: 'between radar frames' },
  { value: '4 days', label: 'of 3-hourly forecast steps' },
];

const FEATURES = [
  { icon: 'thermometer', title: "Today's weather, in detail.", text: 'Temperature, heat index, rain, wind and thunderstorm potential. A local forecast, down to your upazila.', label: 'Weather forecast' },
  { icon: 'radar', title: 'Watch the rain move.', text: 'BMD ground radar from Dhaka and Rangpur. A new frame every 10 minutes, with three hours to look back.', label: 'BMD radar' },
  { icon: 'cloud', title: 'Clouds across the region.', text: 'Himawari-9 infrared and visible satellite imagery. About an hour behind real time, with the delay clearly shown.', label: 'Satellite imagery' },
  { icon: 'bolt', title: 'Understand lightning activity.', text: 'Lightning counts within 100 km search circles, sampled three times a day. A snapshot, not live strike tracking.', label: 'Lightning summaries' },
  { icon: 'clock', title: 'Look back. Plan ahead.', text: "Replay recent radar and satellite frames, or explore BMD's next four days of forecasts in three-hour steps.", label: 'Weather timeline' },
  { icon: 'search', title: 'Your place. Your language.', text: 'Search for your district or upazila in Bangla or English and go straight to its forecast.', label: 'Local search' },
];

const HOW_TO_READ = [
  { title: 'Forecasts Are Not Direct Measurements', text: 'Temperature, rainfall, and wind speed values are obtained from BMD weather models, not directly measured at weather stations. Heat index is calculated from these values.' },
  { title: 'Observations and Predictions Are Different', text: 'Radar and satellite images show observed weather conditions. Thunderstorm indicators suggest potential activity but do not confirm that lightning is occurring.' },
  { title: 'Every Data Point Includes Its Source and Time', text: 'The source of each value is displayed. Outdated information appears in a muted color, along with the time it was last updated.' },
  { title: 'This Is Not an Official Weather Warning', text: 'Follow official warnings issued by the Bangladesh Meteorological Department and guidance from local authorities.' },
];

const STATUSES = [
  { key: 'ok', name: 'Latest Data', text: 'Displayed in full color, with its source and update time.', color: STATUS_COLORS.ok, style: 'solid' },
  { key: 'stale', name: 'Outdated Data', text: 'Displayed in a muted color with a “Stale” label and the last update time.', color: STATUS_COLORS.stale, style: 'solid' },
  { key: 'unavailable', name: 'No Data', text: 'Displayed in grey with an “Unavailable” label, so it is not mistaken for normal weather conditions.', color: STATUS_COLORS.unavailable, style: 'dotted' },
];

const AUDIENCES = [
  { code: 'FARM', count: 5, title: 'Farmers', text: 'Rain during harvest and rain during planting call for different advice.' },
  { code: 'FISH', count: 5, title: 'Fishermen', text: "A river warning and a marine warning don't cover the same waters." },
  { code: 'WORK', count: 5, title: 'Rickshaw pullers and day labourers', text: 'A pleasant morning can hide a punishing midday.' },
  { code: 'CONS', count: 4, title: 'Construction workers', text: 'Lightning or strong wind while working at height means stop and get down.' },
  { code: 'VEND', count: 3, title: 'Street vendors', text: 'Secure the stall before a storm, never in the middle of one.' },
  { code: 'PUBLIC', count: 5, title: 'Everyone else, students included', text: 'A rain forecast is not proof that the roads are flooded.' },
];

const FOOTER_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#who', label: "Who It's For" },
  { href: '#data', label: 'Data' },
];

// A decorative glass-and-cloud study, not a weather observation. All fills use the brand palette.
// Each moving part is its own layer (an <svg> or a <div> of <svg>s stacked on the same 760 x 660 box). The browser paints a layer once and
// then only moves it, on the graphics card. When all the parts were groups inside one <svg>, every frame of every animation repainted the
// whole illustration (gradients, strokes and the blur) on the processor: about a third of a CPU core while the hero was on screen.
const SKY_VIEW = '0 0 760 660';

function SkySculpture() {
  return (
    <div className="sky-sculpture" aria-hidden="true">
      <svg className="sky-defs" width="0" height="0" focusable="false">
        <defs>
          <radialGradient id="sky-sun" cx="0.3" cy="0.25" r="0.8">
            <stop stopColor="var(--cream)" />
            <stop offset="0.5" stopColor="var(--sage)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--olive)" stopOpacity="0.15" />
          </radialGradient>
          <linearGradient id="sky-glass" x1="170" y1="150" x2="560" y2="490" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--cream)" stopOpacity="0.72" />
            <stop offset="0.5" stopColor="var(--sage)" stopOpacity="0.12" />
            <stop offset="1" stopColor="var(--cream)" stopOpacity="0.6" />
          </linearGradient>
          <radialGradient id="sky-cloud" cx="0.35" cy="0.2" r="0.8">
            <stop stopColor="var(--cream)" />
            <stop offset="0.65" stopColor="var(--cream)" stopOpacity="0.85" />
            <stop offset="1" stopColor="var(--sage)" stopOpacity="0.42" />
          </radialGradient>
          <filter id="sky-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="18" />
          </filter>
        </defs>
      </svg>

      <svg className="sky-layer" viewBox={SKY_VIEW} fill="none" focusable="false">
        <ellipse cx="391" cy="533" rx="180" ry="20" fill="var(--olive)" opacity="0.1" filter="url(#sky-soft)" />
      </svg>

      <div className="sky-layer sky-globe">
        <svg viewBox={SKY_VIEW} fill="none" focusable="false">
          <circle cx="444" cy="228" r="163" fill="url(#sky-sun)" />
          <circle cx="444" cy="228" r="162" stroke="var(--cream)" strokeOpacity="0.65" />
        </svg>
        <svg className="sky-globe-grid" viewBox={SKY_VIEW} fill="none" focusable="false" stroke="var(--olive)" strokeOpacity="0.13">
          <ellipse cx="444" cy="228" rx="120" ry="163" />
          <ellipse cx="444" cy="228" rx="64" ry="163" />
          <ellipse cx="444" cy="228" rx="163" ry="61" transform="rotate(-22 444 228)" />
          <ellipse cx="444" cy="228" rx="163" ry="111" transform="rotate(-22 444 228)" />
        </svg>
      </div>

      <svg className="sky-layer sky-glass" viewBox={SKY_VIEW} fill="none" focusable="false">
        <rect x="155" y="155" width="370" height="365" rx="140" transform="rotate(-24 340 337)" fill="url(#sky-glass)" stroke="var(--cream)" strokeOpacity="0.9" strokeWidth="1.5" />
        <path d="M159 350c-17-65 21-133 85-155" stroke="var(--cream)" strokeOpacity="0.85" strokeWidth="3" strokeLinecap="round" />
      </svg>

      <svg className="sky-layer sky-cloud" viewBox={SKY_VIEW} focusable="false" fill="url(#sky-cloud)" stroke="var(--cream)" strokeOpacity="0.6">
        <ellipse cx="454" cy="425" rx="143" ry="76" />
        <circle cx="399" cy="370" r="83" />
        <circle cx="486" cy="382" r="67" />
        <circle cx="330" cy="416" r="67" />
      </svg>

      <svg className="sky-layer sky-orbit" viewBox={SKY_VIEW} fill="none" focusable="false">
        <ellipse cx="379" cy="326" rx="283" ry="111" transform="rotate(-31 379 326)" stroke="var(--olive)" strokeOpacity="0.2" />
        <path d="M139 439c79 40 245-2 386-91 91-58 156-123 171-169" stroke="var(--cream)" strokeOpacity="0.85" strokeWidth="2" />
        <circle cx="157" cy="432" r="7" fill="var(--sage)" stroke="var(--cream)" strokeWidth="2" />
        <circle cx="639" cy="217" r="4" fill="var(--olive)" fillOpacity="0.4" />
      </svg>
    </div>
  );
}

export function LandingPage() {
  const { tr, number } = useLanguage(LANDING);
  const [skyPaused, setSkyPaused] = useState(false);

  return (
    <div className="landing landing-home">
      <a className="skip-link" href="#main">{tr('Skip to content')}</a>
      <Navbar />

      <main id="main">
        <section id="top" className="hero" data-tone="light" aria-labelledby="hero-title">
          <div className="hero-art" data-paused={skyPaused}><SkySculpture /></div>
          <div className="container hero-layout">
            <p className="hero-edition"><span lang="bn">আকাশসাথী</span><span>{tr('Made for Bangladesh')}</span></p>
            <p className="hero-note hero-note--left">{tr('A sky full of signals.')}<br />{tr('A little more clarity')}<br />{tr('for your everyday.')}</p>
            <div className="hero-copy">
              <p className="eyebrow" style={{ '--i': 0 }}>{tr('A clearer view of')}</p>
              <h1 id="hero-title" style={{ '--i': 1 }}>{tr('Your')} <span>{tr('tomorrow.')}</span></h1>
              <p className="lead" style={{ '--i': 2 }}>
                {tr('Meet your sky, a little closer. Forecasts, rain radar and satellite clouds for every district and upazila of Bangladesh, in one thoughtful weather map.')}
              </p>
              <div className="hero-actions" style={{ '--i': 3 }}>
                <Link to="/map" className="btn btn-primary" onPointerEnter={prefetchMap} onFocus={prefetchMap}>{tr('Open the map')}<Icon name="arrow" size={20} /></Link>
                <a href="#features" className="btn btn-ghost">{tr('Explore the details')}<Icon name="arrow" size={18} /></a>
              </div>
            </div>
            <p className="hero-note hero-note--right">{tr('Local weather.')}<br />{tr('Wider perspective.')}<br /><span>{tr('Clearer decisions.')}</span></p>
            <div className="hero-bottom">
              <p><span>{number('01')} /</span> {tr('Overview')}</p>
              <a className="scroll-cue" href="#features" aria-label={tr('Scroll to features')}><Icon name="arrow" size={19} /></a>
              <div className="hero-bottom-right">
                <p>{tr('Weather for the everyday.')}</p>
                <button
                  type="button"
                  className="hero-motion-control"
                  aria-label={tr(skyPaused ? 'Resume background animation' : 'Pause background animation')}
                  onClick={() => setSkyPaused((paused) => !paused)}
                >
                  {tr(skyPaused ? 'Resume motion' : 'Pause motion')}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="facts" data-tone="light" aria-label={tr('Coverage at a glance')}>
          <dl className="container facts-grid">
            {FACTS.map((fact) => (
              <div key={fact.label} className="fact">
                <dt>{tr(fact.label)}</dt>
                <dd>{number(tr(fact.value))}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="features" className="section section-light" data-tone="light" aria-labelledby="features-title">
          <div className="container">
            <header className="section-head">
              <p className="eyebrow"><span className="section-number">{number('02')} /</span> {tr('The bigger picture')}</p>
              <h2 id="features-title">{tr('Know the forecast,')}<br /><em>{tr('prepare for tomorrow.')}</em></h2>
              <p className="lead">{tr('See forecasts, BMD radar, satellite imagery and lightning, from the whole country down to your upazila.')}</p>
            </header>
            <ul className="feature-grid">
              {FEATURES.map((feature, index) => (
                <li key={feature.title} className="feature-card">
                  <div className="feature-top"><span className="feature-icon"><Icon name={feature.icon} size={25} /></span><span className="card-number">{number(String(index + 1).padStart(2, '0'))}</span></div>
                  <p className="feature-label">{tr(feature.label)}</p>
                  <h3>{tr(feature.title)}</h3>
                  <p>{tr(feature.text)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="coverage" className="section coverage" data-tone="light" aria-labelledby="coverage-title">
          <div className="container coverage-grid">
            <div className="coverage-visual">
              <div className="figure-label"><span>{tr('Bangladesh / 8 divisions · 64 districts')}</span><Icon name="map" size={18} /></div>
              <BangladeshFigure />
            </div>
            <div className="coverage-copy">
              <p className="eyebrow"><span className="section-number">{number('03')} /</span> {tr('Closer to home')}</p>
              <h2 id="coverage-title">{tr('Weather across the country.')}<br /><em>{tr('Your local weather.')}</em></h2>
              <p className="lead">{tr('From Rangpur to Chattogram, the sky tells a different story. Start with Bangladesh, zoom into your upazila, and find the forecast that belongs to your day.')}</p>
              <Link to="/map" className="text-link" onPointerEnter={prefetchMap} onFocus={prefetchMap}>{tr('Find your place')}<Icon name="arrow" size={20} /></Link>
              <div className="coverage-source">
                <p className="eyebrow">{tr('A view grounded in real sources')}</p>
                <p>{tr('BMD forecasts & radar')}</p>
                <p>{tr('JMA Himawari-9 imagery via NASA GIBS')}</p>
              </div>
            </div>
          </div>
        </section>

        <section id="data" className="section section-paper" data-tone="light" aria-labelledby="data-title">
          <div className="container data-grid">
            <div>
              <header className="section-head">
                <p className="eyebrow"><span className="section-number">{number('04')} /</span> {tr('Data Reliability')}</p>
                <h2 id="data-title">{tr('Reliable Information,')} <em>{tr('Informed Decisions.')}</em></h2>
                <p className="lead">{tr('Understand where each piece of information comes from, how reliable it is, and what its limitations are before making decisions.')}</p>
              </header>
              <ul className="read-list">
                {HOW_TO_READ.map((item) => (
                  <li key={item.title}>
                    <span className="read-check"><Icon name="check" size={16} /></span>
                    <p><strong>{tr(item.title)}</strong> {tr(item.text)}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="status-card" role="group" aria-labelledby="status-title">
              <p className="eyebrow">{tr('Color Indicators')}</p>
              <h3 id="status-title">{tr('Three Data Statuses')}</h3>
              <ul>
                {STATUSES.map((status) => (
                  <li key={status.key}>
                    <span className="status-ring" style={{ '--ring': status.color, borderStyle: status.style }} aria-hidden="true" />
                    <div>
                      <strong>{tr(status.name)}</strong>
                      <p>{tr(status.text)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="who" className="section section-light" data-tone="light" aria-labelledby="who-title">
          <div className="container">
            <header className="section-head">
              <p className="eyebrow"><span className="section-number">{number('05')} /</span> {tr('Under the same sky')}</p>
              <h2 id="who-title">{tr('Different jobs,')}<br /><em>{tr('different weather risks.')}</em></h2>
              <p className="lead">
                {tr('The same weather does not affect everyone’s work and daily life in the same way. AkashSathi includes 27 occupation-based scenarios with the precautions for each. Find advice that fits your occupation, area and current weather.')}
              </p>
              <p className="badge-line"><span className="pill">{tr('Prototype alerts')}</span>{tr('Occupation-based alerts are available. This advice is experimental and does not replace official warnings.')}</p>
            </header>
            <ul className="audience-grid">
              {AUDIENCES.map((audience) => (
                <li key={audience.code} className="audience-card">
                  <p className="audience-code"><span>{tr(audience.code)}</span>{tr('{n} scenarios', { n: audience.count })}</p>
                  <h3>{tr(audience.title)}</h3>
                  <p>{tr(audience.text)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cta" data-tone="light" aria-labelledby="cta-title">
          <div className="container cta-inner">
            <p className="eyebrow"><span className="section-number">{number('06')} /</span> {tr('Your day starts here')}</p>
            <h2 id="cta-title">{tr('Step outside.')}<br /><em>{tr('A little more prepared.')}</em></h2>
            <p>{tr('A clearer view of the weather. A calmer way to plan your day.')}</p>
            <Link to="/map" className="btn btn-dark" onPointerEnter={prefetchMap} onFocus={prefetchMap}>{tr('Open the map')}<Icon name="arrow" size={20} /></Link>
          </div>
        </section>
      </main>

      <footer className="footer" data-tone="light">
        <div className="container footer-grid">
          <div className="footer-brand">
            <p className="footer-logo"><LogoMark size={34} /><span>{tr('AkashSathi')}</span></p>
            <p>{tr('Weather for everyone who works under the open sky.')}</p>
          </div>
          <nav aria-label={tr('Footer')}>
            <ul className="footer-links">
              {FOOTER_LINKS.map((link) => <li key={link.href}><a href={link.href}>{tr(link.label)}</a></li>)}
              <li><Link to="/map">{tr('Map')}</Link></li>
            </ul>
          </nav>
        </div>
        <div className="container footer-fine">
          <p>
            {tr('Forecast and radar © Bangladesh Meteorological Department. Himawari-9 imagery © JMA via NASA GIBS; storm tracking uses JMA Himawari-9 data via NOAA Open Data Dissemination. Forecast supplement by Open-Meteo (CC BY 4.0). Boundaries: OCHA/HDX COD-AB (CC BY-IGO). Basemap labels: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.')}
          </p>
          <p>{tr('AkashSathi is not an official warning service. For official warnings, follow the Bangladesh Meteorological Department and local authorities.')}</p>
        </div>
      </footer>
    </div>
  );
}
