import { useMemo, useState } from 'react';
import { buildBody, hazardLabel, initialForm, validateForm } from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { AudiencePicker } from '../components/AudiencePicker.jsx';
import { Field, Notice } from '../components/Parts.jsx';
import { AreaPicker, RolePicker } from '../components/Pickers.jsx';
import { SendSurface } from '../components/SendSurface.jsx';
import { useSendFlow } from '../hooks/useSendFlow.js';

// Declare a hazard: the administrator asserts it, and each role receives its own wording from the catalogue rules.
export function DeclareTab({ onOpenHistory }) {
  const { options } = useAdmin();
  const [form, setForm] = useState(() => initialForm('declare', options));
  const body = useMemo(() => buildBody('declare', form), [form]);
  const problems = useMemo(() => validateForm('declare', form, options), [form, options]);
  const flow = useSendFlow({ mode: 'declare', currentBody: body });
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  const hazard = options.hazards.find((item) => item.type === form.hazardType);
  const levels = hazard ? Array.from({ length: hazard.maxLevel - hazard.minLevel + 1 }, (_, i) => hazard.minLevel + i) : [];
  const maxHours = options.limits.maxHours;

  const chooseHazard = (type) => {
    const next = options.hazards.find((item) => item.type === type);
    update({ hazardType: type, level: next ? Math.min(Math.max(Number(form.level), next.minLevel), next.maxLevel) : form.level });
  };

  return (
    <SendSurface mode="declare" flow={flow} problems={problems} previewLabel="Preview declaration" onOpenHistory={onOpenHistory}>
      <Notice tone="info" icon="shield">
        <strong>Declared by administrator, not detected from weather data.</strong> Use this for a real situation the data has not caught up with, or for a demonstration (choose <em>Demo subscribers only</em>).
      </Notice>

      <div className="adm-grid-3">
        <Field label="Hazard" htmlFor="declare-hazard">
          <select id="declare-hazard" value={form.hazardType} onChange={(event) => chooseHazard(event.target.value)}>
            <option value="">Choose a hazard…</option>
            {options.hazards.map((item) => <option key={item.type} value={item.type}>{hazardLabel(item.type, options)}</option>)}
          </select>
        </Field>
        <Field label="Level" htmlFor="declare-level" hint={hazard ? `Level ${hazard.minLevel} to ${hazard.maxLevel} for this hazard.` : 'Choose a hazard first.'}>
          <select id="declare-level" value={form.level} disabled={!hazard} onChange={(event) => update({ level: Number(event.target.value) })}>
            {levels.map((level) => <option key={level} value={level}>Level {level}</option>)}
          </select>
        </Field>
        <Field label="Valid for (hours)" htmlFor="declare-hours" hint={`1 to ${maxHours} hours.`}>
          <input id="declare-hours" type="number" min="1" max={maxHours} value={form.hours} onChange={(event) => update({ hours: event.target.value })} />
        </Field>
      </div>

      <RolePicker value={form.roles} onChange={(roles) => update({ roles })} />
      <AreaPicker
        value={form.areas}
        onChange={(areas) => update({ areas })}
        note={hazard?.needsArea === false ? `Applies to the ${options.marineZones.map((zone) => zone.name.en).join(', ')} sea zone, not to upazilas.` : null}
      />
      <AudiencePicker value={form.audience} onChange={(audience) => update({ audience })} />
    </SendSurface>
  );
}
