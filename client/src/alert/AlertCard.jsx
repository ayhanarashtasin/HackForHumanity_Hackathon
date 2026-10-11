import { useId, useState } from 'react';
import { DataStatus } from '../components/DataStatus.jsx';
import { Icon } from '../components/Icon.jsx';
import { Link } from '../components/Link.jsx';
import { OfficialNotice } from '../components/OfficialNotice.jsx';
import { SeverityChip } from '../components/SeverityChip.jsx';
import { mapHref } from '../lib/alertForm.js';
import { useAlert } from './context.js';
import { evidenceRows, formatDhaka, number, referenceHref } from './format.js';
import { translate } from '../i18n/index.js';

// One personal alert, with everything the plan requires on it: affected area, hazard and severity, source and time, validity,
// why this person received it, and what to do. Details (evidence, rule, history) are one click away.
function sourceLine(item, tr, lang) {
  const ref = item.sourceReferences?.[0];
  if (!ref) return null;
  const name = item.evidence?.official ? tr('card.sender.official') : tr(`provider.${ref.provider}`);
  const time = ref.observedAt ? tr('card.observed', { time: formatDhaka(ref.observedAt, lang) })
    : ref.forecastIssuedAt ? tr(item.evidence?.official ? 'card.referenceTime' : 'card.forecast', { time: formatDhaka(ref.forecastIssuedAt, lang) }) : null;
  return [name, time].filter(Boolean).join(' · ');
}

function LifecycleNote({ note, lang }) {
  if (!note) return null;
  // Translate system wording only; a withdrawal reason is the administrator's original text.
  const separator = note.indexOf(' Reason: ');
  const text = separator < 0 ? note : note.slice(0, separator);
  const reason = separator < 0 ? null : note.slice(separator + 9);
  const localized = translate(lang, text);
  return (
    <span lang={/[\u0980-\u09ff]/u.test(localized) ? 'bn' : 'en'}>
      {localized}{reason && <> {translate(lang, 'Reason:')} <bdi lang={/[\u0980-\u09ff]/u.test(reason) ? 'bn' : 'en'}>{reason}</bdi></>}
    </span>
  );
}

