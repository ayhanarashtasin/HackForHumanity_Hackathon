import { DataStatus, STATUS_MEANING } from '../components/DataStatus.jsx';
import { useAlert } from './context.js';
import { ageText, formatDhaka } from './format.js';

// "What we checked": for every hazard that matters to this person, which source decided it, how fresh it is, and what that status
// does NOT mean. An unavailable, stale or partial source is shown as such, never as calm.
export function CoveragePanel({ rows, error }) {
  const { tr, lang } = useAlert();

  return (
    <section className="alert-panel" aria-labelledby="alert-coverage-title">
      <h2 id="alert-coverage-title">{tr('cov.title')}</h2>
      <p className="alert-help">{tr('cov.lead')}</p>

      {error && !rows && <p className="alert-note" role="status">{tr('cov.loadError')}</p>}
      {!error && !rows && <p className="alert-muted" role="status">{tr('cov.loading')}</p>}

      {rows && (
        <ul className="alert-coverage">
          {rows.map((row) => (
            <li key={row.hazard}>
              <div className="alert-coverage-head">
                <strong>{tr(`hazard.${row.hazard}`)}</strong>
                <DataStatus status={row.status} lang={lang} title={false} />
              </div>
              <p className="alert-coverage-meta">
                {row.checkedAt ? tr('cov.checked', { time: `${formatDhaka(row.checkedAt, lang)} (${ageText(row.checkedAt, lang)})` }) : tr('cov.never')}
                {row.provider ? ` · ${tr('cov.provider', { name: tr(`provider.${row.provider}`) })}` : ''}
              </p>
              <p className="alert-coverage-meaning">{STATUS_MEANING[row.status]?.[lang]}</p>
              {row.note && <p className="alert-coverage-meaning">{tr(`note.${row.note}`)}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
