import { useState } from 'react';
import { BangladeshFigure } from '../components/BangladeshFigure.jsx';
import { Icon } from '../components/Icon.jsx';
import { Link } from '../components/Link.jsx';
import { LogoMark } from '../components/Logo.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { STATUS_COLORS } from '../lib/palette.js';
import { prefetchPage } from './pageLoader.js';
import '../landing.css';

const prefetchMap = prefetchPage('map');

// Everything below describes what the map does today. Occupation-aware advice (the scenario catalogue) is not built yet,
// and the page says so rather than implying it.
const FACTS = [
  { value: '64', label: 'districts' },
  { value: '544', label: 'upazilas and city thanas' },
  { value: '10 min', label: 'between radar frames' },
  { value: '4 days', label: 'of 3-hourly forecast steps' },
];

const FEATURES = [
  { icon: 'thermometer', title: 'The day, in detail.', text: 'Temperature, heat index, rain, wind and thunderstorm potential. A local forecast, down to your upazila.', label: 'Weather signs' },
  { icon: 'radar', title: 'Watch the rain move.', text: 'BMD ground radar from Dhaka and Rangpur. A new frame every 10 minutes, with three hours to look back.', label: 'BMD radar' },
  { icon: 'cloud', title: 'A wider perspective.', text: 'Himawari-9 infrared and visible satellite imagery. About an hour behind real time, with the delay clearly shown.', label: 'Satellite clouds' },
  { icon: 'bolt', title: 'Know the storm signals.', text: 'Lightning counts within 100 km search circles, sampled three times a day. A snapshot, not live strike tracking.', label: 'Lightning summaries' },
  { icon: 'clock', title: 'Look back. Plan ahead.', text: "Replay recent radar and satellite frames, or explore BMD's next four days of forecasts in three-hour steps.", label: 'Weather timeline' },
  { icon: 'search', title: 'Your place. Your language.', text: 'Search in Bangla or English, বাড্ডা included. Find your district or upazila and go straight to its forecast.', label: 'Local search' },
];

const HOW_TO_READ = [
  { title: 'Forecast, not measurement.', text: 'Temperature, rain and wind are BMD model values, not station readings. Heat index is computed from them.' },
  { title: 'Observation or potential.', text: 'Radar and satellite are observations. Thunderstorm signs show potential, not lightning strikes.' },
  { title: 'A source and a time.', text: 'Every value names where it came from. Stale data is muted and carries its last update time.' },
  { title: 'Not an official warning.', text: 'Follow Bangladesh Meteorological Department warnings and local guidance.' },
];