export function AlertCard({ item, onRead }) {
  const { tr, lang, index } = useAlert();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const unread = !item.readAt;
  const ended = item.status === 'expired' || item.status === 'withdrawn';
  const critical = item.severity === 'CRITICAL' && !ended;
  const sender = item.sender === 'official' ? tr('card.sender.official') : item.sender === 'administrator' ? tr('card.sender.administrator')
    : tr(item.ruleStatus === 'validated' ? 'card.sender.automaticValidated' : 'card.sender.automatic');
  const source = sourceLine(item, tr, lang);
  const reference = item.origin === 'admin-message' ? referenceHref(item.sourceReferences?.[0]?.url) : null;
  const href = mapHref(item.affectedArea, index);
  const metrics = evidenceRows(item.evidence, tr, lang);
  const startsLater = Date.parse(item.validFrom) > Date.now();

  const toggle = () => {
    setOpen((value) => !value);
    if (!open && unread) onRead(item.id);
  };

  return (
    <article
      className={`alert-card${critical ? ' alert-card--critical' : ''}${unread ? ' is-unread' : ''}${ended ? ' is-ended' : ''}`}
      role={critical ? 'alert' : undefined}
      aria-labelledby={`${detailsId}-title`}
    >
      <header className="alert-card-head">
        <SeverityChip severity={item.severity} lang={lang} />
        <span className="alert-tag">{tr(`hazard.${item.hazardType}`)}</span>
        {unread && <span className="alert-tag alert-tag--new">{tr('card.new')}</span>}
        <span className="alert-tag alert-tag--sender">{sender}</span>
        {item.dataStatus !== 'FRESH' && <DataStatus status={item.dataStatus} lang={lang} />}
      </header>

      <h3 id={`${detailsId}-title`} lang={item.lang}>{item.title}</h3>
      <p className="alert-card-meta">
        <span lang={item.lang}><Icon name="pin" size={16} />{item.affectedArea?.text}</span>
        <span><Icon name="clock" size={16} />
          {startsLater ? `${tr('card.from', { time: formatDhaka(item.validFrom, lang) })} · ` : ''}
          {tr('card.valid', { time: formatDhaka(item.validUntil, lang) })}
        </span>
      </p>

      {ended && <p className="alert-note alert-note--ended">{tr(item.status === 'withdrawn' ? 'card.withdrawn' : 'card.ended')}</p>}
      {item.evidence?.scopeUncertain && <p className="alert-note">{tr('card.scopeUncertain')}</p>}

      <p className="alert-card-message" lang={item.lang}>{item.message}</p>
      <OfficialNotice notice={item.evidence?.official} lang={lang} validityAssumed={item.evidence?.validityAssumed} />

      <section className="alert-card-why">
        <h4>{tr('card.why')}</h4>
        <p lang={item.lang}>{item.reasonForSelection}</p>
      </section>

      {item.recommendedActions?.length > 0 && (
        <section className="alert-card-do">
          <h4>{tr('card.do')}</h4>
          <ul lang={item.lang}>{item.recommendedActions.map((action) => <li key={action.key}><Icon name="check" size={16} />{action.text}</li>)}</ul>
        </section>
      )}

      <footer className="alert-card-foot">
        {source && <p className="alert-card-source"><strong>{tr('card.source')}:</strong> {source}</p>}
        <div className="alert-card-buttons">
          <button type="button" className="alert-link-button" aria-expanded={open} aria-controls={detailsId} onClick={toggle}>
            {open ? tr('card.hide') : tr('card.details')}
          </button>
          {href && <Link to={href} className="alert-link-button">{tr('card.map')}<Icon name="arrow" size={14} /></Link>}
          {reference && <a href={reference} className="alert-link-button" target="_blank" rel="noopener noreferrer">{tr('card.reference')}</a>}
          {unread && <button type="button" className="alert-link-button" onClick={() => onRead(item.id)}>{tr('card.markRead')}</button>}
        </div>
      </footer>

      {open && (
        <div className="alert-card-details" id={detailsId}>
          <dl className="alert-dl">
            <div><dt>{tr('card.area')}</dt><dd lang={item.lang}>{item.affectedArea?.text}</dd></div>
            <div><dt>{tr('card.data')}</dt><dd><DataStatus status={item.dataStatus} lang={lang} /></dd></div>
            {item.hazardLevel > 0 && <div><dt>{tr('card.level')}</dt><dd>{number(item.hazardLevel, lang)} / {number(3, lang)}</dd></div>}
            {metrics.map((row) => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
            {item.evidence?.agreement && <div><dt>{tr('card.agreement')}</dt><dd>{tr(`agreement.${item.evidence.agreement}`)}</dd></div>}
            {item.evidence?.coverage && <div><dt>{tr('card.coverage')}</dt><dd>{tr(`coverage.${item.evidence.coverage}`)}</dd></div>}
            {item.relatedRules?.length > 0 && <div><dt>{tr('card.related')}</dt><dd>{item.relatedRules.join(', ')}</dd></div>}
          </dl>
          <p className="alert-card-rule">{tr('card.rule')} <code>{item.scenarioId}</code> · {tr('card.version')} <code>{item.ruleVersion}</code></p>
          {item.ruleStatus === 'prototype' && <p className="alert-note">{tr('card.prototype')}</p>}
          {item.lifecycle?.length > 0 && (
            <>
              <h4>{tr('card.history')}</h4>
              <ul className="alert-history">
                {item.lifecycle.map((entry, i) => (
                  <li key={`${entry.at}-${i}`}>
                    <strong>{tr(`lifecycle.${entry.type}`)}</strong> · {formatDhaka(entry.at, lang)}
                    <LifecycleNote note={entry.note} lang={lang} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </article>
  );
}
