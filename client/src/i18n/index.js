import { useCallback, useSyncExternalStore } from 'react';
import { digits } from '../alert/format.js';
import { COMMON } from './common.js';
import { getLanguage, subscribeLanguage, writeLanguage } from './language.js';

// Translate complete messages, not individual words. Named parameters keep Bangla sentence order independent of English.
export function translate(lang, text, params = {}, messages = {}) {
  if (typeof text !== 'string') return text;
  const template = lang === 'bn' ? (Object.hasOwn(messages, text) ? messages[text] : Object.hasOwn(COMMON, text) ? COMMON[text] : text) : text;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    if (value === undefined || value === null) return match;
    return typeof value === 'number' ? digits(value, lang) : String(value);
  });
}

export function useLanguage(messages) {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage, () => 'en');
  const tr = useCallback((text, params) => translate(lang, text, params, messages), [lang, messages]);
  return { lang, tr, setLang: writeLanguage, number: (value) => digits(value, lang), name: (item) => lang === 'bn' ? item?.nameBn || tr(item?.name) : item?.name };
}

// Unrecognized provider/server diagnostics stay in logs; the public interface gets a usable localized failure message.
export function errorText(text, lang = getLanguage(), messages = COMMON) {
  if (!text) return text;
  const translated = translate(lang, text, {}, messages);
  return lang === 'bn' && translated === text && !/[\u0980-\u09ff]/u.test(text)
    ? COMMON['Something went wrong. Please try again.'] : translated;
}
