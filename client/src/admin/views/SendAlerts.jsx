import { useRef, useState } from 'react';
import { DeclareTab } from './DeclareTab.jsx';
import { MessageTab } from './MessageTab.jsx';
import { WeatherTab } from './WeatherTab.jsx';

const TABS = [
  { id: 'weather', label: 'Send now from weather', Panel: WeatherTab },
  { id: 'declare', label: 'Declare a hazard', Panel: DeclareTab },
  { id: 'message', label: 'Free message', Panel: MessageTab },
];

// Three tabs, each with its own form and preview state. Panels stay mounted so a half-written message is not lost when switching tabs.
export function SendAlerts({ onOpenHistory }) {
  const [active, setActive] = useState('weather');
  const refs = useRef({});

  const onKeyDown = (event) => {
    const at = TABS.findIndex((tab) => tab.id === active);
    let next = null;
    if (event.key === 'ArrowRight') next = TABS[(at + 1) % TABS.length];
    if (event.key === 'ArrowLeft') next = TABS[(at - 1 + TABS.length) % TABS.length];
    if (event.key === 'Home') next = TABS[0];
    if (event.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    setActive(next.id);
    refs.current[next.id]?.focus();
  };

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>Send alerts</h1>
        <p className="adm-muted">The engine sends automatically when a threshold is met. These tools send on demand, as the administrator.</p>
      </header>

      <div className="adm-tabs" role="tablist" aria-label="Kind of send" onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(node) => { refs.current[tab.id] = node; }}
            type="button"
            role="tab"
            id={`send-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`send-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            className={`adm-tab${active === tab.id ? ' is-active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {TABS.map(({ id, Panel }) => (
        <div key={id} role="tabpanel" id={`send-panel-${id}`} aria-labelledby={`send-tab-${id}`} hidden={active !== id} className="adm-tabpanel">
          <Panel onOpenHistory={onOpenHistory} />
        </div>
      ))}
    </div>
  );
}
