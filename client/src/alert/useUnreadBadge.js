import { useCallback } from 'react';
import { usePolled } from '../hooks/usePolled.js';
import { alertApi } from '../services/alertApi.js';
import {
  clearHint, setUnread, useArmed, usePageOpen, useUnread,
} from './alertStore.js';

const POLL_MS = 30_000;

// The unread count for the navbar badge. Visitors without the "armed" hint never make a request; while the alert page is open it
// polls the inbox itself and the navbar stands down. A 401 means the profile is gone (cleared cookies, deleted): the hint is cleared.
export function useUnreadBadge() {
  const armed = useArmed();
  const pageOpen = usePageOpen();
  const unread = useUnread();

  const load = useCallback(async (signal) => {
    try {
      const data = await alertApi.inbox({ view: 'active' }, signal);
      setUnread(data.unread);
      return data.unread;
    } catch (error) {
      if (error.status === 401) {
        clearHint();
        return 0;
      }
      throw error;
    }
  }, []);

  usePolled(load, POLL_MS, { enabled: armed && !pageOpen });
  return armed ? unread : 0;
}
