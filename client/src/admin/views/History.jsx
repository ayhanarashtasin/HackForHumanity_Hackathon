import { useState } from 'react';
import { DataStatus } from '../../components/DataStatus.jsx';
import { Icon } from '../../components/Icon.jsx';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import {
  ACTION_NAMES, bdDateTime, describeError, describeStoredAreas, hazardLabel, roleLabel,
} from '../../lib/adminForm.js';
import { adminApi } from '../../services/adminApi.js';
import { useAdmin } from '../AdminContext.jsx';
import { useAdminResource } from '../hooks/useAdminData.js';
import { Modal } from '../components/Modal.jsx';
import {
  Card, ErrorNote, Loading, Notice,
} from '../components/Parts.jsx';

const WITHDRAWABLE = new Set(['send-weather', 'declare', 'message']);

function Delivery({ delivery }) {
  if (!delivery) return <span className="adm-muted">—</span>;
  const parts = [`${delivery.total} sent`, `${delivery.read} read`];
  if (delivery.withdrawn) parts.push(`${delivery.withdrawn} withdrawn`);
  return <span>{parts.join(' · ')}</span>;
}

// Withdrawing marks notifications withdrawn with a plain explanation. It is recorded as an administrator withdrawal and is never an all-clear.
function WithdrawDialog({ target, onClose, onDone }) {
  const { guard } = useAdmin();
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ busy: false, error: null, calm: null });

  const submit = async () => {
    setState({ busy: true, error: null, calm: null });
    try {
      const result = await guard(adminApi.withdraw(target.id, reason.trim()));
      onDone(`Withdrawn: ${result.events} event(s), ${result.notifications} notification(s).`);
    } catch (error) {
      if (error.status === 404) setState({ busy: false, error: null, calm: 'Nothing to withdraw: those alerts have already ended.' });
      else setState({ busy: false, error: describeError(error), calm: null });
    }
  };

  return (
    <Modal
      title="Withdraw this send?"
      busy={state.busy}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="adm-btn" onClick={onClose} disabled={state.busy} data-autofocus>{state.calm ? 'Close' : 'Cancel'}</button>
          {!state.calm && <button type="button" className="adm-btn adm-btn-primary" onClick={submit} disabled={state.busy}>{state.busy ? 'Withdrawing…' : 'Withdraw'}</button>}
        </>
      )}
    >
      <p><strong>{target.label}</strong></p>
      <p>Subscribers will see: <em>“The administrator withdrew this alert. This is not an all-clear.”</em> A withdrawal does not tell anyone the danger has passed.</p>
      <div className="adm-field">
        <div className="adm-field-label"><label htmlFor="withdraw-reason">Reason (optional, shown to subscribers)</label><span className="adm-counter">{reason.length}/200</span></div>
        <input id="withdraw-reason" type="text" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} disabled={state.busy} />
      </div>
      {state.calm && <Notice tone="info">{state.calm}</Notice>}
      <ErrorNote>{state.error}</ErrorNote>
    </Modal>
  );
}

export function History() {
  const { options, areaIndex } = useAdmin();
  const { data, error, loading, reload } = useAdminResource((signal) => adminApi.history(signal));
  const [target, setTarget] = useState(null);
  const [done, setDone] = useState(null);

  const finished = (message) => {
    setTarget(null);
    setDone(message);
    reload();
  };

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>History</h1>
        <button type="button" className="adm-btn" onClick={reload}><Icon name="refresh" size={16} /> Refresh</button>
      </header>
      {done && <Notice tone="info" icon="check">{done}</Notice>}
      <ErrorNote onRetry={reload}>{error}</ErrorNote>
      {loading && !data && <Loading />}

      {data && (
        <>
          <Card title="Sends and actions" id="history-sends">
            {data.sends.length === 0 ? <p className="adm-hint">Nothing has been sent from this dashboard yet.</p> : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table-stack">
                  <thead>
                    <tr><th>When</th><th>Action</th><th>Roles</th><th>Where</th><th>Severity</th><th>Delivery</th><th>Outcome</th><th><span className="sr-only">Withdraw</span></th></tr>
                  </thead>
                  <tbody>
                    {data.sends.map((send) => (
                      <tr key={send.id}>
                        <td data-label="When">{bdDateTime(send.at)}</td>
                        <td data-label="Action">
                          <strong>{ACTION_NAMES[send.action] ?? send.action}</strong>
                          {send.summary && <small className="adm-block adm-muted">{send.summary}</small>}
                          {send.reason && <small className="adm-block adm-muted">Reason: {send.reason}</small>}
                        </td>
                        <td data-label="Roles">{send.roles?.length ? send.roles.map((role) => roleLabel(options, role)).join(', ') : '—'}</td>
                        <td data-label="Where">{send.areas ? describeStoredAreas(send.areas, areaIndex) : '—'}{send.audience === 'demo' && <small className="adm-block adm-muted">Demo subscribers</small>}</td>
                        <td data-label="Severity">{send.severity ? <SeverityChip severity={send.severity} size="sm" /> : '—'}</td>
                        <td data-label="Delivery"><Delivery delivery={send.delivery} /></td>
                        <td data-label="Outcome"><span className={`adm-outcome adm-outcome-${send.outcome}`}>{send.outcome}</span></td>
                        <td className="adm-cell-action">
                          {WITHDRAWABLE.has(send.action) && send.outcome === 'ok' && send.batchId && (
                            <button type="button" className="adm-btn adm-btn-small" onClick={() => setTarget({ id: send.batchId, label: `${ACTION_NAMES[send.action]} · ${bdDateTime(send.at)}` })}>Withdraw</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Automatic alerts, last 48 hours" id="history-auto">
            {data.automatic.length === 0 ? <p className="adm-hint">The engine has not detected any hazard in the last 48 hours.</p> : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table-stack">
                  <thead>
                    <tr><th>Detected</th><th>Hazard</th><th>Area</th><th>Lifecycle</th><th>Data</th><th>Delivery</th><th>Valid until</th><th><span className="sr-only">Withdraw</span></th></tr>
                  </thead>
                  <tbody>
                    {data.automatic.map((event) => (
                      <tr key={event.id}>
                        <td data-label="Detected">{bdDateTime(event.firstDetectedAt)}</td>
                        <td data-label="Hazard">{hazardLabel(event.hazardType, options)}{event.level ? ` · level ${event.level}` : ''}</td>
                        <td data-label="Area">{event.area || '—'}</td>
                        <td data-label="Lifecycle"><span className={`adm-outcome adm-life-${event.lifecycle}`}>{event.lifecycle}</span></td>
                        <td data-label="Data"><DataStatus status={event.dataStatus ?? 'FRESH'} /></td>
                        <td data-label="Delivery"><Delivery delivery={{ total: event.delivery.total, read: event.delivery.read }} /></td>
                        <td data-label="Valid until">{bdDateTime(event.validUntil)}</td>
                        <td className="adm-cell-action">
                          {event.lifecycle === 'active' && (
                            <button type="button" className="adm-btn adm-btn-small" onClick={() => setTarget({ id: event.id, label: `${hazardLabel(event.hazardType, options)} in ${event.area || 'its area'}` })}>Withdraw</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {target && <WithdrawDialog target={target} onClose={() => setTarget(null)} onDone={finished} />}
    </div>
  );
}
