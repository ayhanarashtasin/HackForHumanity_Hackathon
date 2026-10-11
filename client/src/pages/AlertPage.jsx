import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityControl } from '../alert/ActivityControl.jsx';
import { BulletinPanel } from '../alert/BulletinPanel.jsx';
import { ChannelsPanel } from '../alert/ChannelsPanel.jsx';
import { clearHint, readLanguage, setPageOpen, setUnread, writeHint, writeLanguage } from '../alert/alertStore.js';
import { AlertContext } from '../alert/context.js';
import { CoveragePanel } from '../alert/CoveragePanel.jsx';
import { t } from '../alert/i18n.js';
import { Inbox } from '../alert/Inbox.jsx';
import { LanguageToggle } from '../alert/LanguageToggle.jsx';
import { ProfilePanel } from '../alert/ProfilePanel.jsx';
import { SavedScreen } from '../alert/SavedScreen.jsx';
import { useAlertSession } from '../alert/useAlertSession.js';
import { useInbox } from '../alert/useInbox.js';
import { Wizard } from '../alert/Wizard.jsx';
import { Navbar } from '../components/Navbar.jsx';
import { usePolled } from '../hooks/usePolled.js';
import {
  answersFromProfile, buildAreaIndex, buildPayload, defaultAnswers,
} from '../lib/alertForm.js';
import { alertApi } from '../services/alertApi.js';
import '../alert/alert.css';
import '../landing.css';

const COVERAGE_POLL_MS = 120_000;

// The browser's language is only a first guess; the visitor's own choice (and later the profile's language) wins.
function initialLanguage() {
  return readLanguage() ?? (typeof navigator !== 'undefined' && /^bn/i.test(navigator.language ?? '') ? 'bn' : 'en');
}

