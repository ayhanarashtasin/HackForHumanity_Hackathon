import { useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import {
  answersFromProfile, areaLabel, describeAnswers, pick,
} from '../lib/alertForm.js';
import { alertApi } from '../services/alertApi.js';
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { useAlert } from './context.js';
import { digits } from './format.js';

// The profile: the answers as saved, and the three things a person can do with it: edit, pause or resume, delete.
export function ProfilePanel({ profile, onEdit, onProfile, onDeleted }) {
  const { tr, lang, schema, index } = useAlert();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const def = schema.occupations.find((item) => item.value === profile.occupation);
  const answers = def ? answersFromProfile(profile, def) : null;
  const rows = answers ? describeAnswers(answers, def, index, lang) : [];
  const paused = profile.status === 'paused';
  const quiet = profile.preferences?.quietHours;

  const togglePause = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await alertApi.setStatus(paused ? 'active' : 'paused');
      onProfile(data.profile);
    } catch (problem) {
      setError(problem.message || tr('profile.pauseError'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await alertApi.deleteProfile();
      onDeleted();
    } catch (problem) {
      setBusy(false);
      setConfirming(false);
      setError(problem.message || tr('profile.pauseError'));
    }
  };

  return (
    <section className="alert-panel" aria-labelledby="alert-profile-title">
      <h2 id="alert-profile-title">{tr('profile.title')}</h2>

      <dl className="alert-dl">
        <div><dt>{tr('review.occupation')}</dt><dd>{def ? pick(def.label, lang) : profile.occupation}</dd></div>
        <div>
          <dt>{tr('profile.areas')}</dt>
          <dd>
            <ul className="alert-plain">
              {profile.areas.map((area) => (
                <li key={`${area.role}-${area.upazilaPcode}`}>{tr(`role.${area.role}`)}: {areaLabel(index, area.upazilaPcode, lang)}</li>
              ))}
            </ul>
          </dd>
        </div>
        {rows.filter((row) => !/Pcode/.test(row.key)).map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        <div><dt>{tr('profile.language')}</dt><dd>{tr(profile.language === 'bn' ? 'lang.bn' : 'lang.en')}</dd></div>
        <div><dt>{tr('profile.quiet')}</dt><dd>{quiet?.enabled ? digits(`${quiet.start} – ${quiet.end}`, lang) : tr('review.off')}</dd></div>
        <div><dt>{tr('review.heat')}</dt><dd>{profile.isHeatSensitive ? tr('yes') : tr('no')}</dd></div>
      </dl>
      <p className="alert-help">{tr('profile.languageNote')}</p>

      <div className="alert-profile-actions">
        <button type="button" className="alert-button alert-button--ghost" onClick={onEdit}><Icon name="edit" size={18} />{tr('profile.edit')}</button>
        <button type="button" className="alert-button alert-button--ghost" onClick={togglePause} disabled={busy}>{paused ? tr('profile.resume') : tr('profile.pause')}</button>
        <button type="button" className="alert-button alert-button--danger-ghost" onClick={() => setConfirming(true)} disabled={busy}><Icon name="trash" size={18} />{tr('profile.delete')}</button>
      </div>
      {error && <p className="alert-field-error" role="alert">{error}</p>}

      {confirming && (
        <ConfirmDialog
          title={tr('profile.deleteTitle')}
          body={tr('profile.deleteBody')}
          confirmLabel={tr('profile.deleteYes')}
          cancelLabel={tr('profile.deleteNo')}
          busy={busy}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
