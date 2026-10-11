import { useLanguage } from '../i18n/index.js';

// Native names, not flags; usable with a keyboard and visible even when the mobile menu is closed.
export function LanguageToggle({ disabled = false, onChange, value }) {
  const { lang, tr, setLang } = useLanguage();
  return (
    <div className="language-toggle" role="group" aria-label={tr('Language')}>
      {['bn', 'en'].map((code) => (
        <button key={code} type="button" lang={code} aria-pressed={(value ?? lang) === code} disabled={disabled} onClick={() => (onChange ?? setLang)(code)}>
          {code === 'bn' ? 'বাংলা' : 'English'}
        </button>
      ))}
    </div>
  );
}