const STATUSES = [
  { key: 'ok', name: 'Fresh', text: 'Full color, with its source and data time.', color: STATUS_COLORS.ok, style: 'solid' },
  { key: 'stale', name: 'Stale', text: 'Muted, with a “stale” badge and the last update time.', color: STATUS_COLORS.stale, style: 'solid' },
  { key: 'unavailable', name: 'No data', text: 'Neutral grey and “Data unavailable”. Never a calm color.', color: STATUS_COLORS.unavailable, style: 'dotted' },
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
  { href: '#who', label: "Who it's for" },
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
  const [skyPaused, setSkyPaused] = useState(false);

  return (
    <div className="landing">
      <a className="skip-link" href="#main">Skip to content</a>
      <Navbar />

      <main id="main">
        <section id="top" className="hero" data-tone="light" aria-labelledby="hero-title">
          <div className="hero-art" data-paused={skyPaused}><SkySculpture /></div>
          <div className="container hero-layout">
            <p className="hero-edition"><span lang="bn">আকাশসাথী</span><span>Made for Bangladesh</span></p>
            <p className="hero-note hero-note--left">A sky full of signals.<br />A little more clarity<br />for your everyday.</p>
            <div className="hero-copy">
              <p className="eyebrow" style={{ '--i': 0 }}>A clearer view of</p>
              <h1 id="hero-title" style={{ '--i': 1 }}>Your <span>tomorrow.</span></h1>
              <p className="lead" style={{ '--i': 2 }}>
                Meet your sky, a little closer. Forecasts, rain radar and satellite clouds for every district and upazila of Bangladesh, in one thoughtful weather map.
              </p>
              <div className="hero-actions" style={{ '--i': 3 }}>
                <Link to="/map" className="btn btn-primary" onPointerEnter={prefetchMap} onFocus={prefetchMap}>Open the map<Icon name="arrow" size={20} /></Link>
                <a href="#features" className="btn btn-ghost">Explore the details<Icon name="arrow" size={18} /></a>
              </div>
            </div>
            <p className="hero-note hero-note--right">Local weather.<br />Wider perspective.<br /><span>Clearer decisions.</span></p>
            <div className="hero-bottom">
              <p><span>01 /</span> A little perspective</p>
              <a className="scroll-cue" href="#features" aria-label="Scroll to features"><Icon name="arrow" size={19} /></a>
              <div className="hero-bottom-right">
                <p>Weather for the everyday.</p>
                <button
                  type="button"
                  className="hero-motion-control"
                  aria-label={skyPaused ? 'Resume background animation' : 'Pause background animation'}
                  onClick={() => setSkyPaused((paused) => !paused)}
                >
                  {skyPaused ? 'Resume motion' : 'Pause motion'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="facts" data-tone="light" aria-label="Coverage at a glance">
          <dl className="container facts-grid">
            {FACTS.map((fact) => (
              <div key={fact.label} className="fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section id="features" className="section section-light" data-tone="light" aria-labelledby="features-title">
          <div className="container">
            <header className="section-head">
              <p className="eyebrow"><span className="section-number">02 /</span> The bigger picture</p>
              <h2 id="features-title">Many signals.<br /><em>One clear picture.</em></h2>
              <p className="lead">A little less switching between apps. A little more understanding the sky. All your weather layers, together on one map.</p>
            </header>
            <ul className="feature-grid">
              {FEATURES.map((feature, index) => (
                <li key={feature.title} className="feature-card">
                  <div className="feature-top"><span className="feature-icon"><Icon name={feature.icon} size={25} /></span><span className="card-number">0{index + 1}</span></div>
                  <p className="feature-label">{feature.label}</p>
                  <h3>{feature.title}</h3>
                  <p>{feature.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="coverage" className="section coverage" data-tone="light" aria-labelledby="coverage-title">
          <div className="container coverage-grid">
            <div className="coverage-visual">
              <div className="figure-label"><span>Bangladesh / 8 divisions · 64 districts</span><Icon name="map" size={18} /></div>
              <BangladeshFigure />
            </div>
            <div className="coverage-copy">
              <p className="eyebrow"><span className="section-number">03 /</span> Closer to home</p>
              <h2 id="coverage-title">The whole country.<br /><em>Your little corner.</em></h2>
              <p className="lead">From Rangpur to Chattogram, the sky tells a different story. Start with Bangladesh, zoom into your upazila, and find the forecast that belongs to your day.</p>
              <Link to="/map" className="text-link" onPointerEnter={prefetchMap} onFocus={prefetchMap}>Find your place<Icon name="arrow" size={20} /></Link>
              <div className="coverage-source">
                <p className="eyebrow">A view grounded in real sources</p>
                <p>BMD forecasts & radar</p>
                <p>JMA Himawari-9 imagery via NASA GIBS</p>
              </div>
            </div>
          </div>
        </section>

        <section id="data" className="section section-paper" data-tone="light" aria-labelledby="data-title">
          <div className="container data-grid">
            <div>
              <header className="section-head">
                <p className="eyebrow"><span className="section-number">04 /</span> Clarity, not guesswork</p>
                <h2 id="data-title">A little certainty.<br /><em>And honest uncertainty.</em></h2>
                <p className="lead">Knowing what we don't know matters, too. Every source has a name, every update has a time, and missing data never looks like a calm sky.</p>
              </header>
              <ul className="read-list">
                {HOW_TO_READ.map((item) => (
                  <li key={item.title}>
                    <span className="read-check"><Icon name="check" size={16} /></span>
                    <p><strong>{item.title}</strong> {item.text}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="status-card" role="group" aria-labelledby="status-title">
              <p className="eyebrow">A note on the data</p>
              <h3 id="status-title">Three states.<br />Nothing left to guess.</h3>
              <ul>
                {STATUSES.map((status) => (
                  <li key={status.key}>
                    <span className="status-ring" style={{ '--ring': status.color, borderStyle: status.style }} aria-hidden="true" />
                    <div>
                      <strong>{status.name}</strong>
                      <p>{status.text}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="status-footnote">A clear grey where there is no data.<br />Always a source. Always a timestamp.</p>
            </div>
          </div>
        </section>

        <section id="who" className="section section-light" data-tone="light" aria-labelledby="who-title">
          <div className="container">
            <header className="section-head">
              <p className="eyebrow"><span className="section-number">05 /</span> Under the same sky</p>
              <h2 id="who-title">Different days.<br /><em>The same sky.</em></h2>
              <p className="lead">
                A rain forecast means one thing to a farmer with paddy drying on the ground and another to a rickshaw puller on a slick road.
                We have written 31 occupation scenarios to turn one weather hazard into advice that fits what each person is doing.
              </p>
              <p className="badge-line"><span className="pill">Next phase</span>Occupation-aware advice is still in design. Today's map is the foundation it will stand on.</p>
            </header>
            <ul className="audience-grid">
              {AUDIENCES.map((audience) => (
                <li key={audience.code} className="audience-card">
                  <p className="audience-code"><span>{audience.code}</span>{audience.count} scenarios</p>
                  <h3>{audience.title}</h3>
                  <p>{audience.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cta" data-tone="light" aria-labelledby="cta-title">
          <div className="container cta-inner">
            <p className="eyebrow"><span className="section-number">06 /</span> Your day starts here</p>
            <h2 id="cta-title">Step outside.<br /><em>A little more prepared.</em></h2>
            <p>A clearer view of the weather. A calmer way to plan your day.</p>
            <Link to="/map" className="btn btn-dark" onPointerEnter={prefetchMap} onFocus={prefetchMap}>Open the map<Icon name="arrow" size={20} /></Link>
          </div>
        </section>
      </main>

      <footer className="footer" data-tone="light">
        <div className="container footer-grid">
          <div className="footer-brand">
            <p className="footer-logo"><LogoMark size={34} /><span>AkashSathi</span></p>
            <p>Weather for everyone who works under the open sky.</p>
          </div>
          <nav aria-label="Footer">
            <ul className="footer-links">
              {FOOTER_LINKS.map((link) => <li key={link.href}><a href={link.href}>{link.label}</a></li>)}
              <li><Link to="/map">Map</Link></li>
            </ul>
          </nav>
        </div>
        <div className="container footer-fine">
          <p>
            Forecast and radar © Bangladesh Meteorological Department. Himawari-9 imagery © JMA via NASA GIBS. Forecast supplement by Open-Meteo (CC BY 4.0).
            Boundaries: OCHA/HDX COD-AB (CC BY-IGO). Basemap labels: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.
          </p>
          <p>AkashSathi is not an official warning service. For official warnings, follow the Bangladesh Meteorological Department and local authorities.</p>
        </div>
      </footer>
    </div>
  );
}
