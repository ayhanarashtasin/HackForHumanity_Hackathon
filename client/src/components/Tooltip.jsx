import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeIndicator, tooltipPosition } from '../lib/mapIndicators.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';

export function Tooltip({ hover, context, onDismiss }) {
  const { lang, tr } = useLanguage(MAP);
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const card = useMemo(() => hover ? describeIndicator(hover.picked, { ...context, lang }) : null, [hover, context, lang]);
  const also = useMemo(() => [...new Set((hover?.also ?? []).map(picked => describeIndicator(picked, { ...context, lang })?.title).filter(title => title && title !== card?.title))].slice(0, 3), [hover, context, lang, card]);

  useLayoutEffect(() => {
    if (!ref.current || !card) return;
    const element = ref.current;
    const place = () => {
      const bounds = element.parentElement.getBoundingClientRect();
      element.style.maxHeight = `${Math.max(40, bounds.height - 16)}px`;
      const next = tooltipPosition(hover, element.getBoundingClientRect(), bounds);
      setPosition(current => current.left === next.left && current.top === next.top ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element.parentElement);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hover, card]);

  useLayoutEffect(() => {
    if (!hover?.pinned || !ref.current) return;
    const previous = document.activeElement;
    const element = ref.current;
    element.focus({ preventScroll: true });
    return () => {
      if (element.contains(document.activeElement) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [hover?.pinned]);

  if (!hover || !card) return null;

  return (
    <div ref={ref} id="map-indicator-tooltip" className={`map-inspection${hover.pinned ? ' is-pinned' : ''}`} style={position}
      role={hover.pinned ? 'dialog' : 'tooltip'} aria-label={card.title} tabIndex={hover.pinned ? -1 : undefined}
      onMouseLeave={() => { if (!hover.pinned) onDismiss(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); } }}>
      <header>
        <span className="inspection-swatch" style={{ background: card.color }} aria-hidden="true" />
        <div><small>{card.eyebrow}</small><strong>{card.title}</strong></div>
        {hover.pinned && <button type="button" className="icon-button" onClick={onDismiss} aria-label={tr('Close indicator details')}><Icon name="close" size={17} /></button>}
      </header>
      <dl>{card.rows.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="inspection-note">{card.note}</p>
      {hover.pinned && card.detail && <p className="inspection-note">{card.detail}</p>}
      {also.length > 0 && <p className="inspection-also">{tr('Also here: {items}', { items: also.join(' · ') })}</p>}
      {!hover.pinned && <small className="inspection-hint">{tr('Click or tap to keep these details open.')}</small>}
    </div>
  );
}
