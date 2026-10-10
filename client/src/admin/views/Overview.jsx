import { DataStatus } from '../../components/DataStatus.jsx';
import { Icon } from '../../components/Icon.jsx';
import { SeverityChip } from '../../components/SeverityChip.jsx';
import { usePolled } from '../../hooks/usePolled.js';
import {
  SEVERITIES, ageLabel, automaticMatrix, bdDateTime, formatNumber, heldStatus, roleLabel,
} from '../../lib/adminForm.js';
import { adminApi } from '../../services/adminApi.js';
import { useAdmin } from '../AdminContext.jsx';
import {
  Card, ErrorNote, Loading, Notice,
} from '../components/Parts.jsx';

const POLL_MS = 30_000;

const CLASS_NAMES = {
  lightning_probe: 'Lightning probes (1 token each)',
  forecast: 'Forecast (1)',
  maritime: 'Maritime (1)',
  lightning_threats: 'Lightning threats (10)',
  lightning_strikes: 'Lightning strikes (10)',
};

const STAT_NAMES = {
  areas: 'Monitored areas', eventsCreated: 'Events created', eventsUpdated: 'Events updated', eventsSuperseded: 'Events superseded', blocked: 'Blocked by stale data',
  activeEvents: 'Active events', recipients: 'Recipients evaluated', notificationsCreated: 'Notifications created', notificationsUpdated: 'Notifications updated',
  held: 'Held', skippedCap: 'Skipped by daily cap',
};

function Bars({ entries, empty }) {
  const max = Math.max(1, ...entries.map((entry) => entry.count));
  if (!entries.length) return <p className="adm-hint">{empty}</p>;
  return (
    <ul className="adm-bars">
      {entries.map((entry) => (
        <li key={entry.key}>
          <span className="adm-bar-label">{entry.label}</span>
          <span className="adm-bar" aria-hidden="true"><span style={{ inlineSize: `${(entry.count / max) * 100}%` }} /></span>
          <b>{entry.count}</b>
        </li>
      ))}
    </ul>
  );
}

function HeldBanner({ held }) {
  const status = heldStatus(held);
  if (!status.total) return null;
  const overdue = status.criticalOverdue;
  return (
    <section className={`adm-card ${overdue ? 'adm-card-critical' : 'adm-card-warning'}`} role={overdue ? 'alert' : 'status'} aria-labelledby="held-title">
      <header className="adm-card-head">
        <h2 id="held-title">{status.total} alert{status.total === 1 ? '' : 's'} held for the administrator</h2>
        {Object.keys(held.bySeverity ?? {}).map((severity) => <SeverityChip key={severity} severity={severity} size="sm" />)}
      </header>
      <p>
        {overdue
          ? <><strong>A CRITICAL alert has been waiting for you for {ageLabel(status.criticalMinutes)}.</strong> It is not reaching subscribers until you send it. </>
          : null}
        {status.oldestMinutes !== null && <>The oldest held alert has waited {ageLabel(status.oldestMinutes)}. </>}
        Send held alerts from <strong>Send alerts → Send now from weather</strong>, or discard them in Settings. Turning a hold off affects future alerts.
      </p>
    </section>
  );
}

