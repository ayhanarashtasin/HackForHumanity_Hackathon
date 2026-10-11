import { useState } from 'react';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';
import { DataStatus } from '../../components/DataStatus.jsx';
import { Icon } from '../../components/Icon.jsx';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import {
  ACTION_NAMES, areaName, bdDateTime, describeError, describeStoredAreas, hazardLabel, roleLabel,
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
  const { tr } = useLanguage(ADMIN);
  if (!delivery) return <span className="adm-muted">—</span>;
  const parts = [tr('{n} sent', { n: delivery.total }), tr('{n} read', { n: delivery.read })];
  if (delivery.withdrawn) parts.push(tr('{n} withdrawn', { n: delivery.withdrawn }));
  return <span>{parts.join(' · ')}</span>;
}

// Withdrawing marks notifications withdrawn with a plain explanation. It is recorded as an administrator withdrawal and is never an all-clear.
function WithdrawDialog({ target, onClose, onDone }) {
  const { tr, number } = useLanguage(ADMIN);
  const { guard } = useAdmin();
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ busy: false, error: null, calm: null });

  const submit = async () => {
    setState({ busy: true, error: null, calm: null });
    try {
      const result = await guard(adminApi.withdraw(target.id, reason.trim()));
      onDone(tr('Withdrawn: {events} events, {notifications} notifications.', { events: result.events, notifications: result.notifications }));
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
          <button type="button" className="adm-btn" onClick={onClose} disabled={state.busy} data-autofocus>{tr(state.calm ? 'Close' : 'Cancel')}</button>
          {!state.calm && <button type="button" className="adm-btn adm-btn-primary" onClick={submit} disabled={state.busy}>{tr(state.busy ? 'Withdrawing…' : 'Withdraw')}</button>}
        </>
      )}
    >
      <p><strong>{target.label}</strong></p>
      <p>{tr('Subscribers will see that the administrator withdrew the alert. A withdrawal does not mean the danger has passed.')}</p>
      <div className="adm-field">
        <div className="adm-field-label"><label htmlFor="withdraw-reason">{tr('Reason (optional, shown to subscribers)')}</label><span className="adm-counter">{number(reason.length)}/{number(200)}</span></div>
        <input id="withdraw-reason" type="text" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} disabled={state.busy} />
      </div>
      {state.calm && <Notice tone="info">{state.calm}</Notice>}
      <ErrorNote>{state.error}</ErrorNote>
    </Modal>
  );
}

export function History() {
  const { tr } = useLanguage(ADMIN);
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
        <h1>{tr('History')}</h1>
        <button type="button" className="adm-btn" onClick={reload}><Icon name="refresh" size={16} /> {tr('Refresh')}</button>
      </header>
      {done && <Notice tone="info" icon="check">{done}</Notice>}
      <ErrorNote onRetry={reload}>{error}</ErrorNote>
      {loading && !data && <Loading />}

      {data && (
        <>
          <Card title="Sends and actions" id="history-sends">
            {data.sends.length === 0 ? <p className="adm-hint">{tr('Nothing has been sent from this dashboard yet.')}</p> : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table-stack">
                  <thead>
                    <tr>{['When', 'Action', 'Roles', 'Where', 'Severity', 'Delivery', 'Outcome', 'Withdraw'].map((label) => <th key={label}>{tr(label)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.sends.map((send) => (
                      <tr key={send.id}>
                        <td data-label={tr('When')}>{bdDateTime(send.at)}</td>
                        <td data-label={tr('Action')}>
                          <strong>{tr(ACTION_NAMES[send.action] ?? send.action)}</strong>
                          {send.summary && <small className="adm-block adm-muted">{send.summary}</small>}
                          {send.reason && <small className="adm-block adm-muted">{tr('Reason: {reason}', { reason: send.reason })}</small>}
                        </td>
                        <td data-label={tr('Roles')}>{send.roles?.length ? send.roles.map((role) => roleLabel(options, role)).join(', ') : '—'}</td>
                        <td data-label={tr('Where')}>{send.areas ? describeStoredAreas(send.areas, areaIndex) : '—'}{send.audience === 'demo' && <small className="adm-block adm-muted">{tr('Demo subscribers')}</small>}</td>
                        <td data-label={tr('Severity')}>{send.severity ? <SeverityChip severity={send.severity} size="sm" /> : '—'}</td>
                        <td data-label={tr('Delivery')}><Delivery delivery={send.delivery} /></td>
                        <td data-label={tr('Outcome')}><span className={`adm-outcome adm-outcome-${send.outcome}`}>{tr(send.outcome)}</span></td>
                        <td className="adm-cell-action">
                          {WITHDRAWABLE.has(send.action) && send.outcome === 'ok' && send.batchId && (
                            <button type="button" className="adm-btn adm-btn-small" onClick={() => setTarget({ id: send.batchId, label: `${tr(ACTION_NAMES[send.action])} · ${bdDateTime(send.at)}` })}>{tr('Withdraw')}</button>
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
            {data.automatic.length === 0 ? <p className="adm-hint">{tr('The engine has not detected any hazard in the last 48 hours.')}</p> : (
              <div className="adm-table-wrap">
                <table className="adm-table adm-table-stack">
                  <thead>
                    <tr>{['Detected', 'Hazard', 'Area', 'Lifecycle', 'Data', 'Delivery', 'Valid until', 'Withdraw'].map((label) => <th key={label}>{tr(label)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.automatic.map((event) => (
                      <tr key={event.id}>
                        <td data-label={tr('Detected')}>{bdDateTime(event.firstDetectedAt)}</td>
                        <td data-label={tr('Hazard')}>{hazardLabel(event.hazardType, options)}{event.level ? ` · ${tr('level {n}', { n: event.level })}` : ''}</td>
                        <td data-label={tr('Area')}>{areaName(event.area, areaIndex) || '—'}</td>
                        <td data-label={tr('Lifecycle')}><span className={`adm-outcome adm-life-${event.lifecycle}`}>{tr(event.lifecycle)}</span></td>
                        <td data-label={tr('Data')}><DataStatus status={event.dataStatus ?? 'FRESH'} /></td>
                        <td data-label={tr('Delivery')}><Delivery delivery={{ total: event.delivery.total, read: event.delivery.read }} /></td>
                        <td data-label={tr('Valid until')}>{bdDateTime(event.validUntil)}</td>
                        <td className="adm-cell-action">
                          {event.lifecycle === 'active' && (
                            <button type="button" className="adm-btn adm-btn-small" onClick={() => setTarget({ id: event.id, label: `${hazardLabel(event.hazardType, options)} · ${event.area || '—'}` })}>{tr('Withdraw')}</button>
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
