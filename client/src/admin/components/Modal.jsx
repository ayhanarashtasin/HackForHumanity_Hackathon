import { useEffect, useRef } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// An accessible dialog: focus moves in, Tab stays inside, Escape closes (unless `busy`), and focus returns to where it came from.
export function Modal({ title, onClose, busy = false, tone = 'default', wide = false, children, footer }) {
  const { tr } = useLanguage(ADMIN);
  const panel = useRef(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    const previous = document.activeElement;
    const first = panel.current?.querySelector('[data-autofocus]') ?? panel.current?.querySelector(FOCUSABLE) ?? panel.current;
    first?.focus();
    document.body.classList.add('adm-modal-open');
    return () => {
      document.body.classList.remove('adm-modal-open');
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !busy) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...panel.current.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="adm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div
        ref={panel}
        className={`adm-modal adm-modal-${tone}${wide ? ' adm-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="adm-modal-head">
          <h2 id={titleId}>{tr(title)}</h2>
          <button type="button" className="adm-icon-btn" aria-label={tr('Close')} onClick={onClose} disabled={busy}><Icon name="close" size={20} /></button>
        </header>
        <div className="adm-modal-body">{children}</div>
        {footer && <footer className="adm-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
