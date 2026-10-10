import { useCallback, useEffect, useState } from 'react';
import { useAdmin } from '../AdminContext.jsx';

// Loads one admin resource (with the 401 guard) and lets the view reload it. For polling, the views use usePolled with the same guard.
export function useAdminResource(load, deps = []) {
  const { guard } = useAdmin();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    guard(load(controller.signal))
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState((current) => ({ data: current.data, error: error.message, loading: false }));
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, guard, ...deps]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload, setData: (data) => setState((current) => ({ ...current, data })) };
}
