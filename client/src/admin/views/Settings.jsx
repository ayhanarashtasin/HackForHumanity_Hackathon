import { useState } from 'react';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import { OfficialNotice } from '../../components/OfficialNotice.jsx';
import {
  HAZARD_SWITCH_NOTES, SEVERITIES, areaName, bdDateTime, hazardLabel, heldStatus, roleLabel,
} from '../../lib/adminForm.js';
import { adminApi } from '../../services/adminApi.js';
import { useAdmin } from '../AdminContext.jsx';
import { useAdminResource } from '../hooks/useAdminData.js';
import { ConfirmDialog } from '../components/ConfirmDialog.jsx';
import {
  Card, ErrorNote, Loading, Notice, Switch,
} from '../components/Parts.jsx';
import { UpazilaSearch } from '../components/Pickers.jsx';

const HOLD_NOTES = {
  ADVISORY: 'Advisories wait for you instead of being sent automatically. Low urgency, so a delay costs little.',
  WARNING: 'Warnings wait for you. They are significant, so a delay costs something: check often while this is on.',
  CRITICAL: 'CRITICAL alerts (lightning, thunderstorm) wait for you. These are time-critical protective actions: holding them is risky, and every minute of delay is a minute without the warning.',
};

function HoldSwitches({ settings, onChange }) {
  const { tr } = useLanguage(ADMIN);
  const { guard } = useAdmin();
  const [pending, setPending] = useState(null);

  const confirm = async () => {
    const next = await guard(adminApi.saveSettings({ hold: { [pending.severity]: pending.value } }));
    onChange(next);
    setPending(null);
  };

  return (
    <Card title="Hold (wait for the administrator)" id="settings-hold">
      <p className="adm-hint">{tr('Off by default: the engine sends automatically when a threshold is met. A hold makes one severity wait here instead, as a safety valve while the rules are prototypes. A hold delays safety messages by as long as it takes you to release them.')}</p>
      <ul className="adm-switches">
        {SEVERITIES.map((severity) => (
          <li key={severity}>
            <Switch checked={settings.hold[severity]} label={tr('Hold {severity} alerts', { severity: tr(severity) })} describedBy={`hold-note-${severity}`} onChange={(value) => setPending({ severity, value })} />
            <div>
              <SeverityChip severity={severity} size="sm" />
              <span className="adm-switch-state"> {tr(settings.hold[severity] ? 'On: waiting for you' : 'Off: sent automatically')}</span>
              <p id={`hold-note-${severity}`} className="adm-hint">{tr(HOLD_NOTES[severity])}</p>
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <ConfirmDialog
          title={tr(pending.value ? 'Hold {severity} alerts?' : 'Stop holding {severity} alerts?', { severity: tr(pending.severity) })}
          confirmLabel={pending.value ? 'Turn hold on' : 'Turn hold off'}
          tone={pending.value && pending.severity === 'CRITICAL' ? 'critical' : 'default'}
          onConfirm={confirm}
          onClose={() => setPending(null)}
        >
          {pending.value
            ? <p>{tr('New {severity} notifications will be prepared but not sent until you release them from “Send now from weather”.', { severity: tr(pending.severity) })} {pending.severity === 'CRITICAL' && tr('This delays time-critical warnings.')}</p>
            : <p>{tr('New {severity} notifications will be sent automatically again. Anything already held stays held until you send or discard it.', { severity: tr(pending.severity) })}</p>}
          <p className="adm-muted">{tr('This change is recorded in the audit log.')}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function KillSwitches({ settings, onChange }) {
  const { tr } = useLanguage(ADMIN);
  const { guard, options } = useAdmin();
  const [pending, setPending] = useState(null);

  const confirm = async () => {
    const next = await guard(adminApi.saveSettings({ hazardEnabled: { [pending.type]: pending.value } }));
    onChange(next);
    setPending(null);
  };

  return (
    <Card title="Hazard kill switches" id="settings-kill">
      <p className="adm-hint">{tr('Turning a hazard off stops the engine creating events of that type. Alerts that already exist are left alone until you withdraw them in History.')}</p>
      <ul className="adm-switches">
        {Object.entries(settings.hazardEnabled).map(([type, enabled]) => (
          <li key={type}>
            <Switch checked={enabled} label={tr('{hazard} detection', { hazard: hazardLabel(type, options) })} describedBy={`kill-note-${type}`} onChange={(value) => setPending({ type, value })} />
            <div>
              <strong>{hazardLabel(type, options)}</strong>
              <span className="adm-switch-state"> {tr(enabled ? 'Enabled' : 'Switched off')}</span>
              <p id={`kill-note-${type}`} className="adm-hint">{tr(HAZARD_SWITCH_NOTES[type] ?? '')}</p>
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <ConfirmDialog
          title={tr(pending.value ? 'Turn {hazard} detection back on?' : 'Switch off {hazard} detection?', { hazard: hazardLabel(pending.type, options) })}
          confirmLabel={pending.value ? 'Turn on' : 'Switch off'}
          onConfirm={confirm}
          onClose={() => setPending(null)}
        >
          <p>{tr(pending.value ? 'The engine will create events of this type again.' : 'The engine will stop creating events of this type, so no new automatic alerts of this kind will be sent. Existing alerts stay until withdrawn.')}</p>
          <p className="adm-muted">{tr('This change is recorded in the audit log.')}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function HeldAlerts({ held, onDone }) {
  const { tr } = useLanguage(ADMIN);
  const { guard } = useAdmin();
  const [open, setOpen] = useState(false);
  const status = heldStatus(held);
  if (!status.total) return null;

  const discard = async () => {
    const result = await guard(adminApi.discardHeld({}));
    setOpen(false);
    onDone(tr('Discarded {n} held notifications.', { n: result.discarded }));
  };

  return (
    <Card title="Held alerts" id="settings-held" tone={status.criticalOverdue ? 'critical' : 'default'}>
      <p>{tr('{n} notifications are waiting for you.', { n: status.total })} {status.oldestMinutes !== null && tr('The oldest has waited {n} min.', { n: status.oldestMinutes })} {tr('Send them from Send alerts → Send now from weather, or discard them.')}</p>
      <button type="button" className="adm-btn" onClick={() => setOpen(true)}>{tr('Discard held alerts')}</button>
      {open && (
        <ConfirmDialog title="Discard all held alerts?" confirmLabel="Discard" onConfirm={discard} onClose={() => setOpen(false)}>
          <p>{tr('Held notifications will be discarded and never sent. Subscribers will not be told.')}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

const SENDER = { automatic: 'Automatic alert (prototype rules)', administrator: 'Sent by the administrator', official: 'Official BMD notice (quoted)' };

function ViewAs({ subscriber, onClose }) {
  const { tr } = useLanguage(ADMIN);
  const [view, setView] = useState('active');
  const { data, error, loading } = useAdminResource((signal) => adminApi.demoInbox(subscriber.id, view, signal), [view, subscriber.id]);
  const { options, areaIndex } = useAdmin();

  return (
    <Card title={tr('Viewing as: {role} in {area}', { role: roleLabel(options, subscriber.occupation), area: areaName(subscriber.area, areaIndex) })} id="view-as" action={<button type="button" className="adm-btn adm-btn-small" onClick={onClose}>{tr('Close')}</button>}>
      <p className="adm-hint">{tr('Read-only: this is exactly what that subscriber sees in their inbox.')}</p>
      <div className="adm-tabs adm-tabs-small" role="group" aria-label={tr('Inbox view')}>
        {['active', 'earlier'].map((name) => (
          <button key={name} type="button" className={`adm-tab${view === name ? ' is-active' : ''}`} aria-pressed={view === name} onClick={() => setView(name)}>{tr(name === 'active' ? 'Active now' : 'Earlier')}</button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <p className="adm-hint">{tr('No alerts in this view for this subscriber. That only means nothing has been sent to them; it is not an all-clear.')}</p>}
      {data && (
        <ul className="adm-inbox">
          {data.items.map((item) => (
            <li key={item.id} className={`adm-inbox-item adm-inbox-${item.severity.toLowerCase()}`}>
              <div className="adm-inbox-top">
                <SeverityChip severity={item.severity} />
                <span className="adm-muted">{tr(SENDER[item.sender] ?? item.sender)}</span>
                {item.status !== 'active' && <span className="adm-outcome">{tr(item.status)}</span>}
                {item.readAt ? <span className="adm-muted">{tr('read')}</span> : <strong>{tr('unread')}</strong>}
              </div>
               <h3 lang={item.lang}>{item.title}</h3>
               <p lang={item.lang}>{item.message}</p>
              <OfficialNotice notice={item.evidence?.official} lang={item.lang} validityAssumed={item.evidence?.validityAssumed} />
              <p className="adm-muted">{item.affectedArea?.text} · {tr('Valid until {time}', { time: bdDateTime(item.validUntil) })} · {tr('Rule')} <code>{item.scenarioId}</code> ({tr(item.ruleStatus)})</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DemoSubscribers() {
  const { tr, number } = useLanguage(ADMIN);
  const { guard, options, areaIndex } = useAdmin();
  const { data, error, loading, reload } = useAdminResource((signal) => adminApi.demoList(signal));
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [removing, setRemoving] = useState(false);

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await guard(adminApi.demoCreate(picked.code));
      reload();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    await guard(adminApi.demoDelete());
    setRemoving(false);
    setViewing(null);
    reload();
  };

  return (
    <Card title="Demo subscribers" id="settings-demo">
      <p className="adm-hint">{tr('One demo subscriber per role in an upazila you choose. They receive alerts only when you pick “Demo subscribers only”, so a demonstration never reaches real people. Open “View as” to see their inbox here, without a second device.')}</p>
      <div className="adm-demo-create">
        <UpazilaSearch picked={picked} onPick={setPicked} />
        <button type="button" className="adm-btn adm-btn-primary" disabled={!picked || busy} onClick={create}>{tr(busy ? 'Creating…' : 'Create one demo subscriber per role')}</button>
      </div>
      <ErrorNote>{problem ?? error}</ErrorNote>
      {loading && !data && <Loading />}
      {data && data.length === 0 && <p className="adm-hint">{tr('There are no demo subscribers.')}</p>}
      {data && data.length > 0 && (
        <>
          <div className="adm-table-wrap">
            <table className="adm-table adm-table-stack">
              <thead><tr>{['Role', 'Area', 'Unread', 'View'].map((label) => <th key={label}>{tr(label)}</th>)}</tr></thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td data-label={tr('Role')}>{roleLabel(options, row.occupation)}</td>
                    <td data-label={tr('Area')}>{areaName(row.area, areaIndex)}</td>
                    <td data-label={tr('Unread')} className="num">{number(row.unread)}</td>
                    <td className="adm-cell-action"><button type="button" className="adm-btn adm-btn-small" onClick={() => setViewing(row)}>{tr('View as')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="adm-btn" onClick={() => setRemoving(true)}>{tr('Delete all demo subscribers')}</button>
        </>
      )}
      {viewing && <ViewAs subscriber={viewing} onClose={() => setViewing(null)} />}
      {removing && (
        <ConfirmDialog title="Delete all demo subscribers?" confirmLabel="Delete" onConfirm={removeAll} onClose={() => setRemoving(false)}>
          <p>{tr('This removes every demo subscriber and the alerts stored for them. Real subscribers are never touched.')}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

export function Settings() {
  const { tr } = useLanguage(ADMIN);
  const settings = useAdminResource((signal) => adminApi.settings(signal));
  const overview = useAdminResource((signal) => adminApi.overview(signal));
  const [done, setDone] = useState(null);

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>{tr('Settings')}</h1>
        {settings.data?.updatedAt && <span className="adm-muted">{tr('Last changed {time}', { time: bdDateTime(settings.data.updatedAt) })}</span>}
      </header>
      {done && <Notice tone="info" icon="check">{done}</Notice>}
      <ErrorNote onRetry={settings.reload}>{settings.error}</ErrorNote>
      {settings.loading && !settings.data && <Loading />}
      {overview.data && <HeldAlerts held={overview.data.held} onDone={(message) => { setDone(message); overview.reload(); }} />}
      {settings.data && (
        <>
          <HoldSwitches settings={settings.data} onChange={settings.setData} />
          <KillSwitches settings={settings.data} onChange={settings.setData} />
        </>
      )}
      <DemoSubscribers />
    </div>
  );
}