// Page = orchestration only: which screen shows (form, saved, inbox, edit), what is loaded, and the language. Everything drawn lives in
// client/src/alert, everything pure in lib/alertForm.js, every request in services/alertApi.js.
export default function AlertPage() {
  const session = useAlertSession();
  const { schema, profile, phase } = session;
  const [lang, setLangState] = useState(initialLanguage);
  const [view, setView] = useState('main'); // main | saved | edit
  const [notice, setNotice] = useState('');
  const tr = useCallback((key, params) => t(lang, key, params), [lang]);

  // The navbar badge stands down while this page polls the inbox itself.
  useEffect(() => {
    setPageOpen(true);
    return () => setPageOpen(false);
  }, []);

  // Once there is a profile, its language is the one alerts are written in.
  useEffect(() => {
    if (profile?.language) setLangState(profile.language);
  }, [profile?.language]);

  const index = useMemo(() => (session.catalogue ? buildAreaIndex(session.catalogue) : null), [session.catalogue]);
  const def = useMemo(() => schema?.occupations.find((item) => item.value === profile?.occupation) ?? null, [schema, profile?.occupation]);

  const ready = phase === 'ready';
  const announce = useCallback((title) => tr('inbox.live', { title }), [tr]);
  const inbox = useInbox({ enabled: ready, announce, onSignedOut: session.signedOut });
  const coverage = usePolled(alertApi.coverage, COVERAGE_POLL_MS, { enabled: ready });
  const status = usePolled(alertApi.status, COVERAGE_POLL_MS, { enabled: ready });
  const unread = useUnreadFromInbox(inbox);

  // Switching language also switches the language new alerts are written in (a profile edit); it is reverted if that fails.
  const setLang = useCallback(async (code) => {
    const previous = lang;
    setLangState(code);
    writeLanguage(code);
    if (!profile || !def || profile.language === code) return;
    try {
      const payload = buildPayload({ ...answersFromProfile(profile, def), language: code }, def);
      const data = await alertApi.updateProfile(payload);
      session.setProfile(data.profile);
    } catch (error) {
      setLangState(previous);
      writeLanguage(previous);
      setNotice(error.message);
    }
  }, [lang, profile, def, session]);

  const context = useMemo(() => ({
    lang, tr, setLang, schema, index, catalogue: session.catalogue, catalogueError: session.catalogueError,
  }), [lang, tr, setLang, schema, index, session.catalogue, session.catalogueError]);

  const subscribe = async (payload) => {
    const data = await alertApi.subscribe(payload);
    writeHint({ language: data.profile.language });
    setUnread(data.unread);
    setLangState(data.profile.language);
    writeLanguage(data.profile.language);
    session.setProfile(data.profile);
    setView('saved');
  };

  const saveEdit = async (payload) => {
    const data = await alertApi.updateProfile(payload);
    session.setProfile(data.profile);
    setUnread(data.unread);
    setNotice(t(data.profile.language, 'profile.saved'));
    setView('main');
    inbox.reload();
  };

  const deleted = () => {
    clearHint();
    setNotice('');
    setView('main');
    session.signedOut();
  };

  let body;
  if (phase === 'loading') {
    body = <p className="alert-loading" role="status">{tr('page.loading')}</p>;
  } else if (phase === 'error') {
    body = (
      <div className="alert-panel" role="alert">
        <p>{session.error || tr('page.unreachable')}</p>
        <button type="button" className="alert-button alert-button--primary" onClick={session.reload}>{tr('page.retry')}</button>
      </div>
    );
  } else if (phase === 'form') {
    body = (
      <>
        <section className="alert-intro" aria-labelledby="alert-intro-title">
          <p className="eyebrow">{tr('page.eyebrow')}</p>
          <h1 id="alert-intro-title">{tr('page.title')}</h1>
          <p className="alert-lead">{tr('page.lead')}</p>
          <ul className="alert-points">
            {['page.point1', 'page.point2', 'page.point3'].map((key) => <li key={key}>{tr(key)}</li>)}
          </ul>
        </section>
        <div className="alert-panel alert-panel--wizard">
          <Wizard key="create" initialAnswers={defaultAnswers(lang)} onSubmit={subscribe} />
        </div>
      </>
    );
  } else if (view === 'saved') {
    body = <SavedScreen profile={profile} onContinue={() => setView('main')} />;
  } else if (view === 'edit' && def) {
    body = (
      <div className="alert-panel alert-panel--wizard">
        <h1 className="alert-edit-title">{tr('profile.editTitle')}</h1>
        <Wizard key="edit" mode="edit" initialAnswers={answersFromProfile(profile, def)} onSubmit={saveEdit} onCancel={() => setView('main')} />
      </div>
    );
  } else {
    body = (
      <>
        <header className="alert-head">
          <div>
            <p className="eyebrow">{tr('page.eyebrow')}</p>
            <h1>{tr('inbox.title')}</h1>
          </div>
        </header>
        {profile.status === 'paused' && <p className="alert-banner" role="status">{tr('profile.paused')}</p>}
        {notice && <p className="alert-banner alert-banner--ok" role="status">{notice}</p>}
        <div className="alert-grid">
          <div className="alert-col-main">
            <Inbox inbox={inbox} unread={unread} />
             <CoveragePanel rows={coverage.data?.rows ?? null} error={coverage.error} />
             <BulletinPanel bulletins={status.data?.bulletins ?? null} error={status.error} />
          </div>
          <aside className="alert-col-side">
            <ActivityControl profile={profile} onChange={session.setProfile} />
            <ChannelsPanel />
            <ProfilePanel profile={profile} onEdit={() => { setNotice(''); setView('edit'); }} onProfile={session.setProfile} onDeleted={deleted} />
          </aside>
        </div>
      </>
    );
  }

  return (
    <AlertContext.Provider value={context}>
      <div className="landing alert-page" lang={lang} data-lang={lang}>
        <a className="skip-link" href="#alert-main">{tr('page.skip')}</a>
        <Navbar />
        <main id="alert-main" className="alert-main" data-tone="light">
          <div className="container alert-container">
            <div className="alert-toolbar">
              {schema && <LanguageToggle />}
              {lang === 'bn' && schema && !schema.bnReviewed && <p className="alert-bn-note">{tr('bn.review')}</p>}
            </div>
            {body}
          </div>
        </main>
        {/* Not while loading: the page is one line tall then, so the footer sat in view and jumped away when the form arrived. */}
        {phase !== 'loading' && (
          <footer className="alert-footer" data-tone="light">
            <div className="container alert-container"><p>{tr('footer.note')}</p></div>
          </footer>
        )}
        <div className="sr-only" role="status" aria-live="polite">{inbox.announcement}</div>
      </div>
    </AlertContext.Provider>
  );
}

// The unread number the page shows: the count of unread items it holds, which the server's own count agrees with after each poll.
function useUnreadFromInbox(inbox) {
  const active = inbox.active ?? [];
  return active.filter((item) => !item.readAt).length;
}
