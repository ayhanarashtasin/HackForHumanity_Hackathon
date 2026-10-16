import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityControl } from '../alert/ActivityControl.jsx';
import { BulletinPanel } from '../alert/BulletinPanel.jsx';
import { ChannelsPanel } from '../alert/ChannelsPanel.jsx';
import { clearHint, setPageOpen, setUnread, writeHint } from '../alert/alertStore.js';
import { errorText, useLanguage } from '../i18n/index.js';
import { AlertContext } from '../alert/context.js';
import { CoveragePanel } from '../alert/CoveragePanel.jsx';
import { t } from '../alert/i18n.js';
import { Inbox } from '../alert/Inbox.jsx';
import { LiveLocation } from '../alert/LiveLocation.jsx';
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

// Page = orchestration only: which screen shows (form, saved, inbox, edit), what is loaded, and the language. Everything drawn lives in
// client/src/alert, everything pure in lib/alertForm.js, every request in services/alertApi.js.
export default function AlertPage() {
  const session = useAlertSession();
  const { schema, profile, phase } = session;
  const { lang, setLang: setLangState } = useLanguage();
  const [view, setView] = useState('main'); // main | saved | edit
  const [notice, setNotice] = useState(null);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const changingLanguage = useRef(false);
  const savingProfile = useRef(false);
  const tr = useCallback((key, params) => t(lang, key, params), [lang]);

  // The navbar badge stands down while this page polls the inbox itself.
  useEffect(() => {
    setPageOpen(true);
    return () => setPageOpen(false);
  }, []);

  // Opening this page never overwrites the browser preference with the profile's delivery language.

  const index = useMemo(() => (session.catalogue ? buildAreaIndex(session.catalogue) : null), [session.catalogue]);
  const def = useMemo(() => schema?.occupations.find((item) => item.value === profile?.occupation) ?? null, [schema, profile?.occupation]);

  const ready = phase === 'ready';
  const announce = useCallback((title) => tr('inbox.live', { title }), [tr]);
  const inbox = useInbox({ enabled: ready, announce, lang, onSignedOut: session.signedOut });
  const coverage = usePolled(alertApi.coverage, COVERAGE_POLL_MS, { enabled: ready });
  const status = usePolled(alertApi.status, COVERAGE_POLL_MS, { enabled: ready });
  const unread = useUnreadFromInbox(inbox);
  const refreshLive = useCallback(() => { inbox.reload(); coverage.reload(); status.reload(); }, [inbox.reload, coverage.reload, status.reload]);

  // Switching language also switches the language new alerts are written in (a profile edit); it is reverted if that fails.
  const setLang = useCallback(async (code) => {
    if (changingLanguage.current || savingProfile.current) return;
    const previous = lang;
    setNotice(null);
    setLangState(code);
    if (!profile || !def || profile.language === code) return;
    changingLanguage.current = true;
    setLanguageBusy(true);
    try {
      const payload = buildPayload({ ...answersFromProfile(profile, def), language: code }, def);
      const data = await alertApi.updateProfile(payload);
      session.setProfile(data.profile);
    } catch (error) {
      setLangState(previous);
      setNotice({ error: error.message });
    } finally {
      changingLanguage.current = false;
      setLanguageBusy(false);
    }
  }, [lang, profile, def, session, setLangState]);

  const context = useMemo(() => ({
    lang, tr, setLang, languageBusy, schema, index, catalogue: session.catalogue, catalogueError: session.catalogueError,
  }), [lang, tr, setLang, languageBusy, schema, index, session.catalogue, session.catalogueError]);

  const saveProfile = async (payload, editing = false) => {
    if (savingProfile.current) return;
    savingProfile.current = true;
    setProfileBusy(true);
    try {
      const data = await (editing ? alertApi.updateProfile(payload) : alertApi.subscribe(payload));
      if (!editing) writeHint({ language: data.profile.language });
      session.setProfile(data.profile);
      setUnread(data.unread);
      setView(editing ? 'main' : 'saved');
      if (editing) {
        setNotice({ key: 'profile.saved' });
        inbox.reload();
      }
      // Saving a profile never replaces the browser's interface language with an older response.
    } finally {
      savingProfile.current = false;
      setProfileBusy(false);
    }
  };

  const deleted = () => {
    clearHint();
    setNotice(null);
    setView('main');
    session.signedOut();
  };

  let body;
  if (phase === 'loading') {
    body = <p className="alert-loading" role="status">{tr('page.loading')}</p>;
  } else if (phase === 'error') {
    body = (
      <div className="alert-panel" role="alert">
        <p>{errorText(session.error, lang) || tr('page.unreachable')}</p>
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
          <Wizard key="create" initialAnswers={defaultAnswers(lang)} onSubmit={saveProfile} />
        </div>
      </>
    );
  } else if (view === 'saved') {
    body = <SavedScreen profile={profile} onContinue={() => setView('main')} />;
  } else if (view === 'edit' && def) {
    body = (
      <div className="alert-panel alert-panel--wizard">
        <h1 className="alert-edit-title">{tr('profile.editTitle')}</h1>
        <Wizard key="edit" mode="edit" initialAnswers={answersFromProfile(profile, def)} onSubmit={(payload) => saveProfile(payload, true)} onCancel={() => setView('main')} />
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
        <div className="alert-grid">
          <div className="alert-col-main">
            <Inbox inbox={inbox} unread={unread} />
            <CoveragePanel rows={coverage.data?.rows ?? null} error={coverage.error} />
            <BulletinPanel bulletins={status.data?.bulletins ?? null} error={status.error} />
          </div>
          <aside className="alert-col-side">
            <LiveLocation profile={profile} onProfile={session.setProfile} onUpdated={refreshLive} />
            <ActivityControl profile={profile} onChange={session.setProfile} />
            <ChannelsPanel />
            <ProfilePanel profile={profile} onEdit={() => { setNotice(null); setView('edit'); }} onProfile={session.setProfile} onDeleted={deleted} />
          </aside>
        </div>
      </>
    );
  }

  return (
    <AlertContext.Provider value={context}>
      <div className="landing alert-page" lang={lang} data-lang={lang}>
        <a className="skip-link" href="#alert-main">{tr('page.skip')}</a>
        <Navbar onLanguageChange={setLang} languageDisabled={languageBusy || profileBusy} />
        <main id="alert-main" className="alert-main" data-tone="light">
          <div className="container alert-container">
            <div className="alert-toolbar">
              {languageBusy && <p role="status">{tr('btn.saving')}</p>}
              {lang === 'bn' && schema && !schema.bnReviewed && <p className="alert-bn-note">{tr('bn.review')}</p>}
            </div>
            {notice && <p className={`alert-banner ${notice.error ? 'alert-banner--problem' : 'alert-banner--ok'}`} role={notice.error ? 'alert' : 'status'}>{notice.key ? tr(notice.key) : errorText(notice.error, lang)}</p>}
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
