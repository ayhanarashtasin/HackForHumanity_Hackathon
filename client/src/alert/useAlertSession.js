import { useCallback, useEffect, useState } from 'react';
import { alertApi } from '../services/alertApi.js';
import { loadCatalogue } from '../services/weatherApi.js';
import {
  clearHint, readHint, setUnread, writeHint,
} from './alertStore.js';

// Loads what the alert page needs: the form schema, the area catalogue, and this browser's profile (a 401 means there is none yet).
// The catalogue failing does not stop the page: the form says the areas could not be loaded.
export function useAlertSession() {
  const [state, setState] = useState({
    phase: 'loading', schema: null, catalogue: null, catalogueError: false, profile: null, error: null,
  });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, phase: 'loading', error: null }));

    Promise.all([
      alertApi.schema(controller.signal),
      loadCatalogue(controller.signal).then((catalogue) => ({ catalogue })).catch((error) => ({ error })),
      alertApi.me(controller.signal).then((me) => ({ me })).catch((error) => (error.status === 401 ? { me: null } : Promise.reject(error))),
    ]).then(([schema, catalogue, mine]) => {
      if (mine.me) {
        setUnread(mine.me.unread);
        if (!readHint()) writeHint({ language: mine.me.profile.language });
      } else if (readHint()) {
        clearHint(); // the badge must not keep polling for a profile that is gone
      }
      setState({
        phase: mine.me ? 'ready' : 'form',
        schema,
        catalogue: catalogue.catalogue ?? null,
        catalogueError: Boolean(catalogue.error),
        profile: mine.me?.profile ?? null,
        error: null,
      });
    }).catch((error) => {
      if (!controller.signal.aborted) setState((current) => ({ ...current, phase: 'error', error: error.message }));
    });

    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  const setProfile = useCallback((profile) => setState((current) => ({ ...current, profile, phase: 'ready' })), []);
  const signedOut = useCallback(() => setState((current) => ({ ...current, profile: null, phase: 'form' })), []);

  return { ...state, reload: load, setProfile, signedOut };
}
