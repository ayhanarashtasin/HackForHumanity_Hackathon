import { useAlert } from './context.js';
import { LanguageToggle as SharedToggle } from '../components/LanguageToggle.jsx';

// English / বাংলা. The choice is remembered in this browser and (once there is a profile) saved as the language alerts are written in.
export function LanguageToggle({ disabled = false }) {
  const { lang, setLang, languageBusy } = useAlert();
  return <SharedToggle value={lang} onChange={setLang} disabled={disabled || languageBusy} />;
}
