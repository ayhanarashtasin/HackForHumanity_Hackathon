import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePolled } from '../hooks/usePolled.js';
import { alertApi } from '../services/alertApi.js';
import { clearHint, setUnread } from './alertStore.js';
import { criticalKey, optimisticRead, withOptimisticRead } from './inboxState.js';

const POLL_MS = 30_000;

// The inbox: current alerts polled every 30 s (a read of our own database, never a provider request), earlier ones paged on demand.
// Marking read is optimistic and shared by both lists. `announce` turns the title of a newly arrived CRITICAL alert into the text for a
// polite live region. `onSignedOut` is called when the server says this browser has no profile any more (401).
export function useInbox({ enabled, announce, onSignedOut }) {
  const [readAt, setReadAt] = useState({}); // id -> optimistic read of one notification stage
  const [earlier, setEarlier] = useState({ items: [], hasMore: false, loaded: false, loadingMore: false, error: null });
  const [announcement, setAnnouncement] = useState('');
  const knownCritical = useRef(null);

  const load = useCallback(async (signal) => {
    try {
      const data = await alertApi.inbox({ view: 'active' }, signal);
      setUnread(data.unread);
      return data;
    } catch (error) {
      if (error.status === 401) {
        clearHint();
        onSignedOut?.();
      }
      throw error;
    }
  }, [onSignedOut]);

  const polled = usePolled(load, POLL_MS, { enabled });
  const active = polled.data?.items;

  // Announce CRITICAL alerts that were not on screen before (never on the very first load: those are not "new").
  useEffect(() => {
    if (!active) return;
    const critical = active.filter((item) => item.severity === 'CRITICAL');
    if (knownCritical.current === null) {
      knownCritical.current = new Set(critical.map(criticalKey));
      return;
    }
    const fresh = critical.filter((item) => !item.readAt && !knownCritical.current.has(criticalKey(item)));
    fresh.forEach((item) => knownCritical.current.add(criticalKey(item)));
    if (fresh.length) setAnnouncement(announce(fresh[0].title));
  }, [active, announce]);

  const loadEarlier = useCallback(async () => {
    try {
      const data = await alertApi.inbox({ view: 'earlier' });
      setEarlier({ items: data.items, hasMore: data.hasMore, loaded: true, loadingMore: false, error: null });
    } catch (error) {
      setEarlier((current) => ({ ...current, loaded: true, error: error.message }));
    }
  }, []);

  // The earlier list is reloaded when the set of current alerts changes (one just ended, or was withdrawn).
  const signature = useMemo(() => (active ?? []).map((item) => item.id).join(','), [active]);
  useEffect(() => {
    if (enabled && polled.data) loadEarlier();
  }, [enabled, signature, Boolean(polled.data), loadEarlier]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async () => {
    const last = earlier.items.at(-1);
    if (!last) return;
    setEarlier((current) => ({ ...current, loadingMore: true }));
    try {
      const data = await alertApi.inbox({ view: 'earlier', before: last.createdAt });
      setEarlier((current) => ({ ...current, items: [...current.items, ...data.items], hasMore: data.hasMore, loadingMore: false, error: null }));
    } catch (error) {
      setEarlier((current) => ({ ...current, loadingMore: false, error: error.message }));
    }
  }, [earlier.items]);

  const withRead = useCallback((item) => withOptimisticRead(item, readAt), [readAt]);

  const markRead = useCallback(async (id) => {
    const item = [...(active ?? []), ...earlier.items].find((entry) => entry.id === id);
    if (!item) return;
    setReadAt((current) => ({ ...current, [id]: optimisticRead(item, new Date().toISOString()) }));
    try {
      const result = await alertApi.markRead(id);
      setUnread(result.unread);
    } catch {
      setReadAt((current) => { const next = { ...current }; delete next[id]; return next; });
    }
  }, [active, earlier.items]);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    const items = [...(active ?? []), ...earlier.items];
    setReadAt((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.id, optimisticRead(item, now)])) }));
    try {
      await alertApi.markAllRead();
      setUnread(0);
    } catch {
      setReadAt((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !items.some((item) => item.id === id))));
    }
  }, [active, earlier.items]);

  return {
    active: active ? active.map(withRead) : null,
    earlier: { ...earlier, items: earlier.items.map(withRead) },
    loading: polled.loading,
    error: polled.error,
    announcement,
    markRead,
    markAllRead,
    loadMore,
    reload: polled.reload,
  };
}
