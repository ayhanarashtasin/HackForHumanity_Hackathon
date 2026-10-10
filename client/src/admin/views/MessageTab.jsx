import { useId, useMemo, useState } from 'react';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import {
  SEVERITIES, buildBody, initialForm, validateForm,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { AudiencePicker } from '../components/AudiencePicker.jsx';
import { Field, Notice } from '../components/Parts.jsx';
import { AreaPicker, RolePicker } from '../components/Pickers.jsx';
import { SendSurface } from '../components/SendSurface.jsx';
import { useSendFlow } from '../hooks/useSendFlow.js';

// A free message: the administrator's own words, labelled as the administrator's, never as BMD.
export function MessageTab({ onOpenHistory }) {
  const { options } = useAdmin();
  const [form, setForm] = useState(() => initialForm('message', options));
  const body = useMemo(() => buildBody('message', form), [form]);
  const problems = useMemo(() => validateForm('message', form, options), [form, options]);
  const flow = useSendFlow({ mode: 'message', currentBody: body });
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const severityName = useId();
  const { limits } = options;

  const problem = (field) => problems.find((item) => item.field === field)?.message;
  const toggleAction = (key) => update({ actions: form.actions.includes(key) ? form.actions.filter((item) => item !== key) : [...form.actions, key] });
  const counter = (value, max) => <span className={`adm-counter${value.trim().length > max ? ' is-over' : ''}`}>{value.trim().length}/{max}</span>;

  return (
    <SendSurface mode="message" flow={flow} problems={problems} previewLabel="Preview message" onOpenHistory={onOpenHistory}>
      <Notice tone="info">
        Your text is sent as written and labelled <strong>Administrator</strong>. The preview warns about phrases such as “all clear” or “safe”; it does not block them.
      </Notice>

      <fieldset className="adm-fieldset">
        <legend>Severity</legend>
        <div className="adm-radios adm-radios-sev">
          {SEVERITIES.map((severity) => (
            <label key={severity} className={`adm-check adm-sev-choice${form.severity === severity ? ' is-chosen' : ''}`}>
              <input type="radio" name={severityName} checked={form.severity === severity} onChange={() => update({ severity })} />
              <SeverityChip severity={severity} />
            </label>
          ))}
        </div>
      </fieldset>

      <RolePicker value={form.roles} onChange={(roles) => update({ roles })} />
      <AreaPicker value={form.areas} onChange={(areas) => update({ areas })} />

      <div className="adm-grid-2">
        <Field label="Title (English, optional)" htmlFor="msg-title-en" counter={counter(form.titleEn, limits.titleMax)} error={problem('titleEn')}>
          <input id="msg-title-en" type="text" value={form.titleEn} onChange={(event) => update({ titleEn: event.target.value })} placeholder="Notice from the administrator" />
        </Field>
        <Field label="Title (Bangla, optional)" htmlFor="msg-title-bn" counter={counter(form.titleBn, limits.titleMax)} error={problem('titleBn')}>
          <input id="msg-title-bn" type="text" lang="bn" value={form.titleBn} onChange={(event) => update({ titleBn: event.target.value })} />
        </Field>
      </div>

      <div className="adm-grid-2">
        <Field label="Text (English, required)" htmlFor="msg-text-en" counter={counter(form.textEn, limits.textMax)} error={problem('textEn')}>
          <textarea id="msg-text-en" rows={5} value={form.textEn} onChange={(event) => update({ textEn: event.target.value })} />
        </Field>
        <Field
          label="Text (Bangla, optional)"
          htmlFor="msg-text-bn"
          counter={counter(form.textBn, limits.textMax)}
          error={problem('textBn')}
          hint="If you leave this empty, Bangla readers see your English text with a “Bangla not provided” marker."
        >
          <textarea id="msg-text-bn" rows={5} lang="bn" value={form.textBn} onChange={(event) => update({ textBn: event.target.value })} />
        </Field>
      </div>

      <Field label="Reference link (optional)" htmlFor="msg-link" error={problem('referenceUrl')} hint="Shown as “Reference supplied by administrator”. Only http:// or https:// addresses.">
        <input id="msg-link" type="url" inputMode="url" value={form.referenceUrl} onChange={(event) => update({ referenceUrl: event.target.value })} placeholder="https://" />
      </Field>

      <details className="adm-details">
        <summary>Recommended actions (optional){form.actions.length > 0 ? ` · ${form.actions.length} chosen` : ''}</summary>
        <div className="adm-checks adm-checks-grid">
          {options.actions.map((action) => (
            <label key={action.key} className="adm-check">
              <input type="checkbox" checked={form.actions.includes(action.key)} onChange={() => toggleAction(action.key)} />
              <span>{action.label.en}</span>
            </label>
          ))}
        </div>
      </details>

      <div className="adm-grid-2">
        <Field label="Valid for (hours)" htmlFor="msg-hours" hint={`1 to ${limits.maxHours} hours.`} error={problem('hours')}>
          <input id="msg-hours" type="number" min="1" max={limits.maxHours} value={form.hours} onChange={(event) => update({ hours: event.target.value })} />
        </Field>
        <AudiencePicker value={form.audience} onChange={(audience) => update({ audience })} />
      </div>
    </SendSurface>
  );
}
