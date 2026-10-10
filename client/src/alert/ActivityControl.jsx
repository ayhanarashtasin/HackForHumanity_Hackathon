import { useId, useState } from 'react';
import { pick } from '../lib/alertForm.js';
import { alertApi } from '../services/alertApi.js';
import { useAlert } from './context.js';
import { formatDhaka } from './format.js';

// "Right now I am…" (CTX-01): what the person is doing now overrides their usual work for a while, then it expires on its own.
const DURATIONS = [1, 3, 6, 12];

export function ActivityControl({ profile, onChange }) {
  const { tr, lang, schema } = useAlert();
  const id = useId();
  const [key, setKey] = useState('');
  const [hours, setHours] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = profile.activeActivity;
  const label = (activity) => pick(schema.activities.find((item) => item.key === activity)?.label, lang) || activity;

  const send = async (body) => {
    setBusy(true);
    setError('');
    try {
      const data = await alertApi.setActivity(body);
      onChange(data.profile);
      setKey('');
    } catch (problem) {
      setError(problem.message || tr('act.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="alert-panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{tr('act.title')}</h2>
      <p className="alert-help">{tr('act.help')}</p>

      {current && (
        <p className="alert-note" role="status">
          {tr('act.current', { label: label(current.key), time: formatDhaka(current.expiresAt, lang) })}
          {' '}
          <button type="button" className="alert-link-button" onClick={() => send({ key: null })} disabled={busy}>{tr('act.clear')}</button>
        </p>
      )}

      <div className="alert-activity">
        <label>
          <span className="sr-only">{tr('act.title')}</span>
          <select value={key} onChange={(event) => setKey(event.target.value)}>
            <option value="">{tr('act.none')}</option>
            {schema.activities.map((activity) => <option key={activity.key} value={activity.key}>{pick(activity.label, lang)}</option>)}
          </select>
        </label>
        <label>
          <span>{tr('act.duration')}</span>
          <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {DURATIONS.map((value) => <option key={value} value={value}>{tr('act.hours', { n: value })}</option>)}
          </select>
        </label>
        <button type="button" className="alert-button alert-button--primary" disabled={!key || busy} onClick={() => send({ key, hours })}>{tr('act.set')}</button>
      </div>
      {error && <p className="alert-field-error" role="alert">{error}</p>}
    </section>
  );
}
