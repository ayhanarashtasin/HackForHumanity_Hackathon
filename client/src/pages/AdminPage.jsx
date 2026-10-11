import { useEffect, useState } from 'react';
import { AdminDashboard } from '../admin/AdminDashboard.jsx';
import { AdminClosed, AdminLogin } from '../admin/AdminLogin.jsx';
import '../admin/admin.css';
import { adminScreen, navigate, usePathname } from '../lib/router.js';
import { adminApi } from '../services/adminApi.js';
import { errorText, useLanguage } from '../i18n/index.js';
import { LanguageToggle } from '../components/LanguageToggle.jsx';

// /admin/login is the sign-in screen; /admin is the dashboard, which first asks the server who is calling:
//   401 -> back to /admin/login        503 -> "not configured" page        otherwise -> the dashboard
function Gate() {
  const { tr, lang } = useLanguage();
  const [state, setState] = useState({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'checking' });
    adminApi.session(controller.signal)
      .then((data) => {
        if (data.state === 'closed') setState({ status: 'closed' });
        else if (data.state === 'signed-out') navigate('/admin/login', { replace: true });
        else setState({ status: 'ok', devBypass: Boolean(data.devBypass) });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: error.message });
      });
    return () => controller.abort();
  }, [attempt]);

  if (state.status === 'ok') return <AdminDashboard devBypass={state.devBypass} />;
  if (state.status === 'closed') return <AdminClosed />;
  if (state.status === 'error') {
    return (
      <main className="adm-login" id="adm-main">
        <section className="adm-login-card">
          <LanguageToggle />
          <p role="alert">{errorText(state.message, lang)}</p>
          <button type="button" className="adm-btn adm-btn-primary" onClick={() => setAttempt((value) => value + 1)}>{tr('Try again')}</button>
        </section>
      </main>
    );
  }
  return <main className="adm-login" id="adm-main"><p className="adm-loading" role="status">{tr('Loading…')}</p></main>;
}

export default function AdminPage() {
  const screen = adminScreen(usePathname());
  return <div className="admin-root">{screen === 'login' ? <AdminLogin /> : <Gate />}</div>;
}
