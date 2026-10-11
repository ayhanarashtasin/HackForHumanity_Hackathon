import { useState } from 'react';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import {
  confirmationReady, recipientBreakdown,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { ErrorNote, SenderLabel } from './Parts.jsx';
import { Modal } from './Modal.jsx';

const MODE_TEXT = {
  weather: 'Alerts built from the current cached weather, one message per role.',
  declare: 'Declared by administrator, not detected from weather data.',
  message: 'Your own message, sent exactly as written.',
};

// The last step before anything reaches people: who, how many, as whom, and the extra confirmations the server will demand.
export function ConfirmSend({ flow, mode }) {
  const { tr, number } = useLanguage(ADMIN);
  const { options, areaIndex } = useAdmin();
  const [state, setState] = useState({ typed: '', critical: false });
  const { preview, needs } = flow;
  const breakdown = recipientBreakdown(preview, options, areaIndex);
  const ready = confirmationReady(needs, state) && flow.usable && !flow.sending;
  const people = needs.recipients;
  const label = needs.critical
    ? tr('Send CRITICAL alert to {n} people', { n: people })
    : needs.recipients > 0 ? tr('Send to {n} people', { n: people }) : tr('Send update');

  return (
    <Modal
      title={tr(needs.critical ? 'Send a CRITICAL alert?' : 'Send these alerts now?')}
      tone={needs.critical ? 'critical' : 'default'}
      busy={flow.sending}
      onClose={flow.closeConfirm}
      footer={(
        <>
          <button type="button" className="adm-btn" onClick={flow.closeConfirm} disabled={flow.sending} data-autofocus>{tr('Cancel')}</button>
          <button
            type="button"
            className={`adm-btn ${needs.critical ? 'adm-btn-critical' : 'adm-btn-primary'}`}
            disabled={!ready}
            onClick={() => flow.send(state)}
          >
            {flow.sending ? tr('Sending…') : label}
          </button>
        </>
      )}
    >
      <SenderLabel />
      <p className="adm-confirm-mode">{tr(MODE_TEXT[mode])}</p>

      <div className="adm-confirm-count">
        <strong>{number(people)}</strong>
        <span>{tr('people will receive a new or released alert')}</span>
      </div>

      <div className="adm-breakdown">
        <div>
          <h3>{tr('By role')}</h3>
          <ul>{breakdown.byRole.map((item) => <li key={item.key}><span>{item.label}</span><b>{number(item.count)}</b></li>)}</ul>
        </div>
        <div>
          <h3>{tr('By area')}</h3>
          <ul>{breakdown.byArea.map((item) => <li key={item.key}><span>{item.label}</span><b>{number(item.count)}</b></li>)}</ul>
        </div>
      </div>
      {people === 0 && needs.updatesExisting && <p className="adm-hint">{tr('Nobody new will be notified: this updates the active declaration.')}</p>}

      {needs.typed && (
        <div className="adm-confirm-block">
          <p><strong>{tr('The cached weather data does not support this declaration. Type SEND to send it anyway.')}</strong></p>
          <input
            type="text"
            value={state.typed}
            onChange={(event) => setState((s) => ({ ...s, typed: event.target.value }))}
            aria-label={tr('Type SEND to confirm')}
            autoComplete="off"
            spellCheck="false"
            disabled={flow.sending}
          />
        </div>
      )}

      {needs.critical && (
        <div className="adm-confirm-block adm-confirm-critical">
          <p><SeverityChip severity="CRITICAL" /> <strong>{tr('This sends a CRITICAL alert to {n} people. It tells them to take protective action now.', { n: people })}</strong></p>
          <label className="adm-check">
            <input type="checkbox" checked={state.critical} disabled={flow.sending} onChange={(event) => setState((s) => ({ ...s, critical: event.target.checked }))} />
            <span>{tr('I confirm: send this CRITICAL alert to {n} people.', { n: people })}</span>
          </label>
        </div>
      )}

      {flow.expired && <p className="adm-note adm-note-warning">{tr('The preview has expired. Close this window and preview again.')}</p>}
      <ErrorNote>{flow.sendError}</ErrorNote>
    </Modal>
  );
}