function Budget({ budget }) {
  const classes = Object.keys(CLASS_NAMES);
  return (
    <Card title="Xweather allowance" id="ov-budget">
      <dl className="adm-kv">
        <div><dt>Remaining this period</dt><dd>{formatNumber(budget.remaining)} <small className="adm-muted">({budget.remainingSource})</small></dd></div>
        <div><dt>Reserve kept back</dt><dd>{formatNumber(budget.reserve)}</dd></div>
        <div><dt>Lightning campaign still needs</dt><dd>{formatNumber(budget.campaignOutstanding)}</dd></div>
        <div><dt>Usable by alerts</dt><dd><strong>{formatNumber(budget.usable)}</strong></dd></div>
        <div><dt>Days until reset</dt><dd>{budget.daysLeft} <small className="adm-muted">({bdDateTime(budget.resetAt)})</small></dd></div>
        <div><dt>Daily average to stay within</dt><dd>{formatNumber(budget.perDay)} per day</dd></div>
        <div><dt>Spent today</dt><dd>{formatNumber(budget.spentToday?.total ?? 0)}</dd></div>
        <div><dt>Spent recently</dt><dd>{formatNumber(budget.spentRecent?.total ?? 0)}</dd></div>
      </dl>
      <table className="adm-table adm-table-compact">
        <thead><tr><th>Request</th><th className="num">Today</th><th className="num">Recent</th></tr></thead>
        <tbody>
          {classes.map((name) => (
            <tr key={name}><td>{CLASS_NAMES[name]}</td><td className="num">{formatNumber(budget.spentToday?.[name] ?? 0)}</td><td className="num">{formatNumber(budget.spentRecent?.[name] ?? 0)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="adm-hint">
        The allowance is shared with the lightning campaign, and strike and threat requests cost 10 tokens each. <em>Usable</em> is what remains after the reserve and what the campaign still needs; the governor lets alerts spend about the daily average (up to 1.5 times on a stormy day) and refuses anything that would dip into the reserve. Last reading from Xweather: {budget.lastKnownAt ? bdDateTime(budget.lastKnownAt) : 'none yet'}.
      </p>
    </Card>
  );
}

function Engine({ engine }) {
  const stats = engine.lastStats ? Object.entries(STAT_NAMES).filter(([key]) => engine.lastStats[key] !== undefined) : [];
  return (
    <Card title="Engine health" id="ov-engine">
      <dl className="adm-kv">
        <div><dt>Automatic sending</dt><dd>{engine.enabled ? 'On' : 'Switched off (ALERT_ENGINE=off)'}</dd></div>
        <div><dt>Last completed</dt><dd>{engine.lastCompletedAt ? bdDateTime(engine.lastCompletedAt) : 'Not run yet'}</dd></div>
        <div><dt>Last status</dt><dd>{engine.lastStatus ?? '—'}</dd></div>
      </dl>
      {engine.lastError && <ErrorNote>{`Last error: ${engine.lastError}`}</ErrorNote>}
      {stats.length > 0 && (
        <dl className="adm-stats" aria-label="Last engine pass">
          {stats.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{engine.lastStats[key]}</dd></div>)}
        </dl>
      )}
    </Card>
  );
}

function Sources({ sources }) {
  return (
    <Card title="Sources" id="ov-sources">
      <div className="adm-table-wrap">
        <table className="adm-table adm-table-stack">
          <thead><tr><th>Source</th><th>Status</th><th>Last checked</th><th>Cadence</th><th>Note</th></tr></thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.key}>
                <td data-label="Source">{source.label}</td>
                <td data-label="Status"><DataStatus status={source.status} /></td>
                <td data-label="Last checked">{source.checkedAt ? bdDateTime(source.checkedAt) : 'Never'}</td>
                <td data-label="Cadence">every {source.cadenceMinutes} min</td>
                <td data-label="Note">{source.note === 'not-configured' ? 'Xweather is not configured or is switched off' : (source.error ?? '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="adm-hint">Grey means no data or old data. It is never shown as calm.</p>
    </Card>
  );
}

const CHANNEL_NAMES = { telegram: 'Telegram', whatsapp: 'WhatsApp', sms: 'SMS' };
const SENDS = { ADVISORY: 'All alerts', WARNING: 'Warning and Critical', CRITICAL: 'Critical only' };

// Why a message was not sent, in words an administrator can act on.
const REASONS = {
  no_longer_active: 'The alert ended or was withdrawn before it could be sent',
  superseded: 'A newer stage of the same alert replaced it',
  subscriber_paused: 'The profile was paused',
  subscriber_inactive: 'The profile expired',
  channel_unlinked: 'The person disconnected the channel',
  channel_blocked: 'The chat blocked the bot, or the number cannot be reached',
  channel_unavailable: 'The channel is not configured on the server',
  daily_cap: 'The daily message limit for that person was reached',
  expired_in_quiet_hours: 'The alert ended while the person’s quiet hours were on',
  unreadable_number: 'The stored number cannot be read (CHANNEL_SECRET changed)',
  chat_moved: 'The Telegram chat was connected to a newer profile',
  stopped_in_chat: 'The person sent /stop in the chat',
  removed_by_user: 'The person disconnected the channel',
  retry: 'Gave up after repeated temporary failures',
  permanent: 'The provider rejected the message',
  blocked: 'The recipient cannot receive messages from the app',
  auth: 'The provider rejected our credentials',
  config: 'A message template or setting is wrong',
};

function Delivery({ delivery }) {
  const rows = Object.entries(delivery.channels);
  const anyReasons = rows.some(([, channel]) => channel.last24h.reasons.length);

  return (
    <Card title="Telegram, WhatsApp and SMS" id="ov-delivery">
      {!delivery.enabled && <Notice tone="warning" icon="warning">External delivery is switched off (DELIVERY=off). Alerts reach the in-app inbox only.</Notice>}
      <div className="adm-table-wrap">
        <table className="adm-table adm-table-stack">
          <thead>
            <tr><th>Channel</th><th>Status</th><th className="num">Connected profiles</th><th>Carries</th><th className="num">Sent, 24 h</th><th className="num">Waiting</th><th className="num">Failed</th><th className="num">Not sent</th></tr>
          </thead>
          <tbody>
            {rows.map(([key, channel]) => (
              <tr key={key}>
                <td data-label="Channel">{CHANNEL_NAMES[key]}</td>
                <td data-label="Status">{channel.available ? 'Ready' : (channel.configured ? 'Needs CHANNEL_SECRET or a verification template' : 'Not set up')}</td>
                <td data-label="Connected profiles" className="num">{channel.linkedProfiles}</td>
                <td data-label="Carries">{SENDS[delivery.minSeverity[key]] ?? '—'}</td>
                <td data-label="Sent, 24 h" className="num">{channel.last24h.sent}</td>
                <td data-label="Waiting" className="num">{channel.last24h.pending + channel.last24h.sending}</td>
                <td data-label="Failed" className="num">{channel.last24h.failed}</td>
                <td data-label="Not sent" className="num">{channel.last24h.skipped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {anyReasons && (
        <>
          <h3>Why messages were not sent, last 24 hours</h3>
          <ul className="adm-plain-list">
            {rows.flatMap(([key, channel]) => channel.last24h.reasons.map((item) => (
              <li key={`${key}-${item.reason}`}><b>{item.count}</b> {CHANNEL_NAMES[key]}: {REASONS[item.reason] ?? item.reason}</li>
            )))}
          </ul>
        </>
      )}
      <p className="adm-hint">
        Last delivery pass: {delivery.lastCompletedAt ? bdDateTime(delivery.lastCompletedAt) : 'not run yet'}. Counts only: the app never lists who is connected. Critical alerts are never held by quiet hours or the daily limit.
      </p>
    </Card>
  );
}

export function Overview() {
  const { guard, options } = useAdmin();
  const { data, error, loading, reload } = usePolled((signal) => guard(adminApi.overview(signal)), POLL_MS);

  return (
    <div className="adm-view">
      <header className="adm-view-head">
        <h1>Overview</h1>
        <div className="adm-view-tools">
          {data && <span className="adm-badge-prototype" title="Prototype rules are not expert-validated">{data.rules.status} rules · {data.rules.version}</span>}
          <span className="adm-muted">{data ? `Updated ${bdDateTime(data.generatedAt)}` : ''}</span>
          <button type="button" className="adm-btn" onClick={reload}><Icon name="refresh" size={16} /> Refresh</button>
        </div>
      </header>

      <ErrorNote onRetry={reload}>{error}</ErrorNote>
      {loading && !data && <Loading />}

      {data && (
        <>
          <HeldBanner held={data.held} />
          {!data.engine.enabled && <Notice tone="warning" icon="warning">Automatic alerts are switched off on the server (ALERT_ENGINE=off). Only the administrator tools send alerts.</Notice>}

          <div className="adm-grid">
            <Card title="Subscribers" id="ov-subscribers">
              <dl className="adm-stats">
                <div><dt>Total</dt><dd>{data.subscribers.total}</dd></div>
                <div><dt>Active</dt><dd>{data.subscribers.active}</dd></div>
                <div><dt>Demo</dt><dd>{data.subscribers.demo}</dd></div>
                <div><dt>Paused</dt><dd>{data.subscribers.paused}</dd></div>
                <div><dt>Monitored areas</dt><dd>{data.monitoring.areas}</dd></div>
              </dl>
              <h3>By role</h3>
              <Bars entries={Object.entries(data.subscribers.byRole).map(([role, count]) => ({ key: role, label: roleLabel(options, role), count })).sort((a, b) => b.count - a.count)} empty="No subscribers yet." />
              <h3>By division (home area)</h3>
              <Bars entries={Object.entries(data.subscribers.byDivision).map(([name, count]) => ({ key: name, label: name, count })).sort((a, b) => b.count - a.count)} empty="No subscribers yet." />
              <p className="adm-hint">Counts only: this view never lists names, phone numbers or e-mail addresses.</p>
            </Card>

            <Engine engine={data.engine} />
          </div>

          <Sources sources={data.sources} />

          <Delivery delivery={data.delivery} />

          <div className="adm-grid">
            <Budget budget={data.budget} />

            <div className="adm-stack">
              <Card title="Sent automatically, last 24 hours" id="ov-auto">
                {data.automatic24h.length === 0 ? <p className="adm-hint">The engine has not sent anything in the last 24 hours.</p> : (
                  <table className="adm-table adm-table-compact">
                    <thead><tr><th>Role</th>{SEVERITIES.map((severity) => <th key={severity} className="num"><SeverityChip severity={severity} size="sm" /></th>)}</tr></thead>
                    <tbody>
                      {automaticMatrix(data.automatic24h, options).map((row) => (
                        <tr key={row.role}><td>{row.label}</td>{SEVERITIES.map((severity) => <td key={severity} className="num">{row[severity] || '·'}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>

              <Card title="Lightning episodes, last 24 hours" id="ov-lightning">
                <dl className="adm-stats">
                  <div><dt>Episodes</dt><dd>{data.lightning24h.episodes}</dd></div>
                  <div><dt>Notifications</dt><dd>{data.lightning24h.notifications}</dd></div>
                  <div><dt>Per episode</dt><dd>{data.lightning24h.perEpisode}</dd></div>
                </dl>
                <p className="adm-hint">Lightning is always CRITICAL. To avoid alarm fatigue each subscriber gets one card per episode and at most two re-notifications. “Per episode” counts every subscriber’s card, so it rises with the number of people in the affected areas.</p>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
