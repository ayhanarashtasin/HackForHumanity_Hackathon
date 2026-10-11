import { useEffect, useRef, useState } from 'react';
import { useUnreadBadge } from '../alert/useUnreadBadge.js';
import { useRoute } from '../lib/router.js';
import { prefetchPage } from '../pages/pageLoader.js';
import { Icon } from './Icon.jsx';
import { Link } from './Link.jsx';
import { LogoMark } from './Logo.jsx';

const prefetchMap = prefetchPage('map');
const prefetchAlert = prefetchPage('alert');

// Two links on the left of the centred logo; on the right the two actions: Alert (outlined) and Map (solid, the primary action).
// "Data" lives in the footer and in the phone menu.
const LEFT_LINKS = [{ id: 'features', label: 'Features' }, { id: 'who', label: "Who it's for" }];
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

export function Navbar() {
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

  // On the landing page the links scroll to their section; from any other page they go back to it.
  const sectionLink = (link) => (
    <li key={link.id}>
      <a href={onHome ? `#${link.id}` : `/#${link.id}`} aria-current={onHome && active === link.id ? 'location' : undefined} onClick={() => setOpen(false)}>{link.label}</a>
    </li>
  );

  const mapProps = { to: '/map', onPointerEnter: prefetchMap, onFocus: prefetchMap };
  const alertProps = { to: '/alert', onPointerEnter: prefetchAlert, onFocus: prefetchAlert };
  const badge = unread > 9 ? '9+' : String(unread);
  const alertLabel = unread > 0 ? `Alerts, ${unread} unread` : 'Alerts';

  return (
    <header ref={headerRef} className={`nav${scrolled ? ' is-scrolled' : ''}`} data-nav-tone={tone}>
      <nav className="nav-inner" aria-label="Main">
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="nav-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? 'close' : 'menu'} size={24} />
        </button>

        {open && (
          <ul id="nav-menu" className="nav-menu">
            {[...LEFT_LINKS, ...MENU_ONLY_LINKS].map(sectionLink)}
            <li>
              <Link {...alertProps} aria-current={route === 'alert' ? 'page' : undefined} onClick={() => setOpen(false)}>
                <Icon name="bell" size={18} />Alerts{unread > 0 ? <span className="nav-menu-count">{unread} unread</span> : null}
              </Link>
            </li>
            <li><Link {...mapProps} onClick={() => setOpen(false)}><Icon name="map" size={18} />Map</Link></li>
          </ul>
        )}

        <ul className="nav-links nav-links--left">{LEFT_LINKS.map(sectionLink)}</ul>

        {onHome ? (
          <a
            href="/"
            className="nav-logo"
            aria-label="AkashSathi, back to top"
            onClick={(event) => { event.preventDefault(); setOpen(false); window.scrollTo({ top: 0 }); }}
          >
            <LogoMark size={34} />
            <span className="nav-logo-text">AkashSathi</span>
          </a>
        ) : (
          <Link to="/" className="nav-logo" aria-label="AkashSathi home" onClick={() => setOpen(false)}>
            <LogoMark size={34} />
            <span className="nav-logo-text">AkashSathi</span>
          </Link>
        )}

        <ul className="nav-links nav-links--right">
          <li className="nav-cta-item">
            <Link {...alertProps} className="nav-cta nav-cta--outline nav-alert" aria-label={alertLabel} aria-current={route === 'alert' ? 'page' : undefined}>
              <Icon name="bell" size={18} />
              <span className="nav-alert-label">Alert</span>
              {unread > 0 && <span className="nav-badge" aria-hidden="true">{badge}</span>}
            </Link>
          </li>
          <li className="nav-cta-item">
            <Link {...mapProps} className="nav-cta"><Icon name="map" size={18} />Map</Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}
