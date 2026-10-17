import { useEffect, useRef, useState } from 'react';
import { useUnreadBadge } from '../alert/useUnreadBadge.js';
import { navigate, useRoute } from '../lib/router.js';
import { prefetchPage } from '../pages/pageLoader.js';
import { Icon } from './Icon.jsx';
import { Link } from './Link.jsx';
import { LogoMark } from './Logo.jsx';
import { LanguageToggle } from './LanguageToggle.jsx';
import { useLanguage } from '../i18n/index.js';

const prefetchMap = prefetchPage('map');
const prefetchRoute = prefetchPage('route');
const prefetchAlert = prefetchPage('alert');

// The logo and section links sit on the left; Alert and Map form the far-right group.
// "Data" lives in the footer and in the phone menu.
const SECTION_LINKS = [{ id: 'features', label: 'Features' }, { id: 'who', label: "Who It's For" }];
const MENU_ONLY_LINKS = [{ id: 'data', label: 'Data' }];
const MENU_BREAKPOINT = 860;

// Track the section beneath the floating bar and the active section near the middle of the screen.
function useNavState(headerRef) {
  const [state, setState] = useState({ tone: 'light', scrolled: false, active: null });

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = 0;
      const bounds = headerRef.current?.getBoundingClientRect();
      const probe = bounds ? bounds.top + bounds.height / 2 : 60;
      const focus = window.innerHeight * 0.4;
      let tone = 'light';
      let active = null;

      for (const element of document.querySelectorAll('[data-tone]')) {
        const { top, bottom } = element.getBoundingClientRect();
        if (top <= probe && bottom > probe) tone = element.dataset.tone;
        if (element.id && top <= focus && bottom > focus) active = element.id;
      }

      const scrolled = window.scrollY > 8;
      setState((previous) => (previous.tone === tone && previous.scrolled === scrolled && previous.active === active ? previous : { tone, scrolled, active }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, [headerRef]);

  return state;
}

export function Navbar({ onLanguageChange, languageDisabled = false }) {
  const { tr, number } = useLanguage();
  const headerRef = useRef(null);
  const toggleRef = useRef(null);
  const [open, setOpen] = useState(false);
  const { tone, scrolled, active } = useNavState(headerRef);
  const route = useRoute();
  const unread = useUnreadBadge();
  const onHome = route === 'home';

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onPointerDown = (event) => { if (!headerRef.current?.contains(event.target)) setOpen(false); };
    const onResize = () => { if (window.innerWidth > MENU_BREAKPOINT) setOpen(false); };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  // On the landing page the links scroll to their section; from any other page they go back to it without a full reload.
  const sectionLink = (link) => (
    <li key={link.id}>
      <a
        href={onHome ? `#${link.id}` : `/#${link.id}`}
        aria-current={onHome && active === link.id ? 'location' : undefined}
        onClick={(event) => {
          setOpen(false);
          if (!onHome) {
            event.preventDefault();
            navigate(`/#${link.id}`);
            requestAnimationFrame(() => {
              document.getElementById(link.id)?.scrollIntoView({ behavior: 'smooth' });
            });
          }
        }}
      >
        {tr(link.label)}
      </a>
    </li>
  );

  const mapProps = { to: '/map', onPointerEnter: prefetchMap, onFocus: prefetchMap };
  const routeProps = { to: '/route', onPointerEnter: prefetchRoute, onFocus: prefetchRoute };
  const alertProps = { to: '/alert', onPointerEnter: prefetchAlert, onFocus: prefetchAlert };
  const badge = number(unread > 9 ? '9+' : unread);
  const alertLabel = unread > 0 ? tr('Alerts, {n} unread', { n: unread }) : tr('Alerts');

  return (
    <header ref={headerRef} className={`nav${scrolled ? ' is-scrolled' : ''}`} data-nav-tone={tone}>
      <nav className="nav-inner" aria-label={tr('Main')}>
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="nav-menu"
          aria-label={tr(open ? 'Close menu' : 'Open menu')}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'close' : 'menu'} size={24} />
        </button>

        {open && (
          <ul id="nav-menu" className="nav-menu">
            {[...SECTION_LINKS, ...MENU_ONLY_LINKS].map(sectionLink)}
            <li>
              <Link {...alertProps} aria-current={route === 'alert' ? 'page' : undefined} onClick={() => setOpen(false)}>
                <Icon name="bell" size={18} />{tr('Alerts')}{unread > 0 ? <span className="nav-menu-count">{tr('{n} unread', { n: unread })}</span> : null}
              </Link>
            </li>
            <li><Link {...mapProps} onClick={() => setOpen(false)}><Icon name="map" size={18} />{tr('Map')}</Link></li>
            <li><Link {...routeProps} aria-current={route === 'route' ? 'page' : undefined} onClick={() => setOpen(false)}><Icon name="route" size={18} />{tr('Routes')}</Link></li>
          </ul>
        )}

        {onHome ? (
          <a
            href="/"
            className="nav-logo"
            aria-label={tr('AkashSathi, back to top')}
            onClick={(event) => { event.preventDefault(); setOpen(false); window.scrollTo({ top: 0 }); }}
          >
            <LogoMark size={34} />
            <span className="nav-logo-text">{tr('AkashSathi')}</span>
          </a>
        ) : (
          <Link to="/" className="nav-logo" aria-label={tr('AkashSathi home')} onClick={() => setOpen(false)}>
            <LogoMark size={34} />
            <span className="nav-logo-text">{tr('AkashSathi')}</span>
          </Link>
        )}

        <ul className="nav-links nav-links--left">{SECTION_LINKS.map(sectionLink)}</ul>

        <ul className="nav-links nav-links--right">
          <li className="nav-cta-item">
            <Link {...alertProps} className="nav-cta nav-cta--outline nav-alert" aria-label={alertLabel} aria-current={route === 'alert' ? 'page' : undefined}>
              <Icon name="bell" size={18} />
              <span className="nav-alert-label">{tr('Alerts')}</span>
              {unread > 0 && <span className="nav-badge" aria-hidden="true">{badge}</span>}
            </Link>
          </li>
          <li className="nav-cta-item">
            <Link {...mapProps} className="nav-cta"><Icon name="map" size={18} />{tr('Map')}</Link>
          </li>
          <li className="nav-cta-item nav-cta-route">
            <Link {...routeProps} className="nav-cta" aria-current={route === 'route' ? 'page' : undefined}><Icon name="route" size={18} />{tr('Routes')}</Link>
          </li>
          <li className="nav-language"><LanguageToggle subtle onChange={onLanguageChange} disabled={languageDisabled} /></li>
        </ul>
      </nav>
    </header>
  );
}
