import { useId } from 'react';
import { fieldDomId, errorMessage, pick, setField, setPreferences, visibleFields, withOccupation } from '../lib/alertForm.js';
import { AreaPicker } from './AreaPicker.jsx';
import { useAlert } from './context.js';
import { FieldInput } from './FieldInput.jsx';
import { GeoButton } from './GeoButton.jsx';

// The four question steps of the wizard. Each receives the answers and a setter and draws its questions; the wizard owns navigation.
export function StepWho({ answers, setAnswers, errors }) {
  const { tr, lang, schema } = useAlert();
  const name = useId();
  const error = errors.occupation ? errorMessage(errors.occupation, lang) : null;
  return (
    <fieldset className="alert-fieldset" id={fieldDomId('occupation')} tabIndex={-1}>
      <legend className="alert-step-title">{tr('who.title')}</legend>
      <p className="alert-help">{tr('who.help')}</p>
      <div className="alert-cards" role="radiogroup" aria-describedby={error ? `${name}-error` : undefined}>
        {schema.occupations.map((occupation) => (
          <label key={occupation.value} className={`alert-card-choice${answers.occupation === occupation.value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={name}
              value={occupation.value}
              checked={answers.occupation === occupation.value}
              onChange={() => setAnswers((current) => withOccupation(current, occupation))}
              aria-invalid={Boolean(error)}
            />
            <strong>{pick(occupation.label, lang)}</strong>
            <span>{pick(occupation.description, lang)}</span>
          </label>
        ))}
      </div>
      {error && <p className="alert-field-error" id={`${name}-error`} role="alert">{error}</p>}
    </fieldset>
  );
}

export function StepWhere({ answers, setAnswers, errors }) {
  const { tr, lang } = useAlert();
  const error = errors.homeAreaPcode ? errorMessage(errors.homeAreaPcode, lang) : null;
  return (
    <div className="alert-step-body">
      <h2 className="alert-step-title" id="alert-step-heading">{tr('where.title')}</h2>
      <p className="alert-help">{tr('where.help')}</p>
      <GeoButton value={answers.homeAreaPcode} onFound={(pcode) => setAnswers((current) => ({ ...current, homeAreaPcode: pcode, locationMethod: 'gps_nearest' }))} />
      <AreaPicker
        id={fieldDomId('homeAreaPcode')}
        label={tr('where.home')}
        required
        value={answers.homeAreaPcode}
        error={error}
        onChange={(pcode) => setAnswers((current) => ({ ...current, homeAreaPcode: pcode, locationMethod: 'manual' }))}
      />
    </div>
  );
}

export function StepWork({ answers, setAnswers, errors, def }) {
  const { tr } = useAlert();
  return (
    <div className="alert-step-body">
      <h2 className="alert-step-title" id="alert-step-heading">{tr('work.title')}</h2>
      <p className="alert-help">{tr('work.help')}</p>
      {visibleFields(def, answers.occupationData).map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={answers.occupationData[field.key]}
          errorCode={errors[`occupationData.${field.key}`] ?? null}
          onChange={(value) => setAnswers((current) => setField(current, field.key, value))}
        />
      ))}
    </div>
  );
}

export function StepPrefs({ answers, setAnswers, errors }) {
  const { tr, lang } = useAlert();
  const quiet = answers.preferences.quietHours;
  const quietError = errors['preferences.quietHours'] ? errorMessage(errors['preferences.quietHours'], lang) : null;
  const setQuiet = (patch) => setAnswers((current) => setPreferences(current, { quietHours: { ...current.preferences.quietHours, ...patch } }));

  return (
    <div className="alert-step-body">
      <h2 className="alert-step-title" id="alert-step-heading">{tr('prefs.title')}</h2>
      <p className="alert-help">{tr('prefs.help')}</p>

      <fieldset className="alert-field" id={fieldDomId('preferences.quietHours')} tabIndex={-1}>
        <legend className="alert-label">{tr('prefs.quiet')}</legend>
        <label className="alert-check">
          <input type="checkbox" checked={quiet.enabled} onChange={(event) => setQuiet({ enabled: event.target.checked })} />
          <span>{tr('prefs.quiet.enable')}</span>
        </label>
        {quiet.enabled && (
          <div className="alert-times">
            <label><span>{tr('prefs.quiet.from')}</span><input type="time" value={quiet.start} onChange={(event) => setQuiet({ start: event.target.value })} aria-invalid={Boolean(quietError)} /></label>
            <label><span>{tr('prefs.quiet.to')}</span><input type="time" value={quiet.end} onChange={(event) => setQuiet({ end: event.target.value })} aria-invalid={Boolean(quietError)} /></label>
          </div>
        )}
        <p className="alert-help">{tr('prefs.quiet.note')}</p>
        {quietError && <p className="alert-field-error" role="alert">{quietError}</p>}
      </fieldset>

      <fieldset className="alert-field">
        <legend className="alert-label">{tr('prefs.heat')}</legend>
        <label className="alert-check">
          <input type="checkbox" checked={answers.isHeatSensitive} onChange={(event) => setAnswers((current) => ({ ...current, isHeatSensitive: event.target.checked }))} />
          <span>{tr('prefs.heat.label')}</span>
        </label>
        <p className="alert-help">{tr('prefs.heat.note')}</p>
      </fieldset>

      <fieldset className="alert-field">
        <legend className="alert-label">{tr('prefs.channels')}</legend>
        <p className="alert-help">{tr('prefs.channels.note')}</p>
      </fieldset>
    </div>
  );
}
