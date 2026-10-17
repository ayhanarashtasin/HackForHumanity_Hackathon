import { useEffect, useRef, useState } from 'react';
import { areaLabel } from '../lib/alertForm.js';
import { pauseLocationAlerts, rememberUserPosition, resolveUserPosition } from '../lib/userLocation.js';
import { useUserLocation } from '../hooks/useUserLocation.js';
import { alertApi } from '../services/alertApi.js';
import { stopLocationArea, syncLocationArea, updateLocationArea } from './locationSync.js';
import { useAlert } from './context.js';

const HEARTBEAT_MS = 5 * 60_000;

// Entry capture shares an area once; continuous following still needs this separate opt-in.
export function LiveLocation({ profile, onProfile }) {
  const { tr, lang, catalogue, index } = useAlert();
  const location = useUserLocation();
  const [enabled, setEnabled] = useState(false);
  const [area, setArea] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(null);
  const lastSentAt = useRef(0);
  const pending = useRef(false);
  const queued = useRef(null);
  const following = useRef(false);
  const locate = useRef(null);

  useEffect(() => {
    if (!enabled && !profile.currentArea) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled, profile.currentArea]);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    following.current = true;
    if (!window.isSecureContext || !navigator.geolocation || !catalogue) {
      setError('live.unsupported');
      setEnabled(false);
      return undefined;
    }

    const update = async (pcode) => {
      if (!active || !following.current) return;
      if (pending.current) { queued.current = pcode; return; }
      pending.current = true;
      setBusy(true);
      try {
        const data = await updateLocationArea(pcode);
        if (!active || !following.current) return;
        last.current = pcode;
        lastSentAt.current = Date.now();
        setClock(Date.now());
        setArea(pcode);
        setUpdatedAt(new Date());
        setError('');
        onProfile(data.profile);
      } catch (problem) {
        if (active && problem.status === 409) {
          setEnabled(false);
          setArea(null);
          last.current = null;
          alertApi.me().then((data) => onProfile(data.profile)).catch(() => {});
          setError('live.telegramActive');
        } else if (active) setError('live.saveError');
      } finally {
        pending.current = false;
        if (active) setBusy(false);
        if (active && following.current && queued.current) {
          const next = queued.current;
          queued.current = null;
          if (next !== last.current) update(next);
        }
      }
    };

    const found = async ({ coords, timestamp }) => {
      if (!active || !following.current) return;
      if (coords.accuracy > 10_000) { setError('live.inaccurate'); setBusy(false); return; }
      try {
        const resolved = await resolveUserPosition(coords);
        if (!active || !following.current) return;
        const { pcode } = resolved;
        if (!pcode) { setError('live.outside'); setBusy(false); return; }
        rememberUserPosition(resolved, Number.isFinite(timestamp) ? timestamp : Date.now());
        if (last.current !== pcode || Date.now() - lastSentAt.current >= HEARTBEAT_MS) await update(pcode);
        else setBusy(false);
      } catch {
        if (active) { setError('live.loadError'); setBusy(false); }
      }
    };
    const failed = (problem) => {
      if (active) { setError(problem.code === 1 ? 'live.denied' : 'live.gpsError'); setBusy(false); }
    };
    locate.current = () => {
      setBusy(true);
      navigator.geolocation.getCurrentPosition(found, failed, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
    };
    const watch = navigator.geolocation.watchPosition(found, failed, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
    const heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') locate.current?.();
    }, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') locate.current?.(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      following.current = false;
      queued.current = null;
      locate.current = null;
      navigator.geolocation.clearWatch(watch);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, catalogue, onProfile]);

  const stop = async () => {
    following.current = false;
    queued.current = null;
    pauseLocationAlerts();
    setEnabled(false);
    setBusy(true);
    try {
      const data = await stopLocationArea();
      last.current = null;
      lastSentAt.current = 0;
      queued.current = null;
      setArea(null);
      setUpdatedAt(null);
      onProfile(data.profile);
      setError('');
    } catch (problem) {
      if (problem.status === 409) {
        setArea(null);
        last.current = null;
        alertApi.me().then((data) => onProfile(data.profile)).catch(() => {});
        setError('live.telegramActive');
      } else setError('live.saveError');
    }
    finally { setBusy(false); }
  };

  const freshStored = profile.currentArea && Date.parse(profile.currentArea.expiresAt) > clock;
  const fresh = area && freshStored;
  const telegramActive = freshStored && profile.currentArea.source === 'telegram';

  return (
    <section className="alert-panel" aria-labelledby="alert-live-title">
      <h2 id="alert-live-title">{tr('live.title')}</h2>
      <p className="alert-help">{tr('live.help')}</p>
      {telegramActive && <p className="alert-help" role="status">{tr('live.telegramActive')}</p>}
      {!enabled && !area && freshStored && <p role="status">{tr('live.recent', { name: areaLabel(index, profile.currentArea.upazilaPcode, lang) })}</p>}
      {area && <p role="status">{tr(fresh ? 'live.area' : 'live.expired', { name: areaLabel(index, area, lang) })} {updatedAt?.toLocaleTimeString(lang === 'bn' ? 'bn-BD' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</p>}
      {enabled && !area && <p role="status">{tr('live.waiting')}</p>}
      {error && <p className="alert-field-error" role="alert">{tr(error)}</p>}
      {!error && location.alertStatus === 'error' && <p className="alert-field-error" role="status">{tr('live.saveError')}</p>}
      <div className="alert-profile-actions">
        {enabled
          ? <><button type="button" className="alert-button alert-button--ghost" onClick={() => locate.current?.()} disabled={busy}>{tr('live.refresh')}</button>
              <button type="button" className="alert-button alert-button--ghost" onClick={stop}>{tr('live.stop')}</button></>
          : <><button type="button" className="alert-button alert-button--ghost" onClick={() => { setError(''); setEnabled(true); }} disabled={busy || !catalogue || telegramActive}>{tr('live.start')}</button>
              {location.alertStatus === 'error' && <button type="button" className="alert-button alert-button--ghost" onClick={() => syncLocationArea(profile).then((data) => { if (data) onProfile(data.profile); }).catch(() => {})}>{tr('live.retry')}</button>}
              {freshStored && !telegramActive && <button type="button" className="alert-button alert-button--ghost" onClick={stop} disabled={busy}>{tr('live.stop')}</button>}</>}
      </div>
    </section>
  );
}
