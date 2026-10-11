import { useEffect, useRef } from 'react';
import { LIGHTNING_COLORS } from '../map/WeatherMap.js';
import { formatBst, formatClock, formatDay, hourOf, toMs } from '../lib/time.js';
import { Icon } from './Icon.jsx';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import './lightning-panel.css';

const STATE_LABEL = {
  reported: 'Lightning reported',
  none: 'No records in window',
  stale: 'Stale sample',
  unavailable: 'Data unavailable',
  'not-checked': 'Not checked yet',
};
const CAMPAIGN_STATE = {
  active: 'Campaign active',
  'not-started': 'Awaiting first refresh',
  ended: 'Campaign completed',
  disabled: 'Collection paused',
};
const SCHEDULE = ['07:00', '15:00', '23:00'];
const validTime = (iso) => iso && Number.isFinite(toMs(iso));
const when = (iso) => validTime(iso) ? formatBst(toMs(iso)) : 'Not available';

function StateRing({ state }) {
  return <span className={`ring ring-${state}`} style={{ borderColor: LIGHTNING_COLORS[state] }} aria-hidden="true" />;
}

function RefreshTime({ label, iso, empty, upcoming }) {
  const { tr, lang } = useLanguage(MAP);
  return (
    <div className={`lightning-refresh${upcoming ? ' is-upcoming' : ''}`}>
      <dt><Icon name={upcoming ? 'arrow' : 'clock'} size={15} />{tr(label)}</dt>
      <dd>
        {validTime(iso) ? <><time dateTime={iso} title={when(iso)}>{formatClock(toMs(iso))}</time><small>{formatDay(toMs(iso))} · {lang === 'bn' ? tr('Bangladesh time') : 'BST'}</small></> : <span className="lightning-time-empty">{tr(empty)}</span>}
      </dd>
    </div>
  );
}

function SelectedSummary({ selected, onClear }) {
  const { tr, lang, number: digits, name } = useLanguage(MAP);
  const detail = selected.detail ? tr(selected.detail) : null;
  const number = (value) => Number.isFinite(value) ? digits(value) : '–';
  return (
    <section className={`lightning-selected state-${selected.state}`} aria-label={tr('Selected lightning summary')}>
      <header>
        <div><p className="map-eyebrow">{tr('Selected on the map')}</p><h3>{selected.kind === 'circle' ? tr('Circle {id}', { id: selected.id }) : name(selected) ?? selected.id}</h3><small>{tr('{n} km search radius', { n: selected.radiusKm })}</small></div>
        <button type="button" className="icon-button" onClick={onClear} aria-label={tr('Clear lightning selection')} title={tr('Clear selection')}><Icon name="close" size={17} /></button>
      </header>
      <p className="lightning-selected-state" role="status"><StateRing state={selected.state} />{tr(STATE_LABEL[selected.state] ?? 'Unknown state')}</p>
      <div className="lightning-event-count"><strong>{number(selected.count)}</strong><span>{tr(selected.state === 'stale' ? 'last recorded events' : 'recorded events')}<small>{tr('In this circle’s sampled window')}</small></span></div>
      {(Number.isFinite(selected.cloudToGround) || Number.isFinite(selected.intracloud)) && (
        <dl className="lightning-breakdown">
          <div><dt>{tr('Cloud-to-ground')}</dt><dd>{number(selected.cloudToGround)}</dd></div>
          <div><dt>{tr('Intracloud')}</dt><dd>{number(selected.intracloud)}</dd></div>
        </dl>
      )}
      <dl className="lightning-sample-times">
        {selected.window && <div><dt>{tr('Sample window')}</dt><dd>{tr(when(selected.window.from))}<span>{tr('to {time}', { time: tr(when(selected.window.to)) })}</span></dd></div>}
        <div><dt>{tr('Sampled at')}</dt><dd>{tr(when(selected.sampledAt))}</dd></div>
      </dl>
      {detail && <p className="lightning-selected-detail">{lang === 'bn' && detail === selected.detail ? tr('A source or collection warning was recorded. Check the sample time and data status; these records are not live monitoring.') : detail}</p>}
    </section>
  );
}

