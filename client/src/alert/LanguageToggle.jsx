import { useAlert } from './context.js';

// English / বাংলা. The choice is remembered in this browser and (once there is a profile) saved as the language alerts are written in.
export function LanguageToggle({ disabled = false }) {
  const { lang, tr, setLang } = useAlert();
  return (
    <div className="alert-lang" role="group" aria-label={tr('lang.label')}>
      {['en', 'bn'].map((code) => (
        <button key={code} type="button" lang={code} aria-pressed={lang === code} disabled={disabled} onClick={() => setLang(code)}>
          {code === 'bn' ? 'বাংলা' : 'English'}
        </button>
      ))}
    </div>
  );
}
