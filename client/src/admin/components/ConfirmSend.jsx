import { useState } from 'react';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import {
  CONFIRM_TYPED, confirmationReady, recipientBreakdown,
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
  const { options } = useAdmin();
  const [state, setState] = useState({ typed: '', critical: false });
  const { preview, needs } = flow;
  const breakdown = recipientBreakdown(preview, options);
  const ready = confirmationReady(needs, state) && flow.usable && !flow.sending;
  const people = needs.recipients;
  const label = needs.critical
    ? `Send CRITICAL alert to ${people} ${people === 1 ? 'person' : 'people'}`
    : needs.recipients > 0 ? `Send to ${people} ${people === 1 ? 'person' : 'people'}` : 'Send update';

  return (
    <Modal
      title={needs.critical ? 'Send a CRITICAL alert?' : 'Send these alerts now?'}
      tone={needs.critical ? 'critical' : 'default'}
      busy={flow.sending}
      onClose={flow.closeConfirm}
      footer={(
        <>
          <button type="button" className="adm-btn" onClick={flow.closeConfirm} disabled={flow.sending} data-autofocus>Cancel</button>
          <button
            type="button"
            className={`adm-btn ${needs.critical ? 'adm-btn-critical' : 'adm-btn-primary'}`}
            disabled={!ready}
            onClick={() => flow.send(state)}
          >
            {flow.sending ? 'Sending…' : label}
          </button>
        </>
      )}
    >
      <SenderLabel />
      <p className="adm-confirm-mode">{MODE_TEXT[mode]}</p>

      <div className="adm-confirm-count">
        <strong>{people}</strong>
        <span>{people === 1 ? 'person' : 'people'} will receive a new or released alert</span>
      </div>

      <div className="adm-breakdown">
        <div>
          <h3>By role</h3>
          <ul>{breakdown.byRole.map((item) => <li key={item.key}><span>{item.label}</span><b>{item.count}</b></li>)}</ul>
        </div>
        <div>
          <h3>By area</h3>
          <ul>{breakdown.byArea.map((item) => <li key={item.key}><span>{item.label}</span><b>{item.count}</b></li>)}</ul>
        </div>
      </div>
      {people === 0 && needs.updatesExisting && <p className="adm-hint">Nobody new will be notified: this updates the active declaration.</p>}

      {needs.typed && (
        <div className="adm-confirm-block">
          <p><strong>The cached weather data does not support this declaration.</strong> Type <code>{CONFIRM_TYPED}</code> to send it anyway.</p>
          <input
            type="text"
            value={state.typed}
            onChange={(event) => setState((s) => ({ ...s, typed: event.target.value }))}
            aria-label={`Type ${CONFIRM_TYPED} to confirm`}
            autoComplete="off"
            spellCheck="false"
            disabled={flow.sending}
          />
        </div>
      )}

      {needs.critical && (
        <div className="adm-confirm-block adm-confirm-critical">
          <p><SeverityChip severity="CRITICAL" /> <strong>This sends a CRITICAL alert to {people} {people === 1 ? 'person' : 'people'}.</strong> It tells them to take protective action now.</p>
          <label className="adm-check">
            <input type="checkbox" checked={state.critical} disabled={flow.sending} onChange={(event) => setState((s) => ({ ...s, critical: event.target.checked }))} />
            <span>I confirm: send this CRITICAL alert to {people} {people === 1 ? 'person' : 'people'}.</span>
          </label>
        </div>
      )}

      {flow.expired && <p className="adm-note adm-note-warning">The preview has expired. Close this window and preview again.</p>}
      <ErrorNote>{flow.sendError}</ErrorNote>
    </Modal>
  );
}
