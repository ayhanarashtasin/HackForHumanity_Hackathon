import { useMemo, useState } from 'react';
import {
  buildBody, initialForm, sendableRoles, validateForm,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { AudiencePicker } from '../components/AudiencePicker.jsx';
import { Notice } from '../components/Parts.jsx';
import { AreaPicker, RolePicker } from '../components/Pickers.jsx';
import { SendSurface } from '../components/SendSurface.jsx';
import { useSendFlow } from '../hooks/useSendFlow.js';

// Send now from weather: the engine's own rules, run against the cached data right now, for the roles and areas chosen here.
export function WeatherTab({ onOpenHistory }) {
  const { options } = useAdmin();
  const [form, setForm] = useState(() => initialForm('weather', options));
  const body = useMemo(() => buildBody('weather', form), [form]);
  const problems = useMemo(() => validateForm('weather', form, options), [form, options]);
  const flow = useSendFlow({ mode: 'weather', currentBody: body });
  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  // "Send only Farmer alerts": narrow the form to that role, preview it again, then open the confirmation. The preview is never skipped.
  const onlyRole = (role) => {
    update({ roles: [role] });
    flow.run(buildBody('weather', { ...form, roles: [role] }), { confirm: true });
  };

  return (
    <SendSurface
      mode="weather"
      flow={flow}
      problems={problems}
      previewLabel="Check current weather"
      onOpenHistory={onOpenHistory}
      roleButtons={{ roles: flow.usable ? sendableRoles(flow.preview) : [], onRole: onlyRole }}
    >
      <Notice tone="info">
        The engine already sends automatically every few minutes. This checks the cached weather <strong>now</strong>, shows what would go out, and lets you send it without waiting.
      </Notice>
      <RolePicker value={form.roles} onChange={(roles) => update({ roles })} />
      <AreaPicker value={form.areas} onChange={(areas) => update({ areas })} legend="Narrow the area (optional)" />
      <AudiencePicker value={form.audience} onChange={(audience) => update({ audience })} />
    </SendSurface>
  );
}
