import { useState } from 'react';
import { syncLocationArea } from '../alert/locationSync.js';
import { useUserLocation } from '../hooks/useUserLocation.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { Icon } from './Icon.jsx';

const DISMISSED_KEY = 'akashsathi:location-dismissed';

// A non-modal entry request: explain the use before opening the browser prompt, and never block the site.
export function LocationNotice({ hidden }) {
  const { tr } = useLanguage(MAP);
  const location = useUserLocation();
  const [dismissed, setDismissed] = useState(() => {
    try { return typeof window !== 'undefined' && window.sessionStorage?.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
  });
  const busy = ['locating', 'resolving'].includes(location.status);
  const ready = location.status === 'ready';
  const syncError = location.alertStatus === 'error';

  const handleDismiss = () => {
    setDismissed(true);
    try { window.sessionStorage?.setItem(DISMISSED_KEY, '1'); } catch {}
  };

  if (hidden || (dismissed && !syncError) || (ready && !syncError)) return null;
  const message = syncError ? 'Could not update your current-area alerts. Your saved areas are still active.'
    : location.alertStatus === 'telegram' ? 'Telegram is following your location. Its alert area has not been changed.'
      : ready ? 'Your detected area is ready for the map and alert registration.'
        : busy ? 'Finding your location…' : location.message;
  return (
    <section className="location-notice panel" aria-labelledby="entry-location-title">
      <div className="location-notice-heading"><Icon name="locate" size={20} /><h2 id="entry-location-title">{tr('Location for maps and alerts')}</h2></div>
      <p>{tr('Use your location once to show local weather and relevant alerts. For maps and alerts, precise coordinates stay in this tab; only your area code is shared with your alert profile. The current alert area expires after 15 minutes without updates. Live following is optional.')}</p>
      {message && <p className="location-notice-status" role="status">{tr(message)}</p>}
      <div className="location-notice-actions">
        {(!ready || syncError) && <button type="button" className="text-button location-notice-primary" disabled={busy || location.status === 'unsupported'} onClick={() => {
          if (syncError) syncLocationArea().catch(() => {}); // the shared status displays the failure
          else location.requestLocation();
        }}>{tr(busy ? 'Finding your location…' : syncError ? 'Retry alert location' : location.status === 'idle' ? 'Use my location' : 'Try again')}</button>}
        <button type="button" className="text-button" onClick={handleDismiss}>{tr(location.status === 'idle' ? 'Not now — choose an area manually' : 'Close')}</button>
      </div>
    </section>
  );
}
