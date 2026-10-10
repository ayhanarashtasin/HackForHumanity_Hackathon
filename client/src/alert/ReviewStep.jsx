import { useId } from 'react';
import { areaLabel, describeAnswers, errorMessage, fieldDomId, pick } from '../lib/alertForm.js';
import { useAlert } from './context.js';
import { digits } from './format.js';

// The last step: the answers as they will be saved, the alerts the person can expect, the consent text and the hidden honeypot.
export function ReviewStep({ answers, setAnswers, errors, def, onEdit }) {
  const { tr, lang, index, schema } = useAlert();
  const consentId = useId();
  const rows = describeAnswers(answers, def, index, lang);
  const quiet = answers.preferences.quietHours;
  const consentError = errors.consent ? errorMessage(errors.consent, lang) : null;
  const botError = errors.website ? errorMessage(errors.website, lang) : null;

  const summary = [
    { label: tr('review.occupation'), value: pick(def.label, lang), step: 'who' },
    { label: tr('review.home'), value: areaLabel(index, answers.homeAreaPcode, lang), step: 'where' },
    { label: tr('review.language'), value: tr(answers.language === 'bn' ? 'lang.bn' : 'lang.en'), step: null },
  ];
  const extras = [
    {
      label: tr('review.quiet'),
      value: quiet.enabled ? digits(`${quiet.start} – ${quiet.end}`, lang) : tr('review.off'),
    },
    { label: tr('review.heat'), value: answers.isHeatSensitive ? tr('yes') : tr('no') },
  ];

  return (
    <div className="alert-step-body">
      <h2 className="alert-step-title" id="alert-step-heading">{tr('review.title')}</h2>
      <p className="alert-help">{tr('review.help')}</p>

      <section className="alert-review" aria-label={tr('review.answers')}>
        <dl className="alert-dl">
          {summary.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}{row.step && <button type="button" className="alert-link-button" onClick={() => onEdit(row.step)}>{tr('btn.edit')}</button>}</dd>
            </div>
          ))}
          {rows.map((row) => (
            <div key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}<button type="button" className="alert-link-button" onClick={() => onEdit('work')}>{tr('btn.edit')}</button></dd>
            </div>
          ))}
          {extras.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}<button type="button" className="alert-link-button" onClick={() => onEdit('prefs')}>{tr('btn.edit')}</button></dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="alert-rules" aria-labelledby="alert-rules-title">
        <h3 id="alert-rules-title">{tr('review.rules')}</h3>
        <ul>
          {def.rules.map((rule) => (
            <li key={rule.id}><code>{rule.id}</code><span>{pick(rule.summary, lang)}</span></li>
          ))}
        </ul>
        <p className="alert-help">{tr('review.rules.note')}</p>
      </section>

      <fieldset className="alert-field alert-consent" id={fieldDomId('consent')} tabIndex={-1}>
        <legend className="alert-label">{tr('review.consent')}</legend>
        <p className="alert-consent-text" lang={lang}>{pick(schema.consentText, lang)}</p>
        <label className="alert-check" htmlFor={consentId}>
          <input id={consentId} type="checkbox" checked={answers.consent} onChange={(event) => setAnswers((current) => ({ ...current, consent: event.target.checked }))} aria-invalid={Boolean(consentError)} />
          <span>{tr('review.consent.label')}</span>
        </label>
        {consentError && <p className="alert-field-error" role="alert">{consentError}</p>}
      </fieldset>

      {/* A trap for bots: people never see or reach it. A filled value is rejected by the server. */}
      <div className="alert-honeypot" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={answers.website} onChange={(event) => setAnswers((current) => ({ ...current, website: event.target.value }))} />
        </label>
      </div>
      {botError && <p className="alert-field-error" role="alert">{botError}</p>}
    </div>
  );
}
