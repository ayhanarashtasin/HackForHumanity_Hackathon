import { useId } from 'react';

// Live subscribers, or only the demo subscribers the administrator created (they never receive anything live).
export function AudiencePicker({ value, onChange }) {
  const name = useId();
  return (
    <fieldset className="adm-fieldset">
      <legend>Audience</legend>
      <div className="adm-radios">
        <label className="adm-check">
          <input type="radio" name={name} checked={value === 'live'} onChange={() => onChange('live')} />
          <span>Live subscribers</span>
        </label>
        <label className="adm-check">
          <input type="radio" name={name} checked={value === 'demo'} onChange={() => onChange('demo')} />
          <span>Demo subscribers only</span>
        </label>
      </div>
    </fieldset>
  );
}
