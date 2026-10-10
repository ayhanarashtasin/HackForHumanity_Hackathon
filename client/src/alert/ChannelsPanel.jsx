import { useCallback, useEffect, useId, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import {
  channelErrorKey, codeFormProblem, phoneFormProblem, receivesKey,
} from '../lib/channelForm.js';
import { alertApi } from '../services/alertApi.js';
import { useAlert } from './context.js';
import { digits, formatDhaka } from './format.js';

// Telegram, WhatsApp and SMS: optional copies of the inbox. The inbox itself never depends on any of this.
// Telegram is connected from a one-time link (no number); WhatsApp and SMS ask for a Bangladeshi number, a consent tick and a code.
const WAIT_POLL_MS = 4000;
const WAIT_LIMIT_MS = 15 * 60_000; // the link's own lifetime

function useChannels() {
  const [overview, setOverview] = useState(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      setOverview(await alertApi.channels(signal));
      setFailed(false);
    } catch (problem) {
      if (problem.name !== 'AbortError') setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return {
    overview, failed, reload: load, replace: setOverview,
  };
}

function Row({ name, state, children }) {
  const { tr } = useAlert();
  return (
    <li className="alert-channel" data-state={state}>
      <div className="alert-channel-head">
        <h3 className="alert-channel-name">{name}</h3>
        {state === 'connected' && <span className="alert-channel-badge"><Icon name="check" size={14} />{tr('ch.connected')}</span>}
      </div>
      {children}
    </li>
  );
}

function Receives({ minSeverity }) {
  const { tr } = useAlert();
  return <p className="alert-help">{tr('ch.receives', { what: tr(receivesKey(minSeverity)) })}</p>;
}

function TelegramRow({ info, onChange, onReload }) {
  const { tr, lang } = useAlert();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');

  // While the person is in Telegram, look for the connection every few seconds, and stop when it arrives or the link has expired.
  useEffect(() => {
    if (!link) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > WAIT_LIMIT_MS) setLink(null);
      else onReload();
    }, WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [link, onReload]);

  useEffect(() => {
    if (info.linked) setLink(null);
  }, [info.linked]);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      setLink(await alertApi.linkTelegram());
    } catch (problem) {
      setError(tr(channelErrorKey(problem)));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      onChange(await alertApi.removeChannel('telegram'));
    } catch (problem) {
      setError(tr(channelErrorKey(problem)));
    } finally {
      setBusy(false);
    }
  };

  const state = info.linked ? 'connected' : (info.available ? 'available' : 'unavailable');
  return (
    <Row name={tr('channel.telegram')} state={state}>
      {!info.available && <p className="alert-muted">{tr('ch.unavailable')}</p>}

      {info.available && info.linked && (
        <>
          <p className="alert-help">{info.linkedAt ? tr('ch.connectedOn', { time: formatDhaka(info.linkedAt, lang) }) : tr('ch.connected')}</p>
          <Receives minSeverity={info.minSeverity} />
          <button type="button" className="alert-button alert-button--ghost" onClick={disconnect} disabled={busy}>{busy ? tr('ch.working') : tr('ch.disconnect')}</button>
        </>
      )}

      {info.available && !info.linked && !link && (
        <button type="button" className="alert-button alert-button--primary" onClick={connect} disabled={busy}>
          {busy ? tr('ch.working') : tr('ch.connect', { channel: tr('channel.telegram') })}
        </button>
      )}

      {info.available && !info.linked && link && (
        <div className="alert-channel-flow">
          <a className="alert-button alert-button--primary" href={link.url} target="_blank" rel="noopener noreferrer">
            {tr('ch.tg.open')}<Icon name="arrow" size={18} />
          </a>
          <p className="alert-help">{tr('ch.tg.help')}</p>
          <p className="alert-note" role="status">{tr('ch.tg.waiting')}</p>
        </div>
      )}

      {error && <p className="alert-field-error" role="alert">{error}</p>}
    </Row>
  );
}

