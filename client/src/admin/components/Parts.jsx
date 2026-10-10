import { Icon } from '../../components/Icon.jsx';

// Small shared pieces: a card, a section heading, an error note, a labelled field, a switch and the sender label.
export function Card({ title, action, children, tone = 'default', id }) {
  return (
    <section className={`adm-card adm-card-${tone}`} aria-labelledby={id}>
      {(title || action) && (
        <header className="adm-card-head">
          {title && <h2 id={id}>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ children, onRetry }) {
  if (!children) return null;
  return (
    <div className="adm-note adm-note-error" role="alert">
      <Icon name="warning" size={18} />
      <p>{children}</p>
      {onRetry && <button type="button" className="adm-btn adm-btn-small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Notice({ children, tone = 'info', icon = 'info' }) {
  return (
    <div className={`adm-note adm-note-${tone}`} role={tone === 'critical' ? 'alert' : 'note'}>
      <Icon name={icon} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Field({ label, hint, error, htmlFor, children, counter }) {
  return (
    <div className={`adm-field${error ? ' has-error' : ''}`}>
      <div className="adm-field-label">
        <label htmlFor={htmlFor}>{label}</label>
        {counter}
      </div>
      {children}
      {hint && <p className="adm-hint">{hint}</p>}
      {error && <p className="adm-field-error" role="alert">{error}</p>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled = false, describedBy }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
  return (
    <p className="adm-sender">
      <Icon name="shield" size={16} />
      <span>Sent as: <strong>Administrator (not BMD)</strong></span>
    </p>
  );
}

export function Loading({ children = 'Loading…' }) {
  return <p className="adm-loading" role="status">{children}</p>;
}
