import { createContext, useCallback, useContext, useMemo } from 'react';
import { buildAreaIndex } from '../lib/adminForm.js';
import { navigate } from '../lib/router.js';
import { adminApi } from '../services/adminApi.js';

// Shared by every admin view: the form options, the area catalogue, and a guard that sends a 401 (an ended session) back to the sign-in screen.
const AdminContext = createContext(null);

export function AdminProvider({ options, catalogue, devBypass, children }) {
  const areaIndex = useMemo(() => buildAreaIndex(catalogue), [catalogue]);

  const signOut = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      navigate('/admin/login', { replace: true });
    }
  }, []);

  // Wrap an admin request: a 401 means the session ended, so go to the sign-in screen (and still reject so callers stop).
  const guard = useCallback(async (promise) => {
    try {
      return await promise;
    } catch (error) {
      if (error?.status === 401) navigate('/admin/login', { replace: true });
      throw error;
    }
  }, []);

  const value = useMemo(() => ({ options, catalogue, areaIndex, devBypass, guard, signOut }), [options, catalogue, areaIndex, devBypass, guard, signOut]);
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin must be used inside AdminProvider.');
  return value;
}
