import { useEffect, useState } from 'react';
import { AdminDashboard } from '../admin/AdminDashboard.jsx';
import { AdminClosed, AdminLogin } from '../admin/AdminLogin.jsx';
import '../admin/admin.css';
import { adminScreen, navigate, usePathname } from '../lib/router.js';
import { adminApi } from '../services/adminApi.js';

// /admin/login is the sign-in screen; /admin is the dashboard, which first asks the server who is calling:
//   401 -> back to /admin/login        503 -> "not configured" page        otherwise -> the dashboard
function Gate() {
  const [state, setState] = useState({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'checking' });
    adminApi.me(controller.signal)
      .then((data) => setState({ status: 'ok', devBypass: Boolean(data?.devBypass) }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error.status === 401) navigate('/admin/login', { replace: true });
        else if (error.status === 503) setState({ status: 'closed' });
        else setState({ status: 'error', message: error.message });
      });
    return () => controller.abort();
  }, [attempt]);

  if (state.status === 'ok') return <AdminDashboard devBypass={state.devBypass} />;
  if (state.status === 'closed') return <AdminClosed />;
  if (state.status === 'error') {
    return (
      <main className="adm-login" id="adm-main">
        <section className="adm-login-card">
          <p role="alert">{state.message}</p>
          <button type="button" className="adm-btn adm-btn-primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
        </section>
      </main>
    );
  }
  return <main className="adm-login" id="adm-main"><p className="adm-loading" role="status">Loading…</p></main>;
}

export default function AdminPage() {
  const screen = adminScreen(usePathname());
  return <div className="admin-root">{screen === 'login' ? <AdminLogin /> : <Gate />}</div>;
}
