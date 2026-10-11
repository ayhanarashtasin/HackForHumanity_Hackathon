import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '../i18n/index.js';
import { ADMIN } from '../i18n/admin.js';
import { LanguageToggle } from '../components/LanguageToggle.jsx';
import { Icon } from '../components/Icon.jsx';
import { LogoMark } from '../components/Logo.jsx';
import { describeError } from '../lib/adminForm.js';
import { navigate } from '../lib/router.js';
import { adminApi } from '../services/adminApi.js';
import { loadCatalogue } from '../services/weatherApi.js';
import { AdminProvider, useAdmin } from './AdminContext.jsx';
import { ErrorNote, Loading, Notice } from './components/Parts.jsx';
import { History } from './views/History.jsx';
import { Overview } from './views/Overview.jsx';
import { Rules } from './views/Rules.jsx';
import { SendAlerts } from './views/SendAlerts.jsx';
import { Settings } from './views/Settings.jsx';

const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'chart', View: Overview },
  { id: 'send', label: 'Send alerts', icon: 'send', View: SendAlerts },
  { id: 'history', label: 'History', icon: 'history', View: History },
  { id: 'rules', label: 'Rules', icon: 'list', View: Rules },
  { id: 'settings', label: 'Settings', icon: 'settings', View: Settings },
];

const fromHash = () => {
  const id = window.location.hash.replace(/^#/, '');
  return SECTIONS.some((section) => section.id === id) ? id : 'overview';
};

function Shell() {
  const { tr } = useLanguage(ADMIN);
  const { devBypass, signOut } = useAdmin();
  const [section, setSection] = useState(fromHash);

  // Sections are in-page views kept in the hash (never new routes); replaceState keeps the back button for page navigation only.
  const go = useCallback((id) => {
    setSection(id);
    window.history.replaceState(null, '', `#${id}`);
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onHash = () => setSection(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const View = SECTIONS.find((item) => item.id === section).View;

  return (
    <div className="admin">
      <a className="adm-skip" href="#adm-main">{tr('Skip to content')}</a>
      <header className="adm-top">
        <span className="adm-brand"><LogoMark size={30} /><strong>{tr('AkashSathi')}</strong></span>
        <span className="adm-role-badge"><Icon name="shield" size={16} /> {tr('Administrator')}</span>
        <LanguageToggle />
        <button type="button" className="adm-btn adm-btn-small adm-top-out" onClick={signOut}><Icon name="logout" size={16} /> {tr('Sign out')}</button>
      </header>
      {devBypass && (
        <div className="adm-banner" role="status">
          <Icon name="warning" size={16} /> {tr('Sign-in is switched off for local use (ADMIN_AUTH=off).')}
        </div>
      )}
      <div className="adm-body">
        <nav className="adm-nav" aria-label={tr('Administrator sections')}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'is-active' : ''}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              <Icon name={item.icon} size={18} /> {tr(item.label)}
            </button>
          ))}
        </nav>
        <main className="adm-main" id="adm-main" tabIndex={-1}>
          <View onOpenHistory={() => go('history')} />
        </main>
      </div>
    </div>
  );
}

// Loads what every view needs (form options and the place catalogue) once, then shows the dashboard.
export function AdminDashboard({ devBypass }) {
  const { tr } = useLanguage(ADMIN);
  const [state, setState] = useState({ loading: true, options: null, catalogue: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    Promise.all([adminApi.options(controller.signal), loadCatalogue(controller.signal)])
      .then(([options, catalogue]) => setState({ loading: false, options, catalogue, error: null }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error.status === 401) {
          navigate('/admin/login', { replace: true });
          return;
        }
        setState({ loading: false, options: null, catalogue: null, error: describeError(error) });
      });
    return () => controller.abort();
  }, [attempt]);

  if (state.loading) return <main className="adm-login" id="adm-main"><Loading /></main>;
  if (state.error) {
    return (
      <main className="adm-login" id="adm-main">
        <div className="adm-login-card">
          <LanguageToggle />
          <ErrorNote onRetry={() => setAttempt((value) => value + 1)}>{state.error}</ErrorNote>
          <Notice>{tr('Check that the API is running, then try again.')}</Notice>
        </div>
      </main>
    );
  }

  return (
    <AdminProvider options={state.options} catalogue={state.catalogue} devBypass={devBypass}>
      <Shell />
    </AdminProvider>
  );
}
