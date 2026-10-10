import { useEffect, useRef } from 'react';

// A modal question built on the native <dialog>: the browser traps focus inside it and Escape closes it.
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel, busy = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog ref={ref} className="alert-dialog" aria-labelledby="alert-dialog-title" aria-describedby="alert-dialog-body" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <h2 id="alert-dialog-title">{title}</h2>
      <p id="alert-dialog-body">{body}</p>
      <div className="alert-actions">
        <button type="button" className="alert-button alert-button--ghost" onClick={onCancel} autoFocus>{cancelLabel}</button>
        <button type="button" className="alert-button alert-button--danger" onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
