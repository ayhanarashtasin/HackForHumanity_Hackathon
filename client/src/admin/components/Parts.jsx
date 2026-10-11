import { Icon } from '../../components/Icon.jsx';
import { errorText, useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';

// Small shared pieces: a card, a section heading, an error note, a labelled field, a switch and the sender label.
export function Card({ title, action, children, tone = 'default', id }) {
  const { tr } = useLanguage(ADMIN);
  return (
    <section className={`adm-card adm-card-${tone}`} aria-labelledby={id}>
      {(title || action) && (
        <header className="adm-card-head">
          {title && <h2 id={id}>{tr(title)}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ children, onRetry }) {
  const { tr, lang } = useLanguage(ADMIN);
  if (!children) return null;
  return (
    <div className="adm-note adm-note-error" role="alert">
      <Icon name="warning" size={18} />
      <p>{typeof children === 'string' ? errorText(children, lang, ADMIN) : children}</p>
      {onRetry && <button type="button" className="adm-btn adm-btn-small" onClick={onRetry}>{tr('Try again')}</button>}
    </div>
  );
}

export function Notice({ children, tone = 'info', icon = 'info' }) {
  const { tr } = useLanguage(ADMIN);
  return (
    <div className={`adm-note adm-note-${tone}`} role={tone === 'critical' ? 'alert' : 'note'}>
      <Icon name={icon} size={18} />
      <div>{typeof children === 'string' ? tr(children) : children}</div>
    </div>
  );
}

export function Field({ label, hint, error, htmlFor, children, counter }) {
  const { tr } = useLanguage(ADMIN);
  return (
    <div className={`adm-field${error ? ' has-error' : ''}`}>
      <div className="adm-field-label">
        <label htmlFor={htmlFor}>{tr(label)}</label>
        {counter}
      </div>
      {children}
      {hint && <p className="adm-hint">{tr(hint)}</p>}
      {error && <p className="adm-field-error" role="alert">{tr(error)}</p>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled = false, describedBy }) {
  const { tr } = useLanguage(ADMIN);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={tr(label)}
      aria-describedby={describedBy}
      className={`adm-switch${checked ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="adm-switch-knob" />
    </button>
  );
}

// Every send surface says who is speaking.
export function SenderLabel() {
  const { tr } = useLanguage(ADMIN);
  return (
    <p className="adm-sender">
      <Icon name="shield" size={16} />
      <span>{tr('Sent as: Administrator (not BMD)')}</span>
    </p>
  );
}

export function Loading({ children = 'Loading…' }) {
  const { tr } = useLanguage(ADMIN);
  return <p className="adm-loading" role="status">{tr(children)}</p>;
}
