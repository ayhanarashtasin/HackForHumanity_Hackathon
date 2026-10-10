import { useCallback, useState } from 'react';
import {
  canSend, confirmPayload, confirmationNeeds, describeError, isPreviewExpired, newIdempotencyKey, sameParameters, sendBody,
} from '../../lib/adminForm.js';
import { adminApi } from '../../services/adminApi.js';
import { useAdmin } from '../AdminContext.jsx';

const INITIAL = {
  preview: null,
  previewBody: null,
  previewing: false,
  previewError: null,
  confirmOpen: false,
  key: null,
  sending: false,
  sendError: null,
  expired: false,
  result: null,
};

// The preview -> confirm -> send state machine shared by the three send tabs.
//   * A preview belongs to exactly the parameters it was made for: change the form and it is stale (Send stays off until previewed again).
//   * The idempotency key is made when the confirmation opens and reused for every retry of that same click.
//   * Errors never touch the form, only this state.
export function useSendFlow({ mode, currentBody }) {
  const { guard } = useAdmin();
  const [state, setState] = useState(INITIAL);

  const stale = Boolean(state.preview) && !sameParameters(state.previewBody, currentBody);
  const usable = Boolean(state.preview) && !stale && !state.expired;
  const needs = state.preview ? confirmationNeeds(state.preview) : null;
  const sendable = usable && canSend(needs);

  // `override` lets a per-role button preview a body the form has not caught up with yet; `confirm` then opens the confirmation.
  const run = useCallback(async (override, { confirm = false } = {}) => {
    const body = override ?? currentBody;
    setState((s) => ({ ...s, previewing: true, previewError: null, sendError: null, result: null, expired: false, confirmOpen: false, key: null }));
    try {
      const preview = await guard(adminApi.preview(body));
      const open = confirm && canSend(confirmationNeeds(preview));
      setState((s) => ({ ...s, previewing: false, preview, previewBody: body, confirmOpen: open, key: open ? newIdempotencyKey() : null }));
    } catch (error) {
      setState((s) => ({ ...s, previewing: false, previewError: describeError(error) }));
    }
  }, [currentBody, guard]);

  const openConfirm = useCallback(() => {
    setState((s) => ({ ...s, confirmOpen: true, key: newIdempotencyKey(), sendError: null }));
  }, []);

  const closeConfirm = useCallback(() => {
    setState((s) => (s.sending ? s : { ...s, confirmOpen: false, key: null, sendError: null }));
  }, []);

  const send = useCallback(async (confirmState) => {
    if (!state.preview || !state.key) return;
    const request = sendBody(state.previewBody, state.preview, state.key, confirmPayload(confirmationNeeds(state.preview), confirmState));
    setState((s) => ({ ...s, sending: true, sendError: null }));
    try {
      const response = await guard(adminApi.send(request));
      // The preview is used up by a successful send; the form is left exactly as it was.
      setState({ ...INITIAL, result: response });
    } catch (error) {
      setState((s) => ({ ...s, sending: false, sendError: describeError(error), expired: isPreviewExpired(error) }));
    }
  }, [guard, state.key, state.preview, state.previewBody]);

  const dismissResult = useCallback(() => setState((s) => ({ ...s, result: null })), []);

  return {
    mode, ...state, stale, usable, sendable, needs, run, openConfirm, closeConfirm, send, dismissResult,
  };
}
