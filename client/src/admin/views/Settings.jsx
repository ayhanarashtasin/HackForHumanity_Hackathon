import { useState } from 'react';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import { OfficialNotice } from '../../components/OfficialNotice.jsx';
import {
  HAZARD_SWITCH_NOTES, SEVERITIES, bdDateTime, hazardLabel, heldStatus, roleLabel,
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
  const { guard } = useAdmin();
  const [pending, setPending] = useState(null);

  const confirm = async () => {
    const next = await guard(adminApi.saveSettings({ hold: { [pending.severity]: pending.value } }));
    onChange(next);
    setPending(null);
  };

  return (
    <Card title="Hold (wait for the administrator)" id="settings-hold">
      <p className="adm-hint">Off by default: the engine sends automatically when a threshold is met. A hold makes one severity wait here instead, as a safety valve while the rules are prototypes. A hold delays safety messages by as long as it takes you to release them.</p>
      <ul className="adm-switches">
        {SEVERITIES.map((severity) => (
          <li key={severity}>
            <Switch checked={settings.hold[severity]} label={`Hold ${severity} alerts`} describedBy={`hold-note-${severity}`} onChange={(value) => setPending({ severity, value })} />
            <div>
              <SeverityChip severity={severity} size="sm" />
              <span className="adm-switch-state">{settings.hold[severity] ? ' On: waiting for you' : ' Off: sent automatically'}</span>
              <p id={`hold-note-${severity}`} className="adm-hint">{HOLD_NOTES[severity]}</p>
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <ConfirmDialog
          title={pending.value ? `Hold ${pending.severity} alerts?` : `Stop holding ${pending.severity} alerts?`}
          confirmLabel={pending.value ? 'Turn hold on' : 'Turn hold off'}
          tone={pending.value && pending.severity === 'CRITICAL' ? 'critical' : 'default'}
          onConfirm={confirm}
          onClose={() => setPending(null)}
        >
          {pending.value
            ? <p>New {pending.severity} notifications will be prepared but <strong>not sent</strong> until you release them from “Send now from weather”. {pending.severity === 'CRITICAL' && 'This delays time-critical warnings.'}</p>
            : <p>New {pending.severity} notifications will be sent automatically again. Anything already held stays held until you send or discard it.</p>}
          <p className="adm-muted">This change is recorded in the audit log.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function KillSwitches({ settings, onChange }) {
  const { guard, options } = useAdmin();
  const [pending, setPending] = useState(null);

  const confirm = async () => {
    const next = await guard(adminApi.saveSettings({ hazardEnabled: { [pending.type]: pending.value } }));
    onChange(next);
    setPending(null);
  };

  return (
    <Card title="Hazard kill switches" id="settings-kill">
      <p className="adm-hint">Turning a hazard off stops the engine creating events of that type. Alerts that already exist are left alone until you withdraw them in History.</p>
      <ul className="adm-switches">
        {Object.entries(settings.hazardEnabled).map(([type, enabled]) => (
          <li key={type}>
            <Switch checked={enabled} label={`${hazardLabel(type, options)} detection`} describedBy={`kill-note-${type}`} onChange={(value) => setPending({ type, value })} />
            <div>
              <strong>{hazardLabel(type, options)}</strong>
              <span className="adm-switch-state">{enabled ? ' Enabled' : ' Switched off'}</span>
              <p id={`kill-note-${type}`} className="adm-hint">{HAZARD_SWITCH_NOTES[type] ?? ''}</p>
            </div>
          </li>
        ))}
      </ul>
      {pending && (
        <ConfirmDialog
          title={pending.value ? `Turn ${hazardLabel(pending.type, options)} detection back on?` : `Switch off ${hazardLabel(pending.type, options)} detection?`}
          confirmLabel={pending.value ? 'Turn on' : 'Switch off'}
          onConfirm={confirm}
          onClose={() => setPending(null)}
        >
          <p>{pending.value ? 'The engine will create events of this type again.' : 'The engine will stop creating events of this type, so no new automatic alerts of this kind will be sent. Existing alerts stay until withdrawn.'}</p>
          <p className="adm-muted">This change is recorded in the audit log.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function HeldAlerts({ held, onDone }) {
  const { guard } = useAdmin();
  const [open, setOpen] = useState(false);
  const status = heldStatus(held);
  if (!status.total) return null;

  const discard = async () => {
    const result = await guard(adminApi.discardHeld({}));
    setOpen(false);
    onDone(`Discarded ${result.discarded} held notification(s).`);
  };

  return (
    <Card title="Held alerts" id="settings-held" tone={status.criticalOverdue ? 'critical' : 'default'}>
      <p>{status.total} notification{status.total === 1 ? ' is' : 's are'} waiting for you{status.oldestMinutes !== null ? `; the oldest has waited ${status.oldestMinutes} min` : ''}. Send them from <strong>Send alerts → Send now from weather</strong>, or discard them.</p>
      <button type="button" className="adm-btn" onClick={() => setOpen(true)}>Discard held alerts</button>
      {open && (
        <ConfirmDialog title="Discard all held alerts?" confirmLabel="Discard" onConfirm={discard} onClose={() => setOpen(false)}>
          <p>Held notifications will be discarded and <strong>never sent</strong>. Subscribers will not be told.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

const SENDER = { automatic: 'Automatic alert (prototype rules)', administrator: 'Sent by the administrator', official: 'Official BMD notice (quoted)' };

function ViewAs({ subscriber, onClose }) {
  const [view, setView] = useState('active');
  const { data, error, loading } = useAdminResource((signal) => adminApi.demoInbox(subscriber.id, view, signal), [view, subscriber.id]);
  const { options } = useAdmin();

  return (
    <Card title={`Viewing as: ${roleLabel(options, subscriber.occupation)} in ${subscriber.area}`} id="view-as" action={<button type="button" className="adm-btn adm-btn-small" onClick={onClose}>Close</button>}>
      <p className="adm-hint">Read-only: this is exactly what that subscriber sees in their inbox.</p>
      <div className="adm-tabs adm-tabs-small" role="group" aria-label="Inbox view">
        {['active', 'earlier'].map((name) => (
          <button key={name} type="button" className={`adm-tab${view === name ? ' is-active' : ''}`} aria-pressed={view === name} onClick={() => setView(name)}>{name === 'active' ? 'Active now' : 'Earlier'}</button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <p className="adm-hint">No {view === 'active' ? 'active' : 'earlier'} alerts for this subscriber. That only means nothing has been sent to them; it is not an all-clear.</p>}
      {data && (
        <ul className="adm-inbox">
          {data.items.map((item) => (
            <li key={item.id} className={`adm-inbox-item adm-inbox-${item.severity.toLowerCase()}`}>
              <div className="adm-inbox-top">
                <SeverityChip severity={item.severity} />
                <span className="adm-muted">{SENDER[item.sender] ?? item.sender}</span>
                {item.status !== 'active' && <span className="adm-outcome">{item.status}</span>}
                {item.readAt ? <span className="adm-muted">read</span> : <strong>unread</strong>}
              </div>
              <h3>{item.title}</h3>
              <p>{item.message}</p>
              <OfficialNotice notice={item.evidence?.official} lang={item.lang} validityAssumed={item.evidence?.validityAssumed} />
              <p className="adm-muted">{item.affectedArea?.text} · valid until {bdDateTime(item.validUntil)} · rule <code>{item.scenarioId}</code> ({item.ruleStatus})</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DemoSubscribers() {
  const { guard, options } = useAdmin();
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
      <p className="adm-hint">One demo subscriber per role in an upazila you choose. They receive alerts only when you pick “Demo subscribers only”, so a demonstration never reaches real people. Open “View as” to see their inbox here, without a second device.</p>
      <div className="adm-demo-create">
        <UpazilaSearch picked={picked} onPick={setPicked} />
        <button type="button" className="adm-btn adm-btn-primary" disabled={!picked || busy} onClick={create}>{busy ? 'Creating…' : 'Create one demo subscriber per role'}</button>
      </div>
      <ErrorNote>{problem ?? error}</ErrorNote>
      {loading && !data && <Loading />}
      {data && data.length === 0 && <p className="adm-hint">There are no demo subscribers.</p>}
      {data && data.length > 0 && (
        <>
          <div className="adm-table-wrap">
            <table className="adm-table adm-table-stack">
              <thead><tr><th>Role</th><th>Area</th><th className="num">Unread</th><th><span className="sr-only">View</span></th></tr></thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Role">{roleLabel(options, row.occupation)}</td>
                    <td data-label="Area">{row.area}</td>
                    <td data-label="Unread" className="num">{row.unread}</td>
                    <td className="adm-cell-action"><button type="button" className="adm-btn adm-btn-small" onClick={() => setViewing(row)}>View as</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="adm-btn" onClick={() => setRemoving(true)}>Delete all demo subscribers</button>
        </>
      )}
      {viewing && <ViewAs subscriber={viewing} onClose={() => setViewing(null)} />}
      {removing && (
        <ConfirmDialog title="Delete all demo subscribers?" confirmLabel="Delete" onConfirm={removeAll} onClose={() => setRemoving(false)}>
          <p>This removes every demo subscriber and the alerts stored for them. Real subscribers are never touched.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

export function Settings() {
  const settings = useAdminResource((signal) => adminApi.settings(signal));
  const overview = useAdminResource((signal) => adminApi.overview(signal));
  const [done, setDone] = useState(null);

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>Settings</h1>
        {settings.data?.updatedAt && <span className="adm-muted">Last changed {bdDateTime(settings.data.updatedAt)}</span>}
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
