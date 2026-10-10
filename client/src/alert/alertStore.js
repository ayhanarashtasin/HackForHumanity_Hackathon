import { useSyncExternalStore } from 'react';

// A tiny shared store so the navbar badge and the alert page always agree, without either owning the other.
//   - the "armed" hint: a non-sensitive localStorage flag. The subscriber cookie is HttpOnly, so scripts cannot see it; this flag only
//     decides whether the navbar may poll. Visitors who never completed the form never make a request.
//   - the unread count, and whether the alert page is open (it polls the inbox itself, so the navbar stands down).
export const HINT_KEY = 'akashsathi.alert';
export const LANGUAGE_KEY = 'akashsathi.alert.language';

const listeners = new Set();
let unread = 0;
let pageOpen = false;
let hintVersion = 0;

const emit = () => listeners.forEach((listener) => listener());

export function readHint() {
  try {
    const value = JSON.parse(window.localStorage.getItem(HINT_KEY));
    return value && value.armed === true ? value : null;
  } catch {
    return null;
  }
}

export function writeHint(hint) {
  try {
    window.localStorage.setItem(HINT_KEY, JSON.stringify({ armed: true, ...hint }));
  } catch {
    // Private windows can refuse storage; the page still works, the navbar just will not poll.
  }
  hintVersion += 1;
  emit();
}

export function clearHint() {
  try {
    window.localStorage.removeItem(HINT_KEY);
  } catch {
    // nothing to do
  }
  unread = 0;
  hintVersion += 1;
  emit();
}

export function readLanguage() {
  try {
    const value = window.localStorage.getItem(LANGUAGE_KEY);
    return value === 'en' || value === 'bn' ? value : null;
  } catch {
    return null;
  }
}

export function writeLanguage(language) {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // ignore
  }
}

export function setUnread(count) {
  const next = Math.max(0, Number(count) || 0);
  if (next === unread) return;
  unread = next;
  emit();
}

export function setPageOpen(open) {
  if (pageOpen === open) return;
  pageOpen = open;
  emit();
}

function subscribe(listener) {
  listeners.add(listener);
  const onStorage = (event) => {
    if (event.key === HINT_KEY) {
      hintVersion += 1;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export const useUnread = () => useSyncExternalStore(subscribe, () => unread, () => 0);
export const usePageOpen = () => useSyncExternalStore(subscribe, () => pageOpen, () => false);
// Re-reads localStorage whenever the hint changed in this tab or another one.
export function useArmed() {
  useSyncExternalStore(subscribe, () => hintVersion, () => 0);
  return readHint() !== null;
}
