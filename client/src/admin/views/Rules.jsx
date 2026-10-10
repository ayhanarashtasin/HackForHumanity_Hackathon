import { BASIS_LEGEND } from '../../lib/adminForm.js';
import { adminApi } from '../../services/adminApi.js';
import { useAdminResource } from '../hooks/useAdminData.js';
import {
  Card, ErrorNote, Loading, Notice,
} from '../components/Parts.jsx';

// The thresholds the engine uses, read-only. Changing one means changing config/alertRules.js (versioned), never this screen.
export function Rules() {
  const { data, error, loading, reload } = useAdminResource((signal) => adminApi.rules(signal));

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>Rules</h1>
        {data && <span className="adm-badge-prototype" title="Prototype rules are not expert-validated">{data.status} · {data.version}</span>}
      </header>

      <Notice tone="warning" icon="warning">
        <strong>Prototype rules:</strong> set from published references, not yet reviewed by BMD, the Department of Agricultural Extension, an occupational-health reviewer or disaster-management staff. Every alert carries this label. Nothing here is “validated” until a reviewer and a date are recorded.
      </Notice>
      <ErrorNote onRetry={reload}>{error}</ErrorNote>
      {loading && !data && <Loading />}

      {data && (
        <>
          <Card title="Thresholds" id="rules-thresholds">
            <div className="adm-table-wrap">
              <table className="adm-table adm-table-stack">
                <thead><tr><th>Id</th><th>Hazard</th><th>Level</th><th>Rule</th><th>Basis</th><th>Version</th><th>Status</th></tr></thead>
                <tbody>
                  {data.thresholds.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Id"><code>{row.id}</code></td>
                      <td data-label="Hazard">{row.hazard}</td>
                      <td data-label="Level">{row.level ?? '—'}</td>
                      <td data-label="Rule" className="adm-rule-text">{row.rule}</td>
                      <td data-label="Basis">
                        <span className="adm-basis">{row.basis.map((tag) => <abbr key={tag} title={BASIS_LEGEND[tag]}>{tag}</abbr>)}</span>
                      </td>
                      <td data-label="Version">{row.version}</td>
                      <td data-label="Status"><span className={`adm-badge-${row.status}`}>{row.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="adm-legend" aria-label="Basis legend">
              {Object.entries(BASIS_LEGEND).map(([tag, text]) => <div key={tag}><dt><abbr title={text}>{tag}</abbr></dt><dd>{text}</dd></div>)}
            </dl>
          </Card>

          <Card title="Scenarios (catalogue rule ids)" id="rules-scenarios">
            <ul className="adm-chips adm-chips-static">
              {data.scenarios.map((scenario) => <li key={scenario.id}><code>{scenario.id}</code><small>{scenario.status}</small></li>)}
            </ul>
            <p className="adm-hint">WORK-02 and WORK-05 are added to WORK-01 as extra sentences, and FISH-05 flags an old status inside FISH-02 and FISH-04, so a person never receives three messages for one heat event.</p>
          </Card>
        </>
      )}
    </div>
  );
}
