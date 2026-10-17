import { useCallback, useEffect, useState } from 'react';
import { alertApi } from '../services/alertApi.js';
import { loadCatalogue } from '../services/weatherApi.js';
import { useUserLocation } from '../hooks/useUserLocation.js';
import { syncLocationArea } from './locationSync.js';
import {
  clearHint, readHint, setUnread, writeHint,
} from './alertStore.js';

// Loads what the alert page needs: the form schema, the area catalogue, and this browser's profile (`profile: null` means there is none yet).
// The catalogue failing does not stop the page: the form says the areas could not be loaded.
export function useAlertSession() {
  const location = useUserLocation();
  const [state, setState] = useState({
    phase: 'loading', schema: null, catalogue: null, catalogueError: false, profile: null, error: null,
  });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, phase: 'loading', error: null }));

    Promise.all([
      alertApi.schema(controller.signal),
      loadCatalogue(controller.signal).then((catalogue) => ({ catalogue })).catch((error) => ({ error })),
      alertApi.session(controller.signal).then((session) => ({ me: session.profile ? session : null })),
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

  const setCurrentArea = useCallback((profile) => setState((current) => !current.profile || current.profile.createdAt !== profile.createdAt
    ? current : { ...current, profile: { ...current.profile, currentArea: profile.currentArea } }), []);

  // Also runs after registration. Only patch the temporary area: a late response must not undo profile edits.
  const profileCreatedAt = state.profile?.createdAt;
  const locationSaved = location.alertStatus === 'saved';
  useEffect(() => {
    if (!profileCreatedAt || location.status !== 'ready' || !location.alertsEnabled || location.source !== 'capture') return undefined;
    let active = true;
    syncLocationArea(state.profile).then((data) => {
      if (active && data) setCurrentArea(data.profile);
    }).catch(() => {}); // shared location status offers retry; saved-area alerts remain usable
    return () => { active = false; };
  }, [profileCreatedAt, location.status, location.revision, location.alertsEnabled, location.source, locationSaved, setCurrentArea]);

  const setProfile = useCallback((profile) => setState((current) => ({ ...current, profile, phase: 'ready' })), []);
  const signedOut = useCallback(() => setState((current) => ({ ...current, profile: null, phase: 'form' })), []);

  return { ...state, reload: load, setProfile, setCurrentArea, signedOut };
}
