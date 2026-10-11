import { describeResult, roleLabel } from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { ConfirmSend } from './ConfirmSend.jsx';
import { ErrorNote, Notice, SenderLabel } from './Parts.jsx';
import { PreviewPanel } from './PreviewPanel.jsx';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';

function ResultPanel({ mode, flow, onOpenHistory }) {
  const { tr } = useLanguage(ADMIN);
  const response = flow.result;
  if (!response) return null;
  const batch = response.result?.batchId;
  return (
    <Notice tone="info" icon="check">
      <p><strong>{tr(response.replayed ? 'This send had already been made.' : 'Sent.')}</strong> {describeResult(mode, response)}</p>
      {response.replayed && <p>{tr('Nothing was sent again: the same click was recognised.')}</p>}
      {batch && <p className="adm-muted">{tr('Batch {id}. You can withdraw it from History; a withdrawal is never an all-clear.', { id: batch })}</p>}
      <p className="adm-result-actions">
        {onOpenHistory && <button type="button" className="adm-btn adm-btn-small" onClick={onOpenHistory}>{tr('Open History')}</button>}
        <button type="button" className="adm-btn adm-btn-small" onClick={flow.dismissResult}>{tr('Dismiss')}</button>
      </p>
    </Notice>
  );
}

// Everything a send tab has in common: the form slot, the Preview button, the preview, the Send buttons, the confirmation and the result.
export function SendSurface({
  mode, flow, problems, previewLabel = 'Preview', children, roleButtons = null, onOpenHistory,
}) {
  const { tr } = useLanguage(ADMIN);
  const { options } = useAdmin();
  const roles = roleButtons?.roles ?? [];

  return (
    <div className="adm-send">
      <form className="adm-form" onSubmit={(event) => { event.preventDefault(); if (!problems.length && !flow.previewing) flow.run(); }}>
        {children}
        <SenderLabel />
        <ErrorNote>{flow.previewError}</ErrorNote>
        <div className="adm-actions">
          <button type="submit" className="adm-btn adm-btn-primary" disabled={problems.length > 0 || flow.previewing}>
            {tr(flow.previewing ? 'Checking…' : previewLabel)}
          </button>
          <span className="adm-muted adm-actions-note">{tr('Nothing is sent by this button.')}</span>
        </div>
        {problems.length > 0 && (
          <ul className="adm-problems" aria-label={tr('What is needed before you can preview')}>
            {problems.map((problem) => <li key={`${problem.field}-${problem.message}`}>{problem.message}</li>)}
          </ul>
        )}
      </form>

      <ResultPanel mode={mode} flow={flow} onOpenHistory={onOpenHistory} />

      {flow.preview && (
        <>
          <PreviewPanel mode={mode} preview={flow.preview} stale={flow.stale} expired={flow.expired} />
          <div className="adm-send-bar">
            <button type="button" className="adm-btn adm-btn-primary" disabled={!flow.sendable} onClick={flow.openConfirm}>
              {tr(roleButtons?.sendLabel ?? 'Send these now')}
            </button>
            {roles.map((role) => (
              <button type="button" key={role} className="adm-btn" disabled={flow.previewing} onClick={() => roleButtons.onRole(role)}>
                {tr('Send only {role} alerts', { role: roleLabel(options, role) })}
              </button>
            ))}
            {!flow.sendable && flow.usable && <span className="adm-muted">{tr('Nothing new to send.')}</span>}
          </div>
        </>
      )}

      {flow.confirmOpen && flow.preview && <ConfirmSend flow={flow} mode={mode} />}
    </div>
  );
}
