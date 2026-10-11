import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n/index.js';
import { ADMIN } from '../i18n/admin.js';
import { LanguageToggle } from '../components/LanguageToggle.jsx';
import { Icon } from '../components/Icon.jsx';
import { LogoMark } from '../components/Logo.jsx';
import { describeError } from '../lib/adminForm.js';
import { navigate } from '../lib/router.js';
import { adminApi } from '../services/adminApi.js';
import { ErrorNote } from './components/Parts.jsx';

export const NOT_CONFIGURED = 'Admin is not configured. Set ADMIN_PASSCODE in server/.env to enable it.';

export function AdminClosed({ message = NOT_CONFIGURED }) {
  const { tr } = useLanguage(ADMIN);
  return (
    <main className="adm-login" id="adm-main">
      <section className="adm-login-card" aria-labelledby="closed-title">
        <LogoMark size={40} />
        <LanguageToggle />
        <h1 id="closed-title">{tr('Administrator')}</h1>
        <p role="status">{tr(message)}</p>
      </section>
    </main>
  );
}

// The one shared passcode. A wrong passcode says so; too many attempts show the server's own wait message.
export function AdminLogin() {
  const { tr } = useLanguage(ADMIN);
  const [state, setState] = useState({ checking: true, closed: false });
  const [passcode, setPasscode] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  // Already signed in (or sign-in switched off for local use): go straight to the dashboard.
  useEffect(() => {
    const controller = new AbortController();
    adminApi.session(controller.signal)
      .then((data) => {
        if (data.state === 'signed-in') navigate('/admin', { replace: true });
        else setState({ checking: false, closed: data.state === 'closed' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ checking: false, closed: false });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!state.checking && !state.closed) input.current?.focus();
  }, [state]);

  const submit = async (event) => {
    event.preventDefault();
    if (!passcode || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.login(passcode);
      navigate('/admin', { replace: true });
    } catch (failure) {
      setBusy(false);
      if (failure.status === 429) setError('Try again in a few minutes.');
      else if (failure.status === 503) setState({ checking: false, closed: true });
      else setError(failure.status === 401 ? 'That passcode is not correct.' : describeError(failure));
      setPasscode('');
      input.current?.focus();
    }
  };

  if (state.checking) return <main className="adm-login" id="adm-main"><p className="adm-loading" role="status">{tr('Loading…')}</p></main>;
  if (state.closed) return <AdminClosed />;

  return (
    <main className="adm-login" id="adm-main">
      <form className="adm-login-card" onSubmit={submit} aria-labelledby="login-title">
        <LogoMark size={40} />
        <LanguageToggle />
        <h1 id="login-title">{tr('Administrator sign-in')}</h1>
        <p className="adm-muted">{tr('This page is not for the public. Enter the administrator passcode.')}</p>
        {/* There is one shared passcode and no account name. Browsers and password managers still expect a username next to a password
            field, so a hidden, fixed one keeps them (and the console) quiet. */}
        <input type="text" name="username" value="administrator" autoComplete="username" readOnly hidden aria-hidden="true" tabIndex={-1} />

        <div className="adm-field">
          <div className="adm-field-label"><label htmlFor="admin-passcode">{tr('Passcode')}</label></div>
          <div className="adm-password">
            <input
              id="admin-passcode"
              ref={input}
              type={show ? 'text' : 'password'}
              autoComplete="current-password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              spellCheck="false"
            />
            <button type="button" className="adm-btn adm-btn-small" aria-pressed={show} onClick={() => setShow((value) => !value)}>
              <Icon name="eye" size={16} /> {tr(show ? 'Hide' : 'Show')}
            </button>
          </div>
        </div>

        <div id="login-error"><ErrorNote>{error}</ErrorNote></div>
        <button type="submit" className="adm-btn adm-btn-primary adm-btn-block" disabled={!passcode || busy}>{tr(busy ? 'Signing in…' : 'Sign in')}</button>
      </form>
    </main>
  );
}
