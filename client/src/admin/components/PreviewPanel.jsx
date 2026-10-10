import { Fragment, useState } from 'react';
import { DataStatus } from '../../components/DataStatus.jsx';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import { OfficialNotice } from '../../components/OfficialNotice.jsx';
import {
  bdDateTime, hazardLabel, reasonText, roleLabel, summarisePreview,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { Notice } from './Parts.jsx';

// The server's dry run, shown the way the plan describes it: new / already sent / held / nothing detected.
function SampleMessage({ lang, content }) {
  if (!content) return null;
  return (
    <article className="adm-sample" lang={lang}>
      <p className="adm-sample-lang">{lang === 'en' ? 'English' : 'বাংলা (Bangla)'}</p>
      <h4>{content.title}</h4>
      <p>{content.message}</p>
      <OfficialNotice notice={content.evidence?.official} lang={lang} validityAssumed={content.evidence?.validityAssumed} />
      <p className="adm-muted">{content.affectedArea?.text} · {lang === 'bn' ? 'মেয়াদ' : 'Valid'} {bdDateTime(content.validFrom)} – {bdDateTime(content.validUntil)}</p>
      <p className="adm-muted">{content.sourceReferences?.map((source) => [source.provider, source.product, source.observedAt || source.forecastIssuedAt ? bdDateTime(source.observedAt ?? source.forecastIssuedAt) : null].filter(Boolean).join(' · ')).join('; ')}</p>
      {content.recommendedActions?.length > 0 && (
        <ul>{content.recommendedActions.map((action) => <li key={action.key}>{action.text}</li>)}</ul>
      )}
      <p className="adm-sample-why"><strong>{lang === 'en' ? 'Why you receive this:' : 'কেন পেয়েছেন:'}</strong> {content.reasonForSelection}</p>
    </article>
  );
}

function GroupTable({ rows, kind }) {
  const { options } = useAdmin();
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="adm-table-wrap">
      <table className="adm-table adm-table-stack">
        <thead>
          <tr><th>Role</th><th>Rule</th><th>Hazard</th><th>Severity</th><th>Area</th><th className="num">People</th><th>Data</th><th><span className="sr-only">Message</span></th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = `${kind}-${row.occupation}-${row.scenarioId}-${row.event?.id ?? ''}-${row.affectedArea?.upazilaPcode ?? row.affectedArea?.name}`;
            const expanded = open.has(key);
            return (
              <Fragment key={key}>
                <tr>
                  <td data-label="Role">{roleLabel(options, row.occupation)}</td>
                  <td data-label="Rule"><code>{row.scenarioId}</code></td>
                  <td data-label="Hazard">{row.scenarioId === 'ADMIN-MSG' ? 'Message' : `${hazardLabel(row.hazardType, options)} · level ${row.level}`}</td>
                  <td data-label="Severity"><SeverityChip severity={row.severity} size="sm" /></td>
                  <td data-label="Area">{row.affectedArea?.name ?? '—'}</td>
                  <td data-label="People" className="num">{row.count}</td>
                  <td data-label="Data"><DataStatus status={row.dataStatus ?? 'FRESH'} /></td>
                  <td className="adm-cell-action">
                    {row.sample && (
                      <button type="button" className="adm-btn adm-btn-small" aria-expanded={expanded} onClick={() => toggle(key)}>
                        {expanded ? 'Hide message' : 'Preview message'}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded && row.sample && (
                  <tr className="adm-sample-row">
                    <td colSpan={8}>
                      <div className="adm-samples">
                        <SampleMessage lang="en" content={row.sample.en} />
                        <SampleMessage lang="bn" content={row.sample.bn} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupSection({ title, rows, empty, kind, tone = 'default' }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <section className={`adm-group adm-group-${tone}`} aria-label={title}>
      <h4>{title} <span className="adm-count">{total}</span></h4>
      {rows.length ? <GroupTable rows={rows} kind={kind} /> : <p className="adm-hint">{empty}</p>}
    </section>
  );
}

function NothingDetected({ rows }) {
  const { options } = useAdmin();
  return (
    <section className="adm-group" aria-label="Nothing detected">
      <h4>Nothing detected <span className="adm-count">{rows.length}</span></h4>
      {rows.length === 0 && <p className="adm-hint">Every chosen role has something new or already sent above.</p>}
      <ul className="adm-nothing">
        {rows.map((row) => (
          <li key={row.role}>
            <div>
              <strong>{roleLabel(options, row.role)}</strong>
              <span className="adm-muted"> · {row.subscribers} subscriber{row.subscribers === 1 ? '' : 's'} in scope</span>
            </div>
            <p>{reasonText(row.reason)}</p>
            <ul className="adm-source-list" aria-label={`Sources checked for ${roleLabel(options, row.role)}`}>
              {(row.sources ?? []).map((source) => (
                <li key={source.key}>
                  <span>{source.label}</span>
                  <DataStatus status={source.status} />
                  <small className="adm-muted">{source.checkedAt ? `checked ${bdDateTime(source.checkedAt)}` : 'not checked'}</small>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SUPPORT = {
  yes: { text: 'Supported: current weather data shows this hazard at this level or higher.', tone: 'info' },
  partly: { text: 'Partly supported: current data shows the hazard, but below the declared level.', tone: 'warning' },
  no: { text: 'Not supported: the cached weather data does not show this hazard for the chosen areas.', tone: 'warning' },
  unknown: { text: 'Unknown: the cached data cannot confirm or contradict this declaration.', tone: 'info' },
};

const SUPPORT_REASONS = {
  'no-forecast-check': 'Lightning and marine declarations are not checked against forecast data.',
  'too-many-areas': 'Too many areas (or all of Bangladesh) to check one by one.',
  'data-unavailable': 'The forecast data for these areas is stale or unavailable.',
};

function SupportCheck({ support }) {
  if (!support) return null;
  const info = SUPPORT[support.supported] ?? SUPPORT.unknown;
  return (
    <Notice tone={info.tone} icon={support.supported === 'no' || support.supported === 'partly' ? 'warning' : 'info'}>
      <p><strong>Does current data support this declaration?</strong> {info.text}</p>
      {support.reason && <p className="adm-muted">{SUPPORT_REASONS[support.reason] ?? support.reason}</p>}
      {support.checked > 0 && <p className="adm-muted">Checked {support.checked} area{support.checked === 1 ? '' : 's'}{support.rows?.length ? ': ' : '.'}{support.rows?.map((row) => `${row.name} level ${row.level}`).join(', ')}</p>}
    </Notice>
  );
}

export function PreviewPanel({ mode, preview, stale, expired }) {
  const summary = summarisePreview(preview);
  const outdated = stale || expired;

  return (
    <section className={`adm-preview${outdated ? ' is-stale' : ''}`} aria-label="Preview of this send" aria-live="polite">
      <header className="adm-preview-head">
        <h3>Preview</h3>
        <span className="adm-muted">Checked {bdDateTime(preview.generatedAt)}</span>
      </header>

      {outdated && (
        <Notice tone="warning" icon="warning">
          {expired
            ? 'This preview has expired or no longer matches. Preview again before sending.'
            : 'You changed the form after this preview. Preview again before sending.'}
        </Notice>
      )}

      {mode === 'declare' && (
        <Notice tone="info" icon="shield">
          <p><strong>Declared by administrator, not detected from weather data.</strong> Each role receives its own wording from the catalogue rules.</p>
          {preview.updatesExisting && <p>A declaration of this hazard for these areas is already active, so sending <strong>updates it</strong> instead of creating a second one.</p>}
          {preview.validUntil && <p className="adm-muted">Valid until {bdDateTime(preview.validUntil)}.</p>}
        </Notice>
      )}
      {mode === 'declare' && <SupportCheck support={preview.support} />}

      {preview.warnings?.length > 0 && (
        <Notice tone="warning" icon="warning">
          <ul className="adm-plain-list">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </Notice>
      )}

      <dl className="adm-totals">
        <div><dt>New recipients</dt><dd>{summary.totals.newRecipients}</dd></div>
        <div><dt>Released from hold</dt><dd>{summary.totals.released}</dd></div>
        <div><dt>Already sent</dt><dd>{summary.totals.alreadySent}</dd></div>
      </dl>

      <GroupSection title="New: will be sent now" rows={summary.fresh} empty="Nothing new to send." kind="new" tone="new" />
      <GroupSection title="Already sent: no duplicate will be created" rows={summary.already} empty="Nothing has been sent for this yet." kind="already" />
      {(summary.held.length > 0 || mode === 'weather') && (
        <GroupSection title="Held: released by Send" rows={summary.held} empty="No alerts are being held." kind="held" />
      )}
      {mode === 'weather' && <NothingDetected rows={summary.nothing} />}
    </section>
  );
}