export function LightningPanel({ status, summaries, selectedId, onClear, onClose, statusError, summariesError, onRetry }) {
  const { tr, lang, number: digits } = useLanguage(MAP);
  const number = (value) => Number.isFinite(value) ? digits(value) : '–';
  const contentRef = useRef(null);
  const selected = selectedId ? summaries?.items?.find((item) => item.id === selectedId) : null;
  const campaign = status?.campaign;
  const budget = status?.budget;
  const regional = status?.mode === 'B';
  const states = Object.keys(STATE_LABEL).filter((state) => state !== 'not-checked' || summaries?.items?.some((item) => item.state === state));
  const schedule = campaign?.slotTimes?.length ? campaign.slotTimes : SCHEDULE;
  const nextTime = status?.state === 'active' && validTime(campaign?.nextSlotAt)
    ? `${String(hourOf(toMs(campaign.nextSlotAt))).padStart(2, '0')}:00` : null;

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [selectedId]);

  const clearSelection = () => {
    onClear();
    contentRef.current?.focus({ preventScroll: true });
  };

  return (
    <aside className="lightning-panel panel" aria-label={tr('Lightning summaries')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    }}>
      <header className="lightning-header">
        <span className="lightning-heading-icon"><Icon name="bolt" size={21} /></span>
        <div><p className="map-eyebrow">{tr('Observation snapshots')}</p><h2>{tr('Lightning summaries')}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={tr('Hide lightning panel')}><Icon name="close" size={18} /></button>
      </header>

      <div className="lightning-content" ref={contentRef} tabIndex={0} role="region" aria-label={tr('Lightning summary details')}>
        {!status ? (
          <div className="lightning-empty" role="status">
            {statusError ? <Icon name="cloud" size={30} /> : <span className="map-spinner" aria-hidden="true" />}
            <h3>{tr(statusError ? 'Lightning status unavailable' : 'Loading lightning summaries…')}</h3>
            <p>{tr(statusError ? 'The last collection status could not be loaded. Please try again.' : 'Checking coverage and the latest collection times.')}</p>
            {statusError && onRetry && <button type="button" className="map-secondary-button" onClick={onRetry}>{tr('Try again')}</button>}
          </div>
        ) : (
          <>
            <section className="lightning-overview" aria-label={tr('Lightning collection overview')}>
              <div className="lightning-campaign-row"><span className={`lightning-campaign-state campaign-${status.state}`}><span aria-hidden="true" />{tr(CAMPAIGN_STATE[status.state] ?? 'Collection status unknown')}</span><span className="lightning-mode">{tr('Mode {mode}', { mode: status.mode ?? '–' })}</span></div>
              <p className="lightning-coverage"><strong>{number(budget?.locationCount)}</strong><span>{tr(regional ? 'regional search circles' : 'upazila search locations')}<small>{tr(status.modeLabel ?? 'Coverage information')}</small></span></p>
              {status.reason && <p className="lightning-collection-reason">{lang === 'bn' && status.reasonBn ? digits(status.reasonBn) : tr(status.reason)}</p>}
            </section>

            <p className="lightning-snapshot-note"><Icon name="clock" size={17} /><span><strong>{tr('5-minute snapshots')}</strong> · {tr('not live monitoring.')}<small>{tr('Counts cover search circles, not upazila boundaries.')}</small></span></p>
            {(statusError || summariesError) && <p className="lightning-load-note" role="status">{tr(summaries ? 'The latest refresh could not be loaded. Saved information is shown.' : 'Summary records could not be loaded. Map states are unknown.')}{onRetry && <button type="button" onClick={onRetry}>{tr('Try again')}</button>}</p>}

            {selected && <SelectedSummary selected={selected} onClear={clearSelection} />}

            <section className="lightning-schedule" aria-labelledby="lightning-refresh-heading">
              <h3 id="lightning-refresh-heading">{tr('Refresh schedule')} <span>{tr('Bangladesh time')}</span></h3>
              <dl className="lightning-refresh-grid">
                <RefreshTime label="Latest refresh" iso={campaign?.lastRefreshAt} empty="Not refreshed yet" />
                <RefreshTime label="Next refresh" iso={status.state === 'active' ? campaign?.nextSlotAt : null} upcoming empty={status.state === 'ended' ? 'No more scheduled' : status.state === 'disabled' ? 'Collection paused' : 'Awaiting schedule'} />
              </dl>
              <div className="lightning-slot-times" aria-label={tr('Daily refresh times')}>
                {schedule.map((time) => <span key={time} className={nextTime === time ? 'next-slot' : ''}>{digits(time)}{nextTime === time && <small>{tr('Next')}</small>}</span>)}
              </div>
              {campaign && Number.isFinite(campaign.maxSlots) && campaign.maxSlots > 0 && (
                <div className="lightning-campaign-progress"><div><span>{tr('Campaign progress')}</span><strong>{number(campaign.slotsCompleted)} / {number(campaign.maxSlots)} {tr('refreshes')}</strong></div><progress value={Math.min(campaign.slotsCompleted ?? 0, campaign.maxSlots)} max={campaign.maxSlots} aria-label={tr('Campaign refresh slots completed')} /></div>
              )}
            </section>

            <section className="lightning-map-key" aria-labelledby="lightning-state-heading">
              <h3 id="lightning-state-heading">{tr('Map states')} <span>{tr(summaries?.items?.length ? 'Search locations, not event totals' : 'Awaiting sample records')}</span></h3>
              <ul aria-label={tr('Lightning map states')}>
                {states.map((state) => (
                  <li key={state}><StateRing state={state} /><span>{tr(STATE_LABEL[state])}</span><strong aria-label={summaries?.items?.length ? tr('{n} search locations', { n: summaries.items.filter((item) => item.state === state).length }) : tr('Count not available')}>{summaries?.items?.length ? number(summaries.items.filter((item) => item.state === state).length) : '–'}</strong></li>
                ))}
              </ul>
              {!selected && <p className="lightning-map-hint"><Icon name="radar" size={16} /> {tr(regional ? 'Select a circle on the map for its sampled counts.' : 'Select a search location on the map for its sampled counts.')}</p>}
            </section>

            <details className="lightning-disclosure">
              <summary><span><Icon name="radar" size={17} /> {tr('How to read these snapshots')}</span><Icon name="chevron" size={16} /></summary>
              <ul className="lightning-explanations">{(status.limitations ?? []).map((text) => <li key={text}>{tr(text)}</li>)}</ul>
            </details>

            <details className="lightning-disclosure">
              <summary><span><Icon name="chart" size={17} /> {tr('Collection & API budget')}</span><Icon name="chevron" size={16} /></summary>
              <dl className="lightning-budget-grid">
                <div><dt>{tr('Accesses remaining')}</dt><dd>{number(budget?.remaining)}</dd></div>
                <div><dt>{tr('Projected campaign cost')}</dt><dd>{number(budget?.projectedCampaignCost)}</dd></div>
                <div><dt>{tr('Access reserve')}</dt><dd>{number(budget?.reserve)}</dd></div>
                <div><dt>{tr('Used by campaign')}</dt><dd>{number(budget?.usedByCampaign)}</dd></div>
              </dl>
              <p className="lightning-budget-mode"><strong>{tr('Collection mode')}</strong>{tr(status.modeLabel ?? 'Not available')}</p>
               {status.modeReason && <p className="lightning-mode-reason">{lang === 'bn' ? (status.modeReasonBn ? digits(status.modeReasonBn) : tr(status.mode === 'A' ? 'Mode A collects summaries around individual upazila locations.' : 'Mode B uses regional circles to keep collection within the API allowance.')) : status.modeReason}</p>}
              {campaign && (campaign.slotsMissed > 0 || campaign.slotsSkipped > 0) && <p className="lightning-mode-reason">{tr('Missed refreshes: {missed} · Budget-skipped: {skipped}', { missed: campaign.slotsMissed, skipped: campaign.slotsSkipped })}</p>}
            </details>
          </>
        )}
      </div>
    </aside>
  );
}
