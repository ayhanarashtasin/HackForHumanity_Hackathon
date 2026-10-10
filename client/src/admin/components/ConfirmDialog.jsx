import { useState } from 'react';
import { describeError } from '../../lib/adminForm.js';
import { ErrorNote } from './Parts.jsx';
import { Modal } from './Modal.jsx';

// A small "are you sure?" dialog for settings changes and deletions. `onConfirm` may reject; its message is shown and the dialog stays open.
export function ConfirmDialog({
  title, children, confirmLabel = 'Confirm', tone = 'default', onConfirm, onClose,
}) {
  const [state, setState] = useState({ busy: false, error: null });

  const confirm = async () => {
    setState({ busy: true, error: null });
    try {
      await onConfirm();
    } catch (error) {
      setState({ busy: false, error: describeError(error) });
    }
  };

  return (
    <Modal
      title={title}
      tone={tone}
      busy={state.busy}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="adm-btn" onClick={onClose} disabled={state.busy} data-autofocus>Cancel</button>
          <button type="button" className={`adm-btn ${tone === 'critical' ? 'adm-btn-critical' : 'adm-btn-primary'}`} onClick={confirm} disabled={state.busy}>
            {state.busy ? 'Working…' : confirmLabel}
          </button>
        </>
      )}
    >
      {children}
      <ErrorNote>{state.error}</ErrorNote>
    </Modal>
  );
}
