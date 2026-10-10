import { useCallback, useEffect, useRef, useState } from 'react';

// Loads `load(signal)` now and then every `intervalMs`. Keeps the last good value while a refresh fails.
export function usePolled(load, intervalMs, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));

    loadRef.current(controller.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ data: current.data, error: error.message, loading: false }));
      });

    return () => controller.abort();
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}
