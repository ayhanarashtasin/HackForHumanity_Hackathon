import { useId } from 'react';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';

// Live subscribers, or only the demo subscribers the administrator created (they never receive anything live).
export function AudiencePicker({ value, onChange }) {
  const { tr } = useLanguage(ADMIN);
  const name = useId();
  return (
    <fieldset className="adm-fieldset">
      <legend>{tr('Audience')}</legend>
      <div className="adm-radios">
        <label className="adm-check">
          <input type="radio" name={name} checked={value === 'live'} onChange={() => onChange('live')} />
          <span>{tr('Live subscribers')}</span>
        </label>
        <label className="adm-check">
          <input type="radio" name={name} checked={value === 'demo'} onChange={() => onChange('demo')} />
          <span>{tr('Demo subscribers only')}</span>
        </label>
      </div>
    </fieldset>
  );
}