function PhoneRow({ channel, info, onChange }) {
  const { tr, lang } = useAlert();
  const id = useId();
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = tr(`channel.${channel}`);

  const run = async (task) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (problem) {
      setError(tr(channelErrorKey(problem)));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => onChange(await alertApi.channels());

  const sendCode = (event) => {
    event.preventDefault();
    const problem = phoneFormProblem({ phone, consent });
    if (problem) return setError(tr(problem));
    return run(async () => {
      await alertApi.startChannel(channel, { phone, consent: true, lang });
      setChanging(false);
      setOpen(false);
      setCode('');
      await refresh();
    });
  };

  const verify = (event) => {
    event.preventDefault();
    const problem = codeFormProblem(code);
    if (problem) return setError(tr(problem));
    return run(async () => {
      onChange(await alertApi.verifyChannel(channel, code.trim()));
      setCode('');
      setPhone('');
      setConsent(false);
    });
  };

  const disconnect = () => run(async () => {
    onChange(await alertApi.removeChannel(channel));
    setChanging(false);
  });

  const connected = info.linked;
  const awaitingCode = Boolean(info.pending) && !changing;
  const state = connected ? 'connected' : (info.available ? 'available' : 'unavailable');

  return (
    <Row name={name} state={state}>
      {!info.available && <p className="alert-muted">{tr('ch.unavailable')}</p>}

      {info.available && connected && (
        <>
          <p className="alert-help"><bdi>{digits(info.phoneMask ?? '', lang)}</bdi></p>
          <Receives minSeverity={info.minSeverity} />
          <button type="button" className="alert-button alert-button--ghost" onClick={disconnect} disabled={busy}>{busy ? tr('ch.working') : tr('ch.disconnect')}</button>
        </>
      )}

      {info.available && !connected && awaitingCode && (
        <form className="alert-channel-flow" onSubmit={verify} noValidate>
          <p className="alert-note" role="status">{tr('ch.code.sent', { phone: digits(info.pending.phoneMask ?? '', lang) })}</p>
          <label htmlFor={`${id}-code`} className="alert-label">{tr('ch.code')}</label>
          <input
            id={`${id}-code`}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          <div className="alert-channel-actions">
            <button type="submit" className="alert-button alert-button--primary" disabled={busy}>{busy ? tr('ch.working') : tr('ch.verify')}</button>
            <button type="button" className="alert-link-button" onClick={() => { setChanging(true); setOpen(true); setError(''); }} disabled={busy}>{tr('ch.different')}</button>
          </div>
        </form>
      )}

      {info.available && !connected && !awaitingCode && !open && (
        <button type="button" className="alert-button alert-button--primary" onClick={() => setOpen(true)}>{tr('ch.connect', { channel: name })}</button>
      )}

      {info.available && !connected && !awaitingCode && open && (
        <form className="alert-channel-flow" onSubmit={sendCode} noValidate>
          <label htmlFor={`${id}-phone`} className="alert-label">{tr('ch.phone')}</label>
          <input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
          />
          <p className="alert-help" id={`${id}-hint`}>{tr('ch.phone.hint')}</p>
          <label className="alert-check">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>{tr('ch.consent')}</span>
          </label>
          <Receives minSeverity={info.minSeverity} />
          <div className="alert-channel-actions">
            <button type="submit" className="alert-button alert-button--primary" disabled={busy}>{busy ? tr('ch.working') : tr('ch.sendCode')}</button>
            <button type="button" className="alert-link-button" onClick={() => { setOpen(false); setChanging(false); setError(''); }} disabled={busy}>{tr('btn.cancel')}</button>
          </div>
        </form>
      )}

      {error && <p className="alert-field-error" id={`${id}-error`} role="alert">{error}</p>}
    </Row>
  );
}

export function ChannelsPanel() {
  const { tr } = useAlert();
  const id = useId();
  const { overview, failed, reload, replace } = useChannels();

  return (
    <section className="alert-panel alert-channels" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{tr('ch.title')}</h2>
      <p className="alert-help">{tr('ch.lead')}</p>

      {failed && !overview && <p className="alert-field-error" role="alert">{tr('ch.loadError')}</p>}

      {overview && (
        <ul className="alert-channel-list">
          <TelegramRow info={overview.telegram} onChange={replace} onReload={reload} />
          <PhoneRow channel="whatsapp" info={overview.whatsapp} onChange={replace} />
          <PhoneRow channel="sms" info={overview.sms} onChange={replace} />
        </ul>
      )}

      <p className="alert-help">{tr('ch.privacy')}</p>
      <p className="alert-help">{tr('ch.quiet')}</p>
    </section>
  );
}
