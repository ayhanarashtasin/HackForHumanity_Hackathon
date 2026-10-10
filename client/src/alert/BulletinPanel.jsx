import { DataStatus } from '../components/DataStatus.jsx';
import { pick } from '../lib/alertForm.js';
import { useAlert } from './context.js';
import { digits, formatDhaka, referenceHref } from './format.js';

export function BulletinPanel({ bulletins, error }) {
  const { lang, tr } = useAlert();
  return (
    <section className="alert-panel" aria-labelledby="alert-bulletins-title">
      <h2 id="alert-bulletins-title">{tr('bulletins.title')}</h2>
      <p className="alert-help">{tr('bulletins.lead')}</p>
      {error && <p className="alert-note" role="status">{tr('cov.loadError')}</p>}
      {!bulletins && !error && <p role="status">{tr('cov.loading')}</p>}
      {bulletins && <ul className="alert-coverage">
        {bulletins.map((bulletin) => {
          const href = referenceHref(bulletin.documentUrl);
          return <li key={bulletin.key}>
            <div className="alert-coverage-head"><strong>{pick(bulletin.label, lang)}</strong><DataStatus status={bulletin.status} lang={lang} /></div>
            <p className="alert-coverage-meta">{bulletin.issuedDate ? tr('bulletins.dated', { date: digits(bulletin.issuedDate, lang) }) : tr('bulletins.noDate')}</p>
            <p className="alert-coverage-meta">{bulletin.checkedAt ? tr('cov.checked', { time: formatDhaka(bulletin.checkedAt, lang) }) : tr('cov.never')}</p>
            <p className="alert-coverage-meaning">{tr(bulletin.parserStatus === 'parsed' ? 'bulletins.parsed' : 'bulletins.linkOnly')}</p>
            {bulletin.key === 'fleet-forecast' && <p className="alert-coverage-meaning">{tr('bulletins.fleet')}</p>}
            {bulletin.validUntil && <p className="alert-coverage-meta">{tr('card.valid', { time: formatDhaka(bulletin.validUntil, lang) })}{bulletin.validityAssumed ? ` · ${tr('bulletins.assumed')}` : ''}</p>}
            {href ? <a className="alert-link-button" href={href} target="_blank" rel="noopener noreferrer">{tr('bulletins.open')}</a> : <p className="alert-muted">{tr('bulletins.noDocument')}</p>}
          </li>;
        })}
      </ul>}
    </section>
  );
}
