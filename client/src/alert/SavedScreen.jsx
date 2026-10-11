import { useEffect, useState } from 'react';
import { DataStatus } from '../components/DataStatus.jsx';
import { Icon } from '../components/Icon.jsx';
import { SEVERITY_LABELS } from '../components/SeverityChip.jsx';
import { areaLabel, pick } from '../lib/alertForm.js';
import { alertApi } from '../services/alertApi.js';
import { useAlert } from './context.js';
import { ageText, formatDhaka } from './format.js';
import { useLanguage } from '../i18n/index.js';

// Shown right after sign-up: the plain facts about how these alerts work, so nobody is surprised later.
export function SavedScreen({ profile, onContinue }) {
  const { tr, lang, index, schema } = useAlert();
  const { tr: text } = useLanguage();
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    alertApi.status(controller.signal).then(setStatus).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  const held = status?.hold?.map((severity) => SEVERITY_LABELS[severity]?.[lang] ?? severity).join(', ');
  // A fisherman at sea is watched by sea area, which is an answer rather than one of the area codes.
  const seaField = schema.occupations.find((item) => item.value === profile.occupation)?.fields.find((field) => field.key === 'marineZone');
  const seaValue = profile.occupationData?.marineZone;
  const seaName = seaField && seaValue ? pick(seaField.options.find((option) => option.value === seaValue)?.label, lang) : '';

  return (
    <div className="alert-saved">
      <div className="alert-saved-head">
        <span className="alert-saved-icon" aria-hidden="true"><Icon name="check" size={26} /></span>
        <div>
          <h1 tabIndex={-1} id="alert-saved-title">{tr('saved.title')}</h1>
          <p className="alert-lead">{tr('saved.lead')}</p>
        </div>
      </div>

      <section className="alert-panel">
        <h2>{tr('saved.areas')}</h2>
        <ul className="alert-plain">
          {profile.areas.map((area) => <li key={`${area.role}-${area.upazilaPcode}`}><Icon name="pin" size={16} />{tr(`role.${area.role}`)}: <strong>{areaLabel(index, area.upazilaPcode, lang)}</strong></li>)}
          {seaName && <li><Icon name="pin" size={16} />{tr('saved.sea')}: <strong>{seaName}</strong></li>}
        </ul>
      </section>

      <section className="alert-panel">
        <h2>{tr('saved.sent.title')}</h2>
        <p>{tr('saved.sent.body')}</p>
        {held && <p className="alert-note">{tr('saved.hold', { levels: held })}</p>}
      </section>

      <section className="alert-panel">
        <h2>{tr('saved.monitoring')}</h2>
        {status && <p>{tr('saved.monitoring.areas', { n: status.monitoring.areas })}</p>}
        {failed && <p className="alert-note" role="status">{tr('cov.loadError')}</p>}
        {!status && !failed && <p className="alert-muted" role="status">{tr('cov.loading')}</p>}
        {status && (
          <>
            <h3 className="alert-subhead">{tr('saved.sources')}</h3>
            <ul className="alert-sources">
              {status.sources.map((source) => (
                <li key={source.key}>
                  <div><strong>{text(source.label)}</strong><DataStatus status={source.status} lang={lang} /></div>
                  <p className="alert-coverage-meta">
                    {source.note === 'not-configured' ? tr('source.notConfigured') : (
                      <>
                        {source.cadenceMinutes ? `${tr('source.cadence', { n: source.cadenceMinutes })} · ` : ''}
                        {source.checkedAt ? tr('cov.checked', { time: `${formatDhaka(source.checkedAt, lang)} (${ageText(source.checkedAt, lang)})` }) : tr('source.never')}
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            <h3 className="alert-subhead">{tr('saved.lightning')}</h3>
            <p className="alert-note">{text(status.monitoring.lightning)}</p>
          </>
        )}
      </section>

      <p className="alert-help">{tr('saved.channels')}</p>
      <p className="alert-help">{tr('saved.browser')}</p>
      <div className="alert-actions">
        <button type="button" className="alert-button alert-button--primary" onClick={onContinue}>{tr('saved.continue')}<Icon name="arrow" size={18} /></button>
      </div>
    </div>
  );
}
