import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import {
  STEPS, buildPayload, fieldDomId, firstErrorPath, firstErrorStep, validateAll, validateStep,
} from '../lib/alertForm.js';
import { useAlert } from './context.js';
import { ReviewStep } from './ReviewStep.jsx';
import { StepPrefs, StepWhere, StepWho, StepWork } from './WizardSteps.jsx';

// Moves focus to the field that needs fixing (the first focusable thing inside a group, when the id belongs to a group).
function focusField(path) {
  const element = document.getElementById(fieldDomId(path));
  if (!element) return;
  const target = element.matches('input,select,textarea,button') ? element : (element.querySelector('input,select,textarea,button') ?? element);
  target.focus({ preventScroll: false });
}

// The five-step form. `answers` start from the schema defaults (create) or from the saved profile (edit). Navigation, validation and
// the submit live here; each step only draws its questions.
export function Wizard({ initialAnswers, onSubmit, onCancel, mode = 'create' }) {
  const { tr, lang, schema } = useAlert();
  const [step, setStep] = useState('who');
  const [answers, setAnswers] = useState(initialAnswers);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const headingRef = useRef(null);
  const pendingFocus = useRef(null);

  const def = schema.occupations.find((item) => item.value === answers.occupation) ?? null;
  const at = STEPS.indexOf(step);

  // What is stored follows what the page shows: the language switch also changes the profile's language.
  useEffect(() => {
    setAnswers((current) => (current.language === lang ? current : { ...current, language: lang }));
  }, [lang]);

  // After every step change focus the step's heading, or the first field with an error when we jumped back to fix one.
  useEffect(() => {
    const path = pendingFocus.current;
    pendingFocus.current = null;
    if (path) focusField(path);
    else headingRef.current?.focus();
  }, [step]);

  const go = (target, focus = null) => {
    pendingFocus.current = focus;
    setStep(target);
  };

  const next = () => {
    const found = validateStep(step, answers, def);
    if (Object.keys(found).length) {
      setErrors(found);
      focusField(firstErrorPath(found, step, def, answers));
      return;
    }
    setErrors({});
    go(STEPS[at + 1]);
  };

  const back = () => { setErrors({}); go(STEPS[at - 1]); };

  const submit = async () => {
    const found = validateAll(answers, def);
    if (Object.keys(found).length) {
      const target = firstErrorStep(found);
      setErrors(found);
      setProblem(tr('error.fix'));
      go(target, firstErrorPath(found, target, def, answers));
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await onSubmit(buildPayload(answers, def));
    } catch (error) {
      setBusy(false);
      if (error.details && Object.keys(error.details).length) {
        const target = firstErrorStep(error.details) ?? 'review';
        setErrors(error.details);
        setProblem(tr('error.fix'));
        go(target, firstErrorPath(error.details, target, def, answers));
      } else {
        setProblem(error.message || tr('error.save'));
      }
    }
  };

  const onFormSubmit = (event) => {
    event.preventDefault();
    if (step === 'review') submit();
    else next();
  };

  const body = {
    who: <StepWho answers={answers} setAnswers={setAnswers} errors={errors} />,
    where: <StepWhere answers={answers} setAnswers={setAnswers} errors={errors} />,
    work: def && <StepWork answers={answers} setAnswers={setAnswers} errors={errors} def={def} />,
    prefs: <StepPrefs answers={answers} setAnswers={setAnswers} errors={errors} />,
    review: def && <ReviewStep answers={answers} setAnswers={setAnswers} errors={errors} def={def} onEdit={(target) => go(target)} />,
  }[step];

  return (
    <form className="alert-wizard" onSubmit={onFormSubmit} noValidate>
      <nav className="alert-steps" aria-label={tr('wizard.nav')}>
        <ol>
          {STEPS.map((id, i) => (
            <li key={id} className={i < at ? 'is-done' : i === at ? 'is-current' : ''} aria-current={i === at ? 'step' : undefined}>
              <span className="alert-step-number" aria-hidden="true">{i < at ? <Icon name="check" size={14} /> : i + 1}</span>
              <span className="alert-step-name">{tr(`step.${id}`)}</span>
            </li>
          ))}
        </ol>
        <p className="alert-progress">{tr('wizard.progress', { n: at + 1, total: STEPS.length })}</p>
      </nav>

      {/* The heading of the step that just opened receives focus; "who" has its own legend so it gets a visible one here. */}
      <h2 className="sr-only" tabIndex={-1} ref={headingRef}>{tr(`step.${step}`)}</h2>

      <div className="alert-step">{body}</div>

      {problem && <p className="alert-banner alert-banner--problem" role="alert">{problem}</p>}

      <div className="alert-actions">
        {onCancel && step === 'who' && <button type="button" className="alert-button alert-button--ghost" onClick={onCancel}>{tr('btn.cancel')}</button>}
        {at > 0 && <button type="button" className="alert-button alert-button--ghost" onClick={back} disabled={busy}>{tr('btn.back')}</button>}
        {step !== 'review'
          ? <button type="submit" className="alert-button alert-button--primary">{tr('btn.next')}<Icon name="arrow" size={18} /></button>
          : <button type="submit" className="alert-button alert-button--primary" disabled={busy}>{busy ? tr('btn.saving') : tr(mode === 'edit' ? 'btn.save' : 'btn.start')}</button>}
      </div>
    </form>
  );
}
