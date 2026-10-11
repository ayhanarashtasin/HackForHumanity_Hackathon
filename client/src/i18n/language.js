// One browser preference for every screen. Keep the existing key so returning visitors retain their choice.
export const LANGUAGE_KEY = 'akashsathi.alert.language';
const listeners = new Set();
let current;

export function readLanguage() {
  try {
    const value = window.localStorage.getItem(LANGUAGE_KEY);
    return value === 'en' || value === 'bn' ? value : null;
  } catch { return null; }
}

export function getLanguage() {
  return current ??= readLanguage() ?? (typeof navigator !== 'undefined' && /^bn/i.test(navigator.language ?? '') ? 'bn' : 'en');
}

export function writeLanguage(code) {
  if (code !== 'en' && code !== 'bn') return;
  current = code;
  try { window.localStorage.setItem(LANGUAGE_KEY, code); } catch { /* Still works when storage is blocked. */ }
  listeners.forEach((listener) => listener());
}

export function subscribeLanguage(listener) {
  listeners.add(listener);
  const onStorage = (event) => {
    if (event.key !== LANGUAGE_KEY && event.key !== null) return;
    current = undefined;
    listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}
