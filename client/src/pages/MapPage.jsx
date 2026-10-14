import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayerMenu } from '../components/LayerMenu.jsx';
import { Icon } from '../components/Icon.jsx';
import { Legend } from '../components/Legend.jsx';
import { LightningPanel } from '../components/LightningPanel.jsx';
import { Link } from '../components/Link.jsx';
import { LocationPanel } from '../components/LocationPanel.jsx';
import { LocationAccess } from '../components/LocationAccess.jsx';
import { LogoMark } from '../components/Logo.jsx';
import { MapView } from '../components/MapView.jsx';
import { SearchBox } from '../components/SearchBox.jsx';
import { StatusPanel } from '../components/StatusPanel.jsx';
import { TimeBar } from '../components/TimeBar.jsx';
import { Tooltip } from '../components/Tooltip.jsx';
import { useUnreadBadge } from '../alert/useUnreadBadge.js';
import { usePolled } from '../hooks/usePolled.js';
import { useUserLocation } from '../hooks/useUserLocation.js';
import { resolveSelection } from '../lib/series.js';
import { nearestIndex, stepIndexAt, toMs } from '../lib/time.js';
import { readHash, writeHash } from '../lib/urlState.js';
import { loadCatalogue, weatherApi } from '../services/weatherApi.js';
import { useLanguage } from '../i18n/index.js';
import { MAP } from '../i18n/map.js';
import { LanguageToggle } from '../components/LanguageToggle.jsx';
import './map-page.css';

const MINUTE = 60_000;
const RADAR_MAX_GAP = 15 * MINUTE;
const SATELLITE_MAX_GAP = 15 * MINUTE;

// Live mode scrubs observation frames (radar, else satellite); forecast mode scrubs BMD's 3-hour steps.
function buildTimeline({ mode, overlays, radar, satellite, satelliteLayer, snapshot }) {
  if (mode === 'live') {
    const driver = overlays.radar
      ? (radar?.sites ?? []).map((site) => site.frames.sri ?? []).sort((a, b) => b.length - a.length)[0]?.map((frame) => toMs(frame.time))
      : null;
    const times = driver ?? (overlays.satellite ? (satellite?.layers?.[satelliteLayer]?.frames ?? []).map(toMs) : []);
    return { kind: 'live', times, nowIndex: Math.max(times.length - 1, 0) };
  }

  const times = (snapshot?.steps ?? []).map(toMs);
  const now = Date.now();
  let nowIndex = 0;
  times.forEach((time, i) => { if (time <= now) nowIndex = i; });
  return { kind: 'forecast', times, nowIndex };
}

function nearestFrame(frames, time, maxGap, getTime) {
  if (!frames?.length) return null;
  const index = nearestIndex(frames.map(getTime), time);
  return Math.abs(getTime(frames[index]) - time) <= maxGap ? frames[index] : null;
}

export default function MapPage() {
  const { lang, tr, number } = useLanguage(MAP);
  const initial = useMemo(() => readHash(), []);
  const [catalogue, setCatalogue] = useState(null);
  const [catalogueError, setCatalogueError] = useState('');

  const snapshotState = usePolled(weatherApi.snapshot, 5 * MINUTE);
  const radarState = usePolled(weatherApi.radarFrames, 2 * MINUTE);
  const satelliteState = usePolled(weatherApi.satelliteFrames, 5 * MINUTE);
  const lightningStatusState = usePolled(weatherApi.lightningStatus, 5 * MINUTE);
  const lightningSummariesState = usePolled(weatherApi.lightningSummaries, 5 * MINUTE);

  const [signLayer, setSignLayer] = useState(initial.layer ?? 'temp');
  const [overlays, setOverlays] = useState(initial.overlays ?? { radar: false, satellite: false, lightning: false });
  const [satelliteLayer, setSatelliteLayer] = useState('ir');
  const [mode, setMode] = useState(initial.overlays?.radar || initial.overlays?.satellite ? 'live' : 'forecast');
  const [selectedTime, setSelectedTime] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const [hover, setHover] = useState(null);
  const [flyRequest, setFlyRequest] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [lightningPanelOpen, setLightningPanelOpen] = useState(true);
  const [lightningSelected, setLightningSelected] = useState(null);
  const [lightningInfo, setLightningInfo] = useState(null);
  const [mobileView, setMobileView] = useState('weather');
  const viewRef = useRef(initial.view);
  const locationIntentRef = useRef(true);
  const sidebarRef = useRef(null);
  const location = useUserLocation(catalogue);
  const unreadAlerts = useUnreadBadge();

  useEffect(() => {
    if (!location.match || !locationIntentRef.current) return;
    setSelection(location.match.selection);
    setFlyRequest({ ...location.position, zoom: 10.2 });
    setSelectedTime(null);
    setPlaying(false);
    setMobileView('weather');
  }, [location.match, location.position]);

  useEffect(() => {
    const controller = new AbortController();
    loadCatalogue(controller.signal)
      .then(setCatalogue)
      .catch((error) => { if (!controller.signal.aborted) setCatalogueError(error.message); });
    return () => controller.abort();
  }, []);

  const snapshot = snapshotState.data;
  const radar = radarState.data;
  const satellite = satelliteState.data;

  // ---------- time ----------
  const timeline = useMemo(
    () => buildTimeline({ mode, overlays, radar, satellite, satelliteLayer, snapshot }),
    [mode, overlays, radar, satellite, satelliteLayer, snapshot],
  );
  const tickIndex = timeline.times.length
    ? (selectedTime === null ? timeline.nowIndex : nearestIndex(timeline.times, selectedTime))
    : 0;
  const currentTime = timeline.times[tickIndex] ?? Date.now();
  const stepIndex = snapshot?.steps?.length ? stepIndexAt(snapshot.steps, currentTime) : 0;

  useEffect(() => {
    if (!playing || timeline.times.length < 2) return undefined;
    const timer = setInterval(() => {
      setSelectedTime((time) => {
        const index = time === null ? timeline.nowIndex : nearestIndex(timeline.times, time);
        return timeline.times[(index + 1) % timeline.times.length];
      });
    }, 700);
    return () => clearInterval(timer);
  }, [playing, timeline]);

  useEffect(() => {
    if (timeline.times.length < 2) setPlaying(false);
  }, [timeline]);

  // ---------- overlays handed to the map ----------
  const radarItems = useMemo(() => {
    if (mode !== 'live' || !overlays.radar) return [];
    return (radar?.sites ?? []).flatMap((site) => {
      const frame = site.maintenance ? null : nearestFrame(site.frames.sri, currentTime, RADAR_MAX_GAP, (f) => toMs(f.time));
      const bounds = frame ? site.bounds[frame.radius] : null;
      return frame && bounds ? [{ siteId: site.id, url: frame.url, bounds, time: toMs(frame.time) }] : [];
    });
  }, [mode, overlays.radar, radar, currentTime]);

  const satelliteSpec = useMemo(() => {
    if (mode !== 'live' || !overlays.satellite) return null;
    const layer = satellite?.layers?.[satelliteLayer];
    const time = layer ? nearestFrame(layer.frames, currentTime, SATELLITE_MAX_GAP * 4, toMs) : null;
    return time ? { tileUrl: layer.tileUrl.replace('{time}', time), maxZoom: layer.maxZoom, time: toMs(time) } : null;
  }, [mode, overlays.satellite, satellite, satelliteLayer, currentTime]);

  const lightning = useMemo(
    () => ({ visible: overlays.lightning, items: lightningSummariesState.data?.items ?? [] }),
    [overlays.lightning, lightningSummariesState.data],
  );

  // ---------- data status ----------
  const statuses = useMemo(() => {
    const fromSnapshot = snapshot?.sources;
    return {
      bmd: fromSnapshot?.bmd,
      openMeteo: fromSnapshot?.openMeteo,
      radar: radar?.status ?? fromSnapshot?.radar,
      satellite: satellite?.status ?? fromSnapshot?.satellite,
    };
  }, [snapshot, radar, satellite]);

  let baseStatus = 'not-checked';
  if (!snapshot) baseStatus = snapshotState.error ? 'unavailable' : 'not-checked';
  else if (snapshot.base) baseStatus = snapshot.sources[snapshot.base === 'bmd' ? 'bmd' : 'openMeteo'].status;
  else if (snapshot.sources.bmd.status !== 'not-checked' || snapshot.sources.openMeteo.status !== 'not-checked') baseStatus = 'unavailable';

  // ---------- selection ----------
  const resolved = useMemo(() => resolveSelection(selection, snapshot, catalogue, lang), [selection, snapshot, catalogue, lang]);
  const dailyState = usePolled(weatherApi.daily, 30 * MINUTE, { enabled: Boolean(resolved?.dailyPcode) });

  const dailyPcode = resolved?.dailyPcode ?? null;
  useEffect(() => {
    if (sidebarRef.current) sidebarRef.current.scrollTop = 0;
  }, [selection?.id, selection?.level]);

  useEffect(() => {
    if (!dailyPcode || !overlays.lightning) { setLightningInfo(null); return undefined; }
    setLightningInfo(null);
    const controller = new AbortController();
    weatherApi.lightningForUpazila(dailyPcode, controller.signal)
      .then(setLightningInfo)
      .catch(() => { if (!controller.signal.aborted) setLightningInfo(null); });
    return () => controller.abort();
  }, [dailyPcode, overlays.lightning]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { setStatusOpen(false); setMenuOpen(false); setHover(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- URL hash ----------
  useEffect(() => {
    writeHash({ view: viewRef.current, layer: signLayer, overlays });
  }, [signLayer, overlays]);

  const signLayerRef = useRef(signLayer);
  const overlaysRef = useRef(overlays);
  signLayerRef.current = signLayer;
  overlaysRef.current = overlays;

  const onMoveEnd = useCallback((view) => {
    viewRef.current = view;
    writeHash({ view, layer: signLayerRef.current, overlays: overlaysRef.current });
  }, []);

  // ---------- actions ----------
  const toggleOverlay = (key) => {
    const next = { ...overlays, [key]: !overlays[key] };
    setOverlays(next);
    setSelectedTime(null);
    if (key !== 'lightning') {
      if (next[key]) setMode('live');
      else if (!next.radar && !next.satellite) setMode('forecast');
    }
    if (key === 'lightning' && next.lightning) {
      setLightningPanelOpen(true);
      setMenuOpen(false);
      requestAnimationFrame(() => document.querySelector('.lightning-content')?.focus({ preventScroll: true }));
    }
  };

  const changeMode = (next) => {
    setMode(next);
    setSelectedTime(null);
    setPlaying(false);
    if (next === 'live' && !overlays.radar && !overlays.satellite) setOverlays({ ...overlays, radar: true });
  };

  const pickResult = (item) => {
    locationIntentRef.current = false;
    setSelection({ level: item.level, id: item.id });
    setFlyRequest({ lat: item.lat, lon: item.lon, zoom: item.zoom });
    setMobileView('weather');
  };

  const goToMyLocation = () => {
    locationIntentRef.current = true;
    if (location.status === 'ready') {
      setSelection(location.match.selection);
      setFlyRequest({ ...location.position, zoom: 10.2 });
      setSelectedTime(null);
      setPlaying(false);
      setMobileView('weather');
    } else location.requestLocation();
  };

  const closeDetails = () => { locationIntentRef.current = false; setSelection(null); };
  const focusSearch = () => document.getElementById('map-location-search')?.focus();
  const isUserLocation = Boolean(selection && location.match
    && selection.level === location.match.selection.level && selection.id === location.match.selection.id);
  const locating = location.status === 'locating' || location.status === 'resolving';

  const mapHandlers = useMemo(() => ({
    onSelect: (picked) => {
      if (!picked) return;
      locationIntentRef.current = false;
      setSelection(picked);
      setMobileView('weather');
    },
    onHover: (picked, point) => setHover(picked ? { picked, ...point } : null),
    onMoveEnd,
    onLightningSelect: (id) => { setLightningSelected(id); setLightningPanelOpen(true); setMenuOpen(false); },
  }), [onMoveEnd]);

  const liveNote = mode === 'live' ? 'Live frames are not available right now.' : 'Forecast is not available right now.';
  const showLightningPanel = overlays.lightning && lightningPanelOpen;
  const bannerText = catalogueError
    || (snapshotState.error && !snapshot ? 'Cannot reach the weather service. Showing the map without data.' : '')
    || (snapshot && !snapshot.base && baseStatus === 'unavailable' ? 'No forecast data is available right now. Grey markers mean no data, not calm weather.' : '');

  return (
    <div className={`app weather-app mobile-view-${mobileView}`}>
      <header className="topbar">
        <Link to="/" className="brand" aria-label={tr('AkashSathi home')} title={tr('Back to the AkashSathi home page')}>
          <LogoMark size={34} />
          <div>
            <strong>{tr('AkashSathi')}</strong>
            <span>{tr('A little closer to your sky')}</span>
          </div>
        </Link>
        <span className="map-header-divider" aria-hidden="true" />
        <div className="map-header-title"><Icon name="map" size={18} /><h1>{tr('Weather explorer')}</h1></div>
        <SearchBox catalogue={catalogue} onPick={pickResult} />
        <button type="button" className="header-location-button" onClick={goToMyLocation} disabled={!catalogue || locating}><Icon name="locate" size={18} /><span>{tr(locating ? 'Locating…' : 'My weather')}</span></button>
        <LanguageToggle />
        <Link to="/alert" className="header-alert-link" aria-label={unreadAlerts > 0 ? tr('Alerts, {n} unread', { n: unreadAlerts }) : tr('Alerts')} title={tr('Alerts for your work and area')}>
          <Icon name="bell" size={18} /><span>{tr('Alerts')}</span>
          {unreadAlerts > 0 && <b className="header-alert-badge" aria-hidden="true">{number(unreadAlerts > 9 ? '9+' : unreadAlerts)}</b>}
        </Link>
        <StatusPanel open={statusOpen} onToggle={() => setStatusOpen((open) => !open)} statuses={statuses} base={snapshot?.base} />
      </header>

      <nav className="mobile-view-switch" aria-label={tr('Explorer view')}>
        <button type="button" aria-pressed={mobileView === 'weather'} onClick={() => setMobileView('weather')}><Icon name="cloud" size={18} /> {tr('Local weather')}</button>
        <button type="button" aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><Icon name="map" size={18} /> {tr('Explore map')}</button>
      </nav>

      <main className="map-workspace">
        <aside className="weather-sidebar" aria-label={tr('Local weather')}>
          <div className="sidebar-heading"><span><Icon name="cloud" size={18} /> {tr('Local weather')}</span><small>{tr('Bangladesh · BST')}</small></div>
          <div className="sidebar-content" ref={sidebarRef}>
            {resolved && locationIntentRef.current && location.message && <p className="sidebar-location-message note-warning" role="status">{tr(location.message)}</p>}
            {resolved ? (
              <LocationPanel
                key={`${resolved.level}-${resolved.id}`}
                resolved={resolved}
                snapshot={snapshot}
                stepIndex={stepIndex}
                dailyState={dailyState}
                lightningInfo={lightningInfo}
                baseStatus={baseStatus}
                loading={snapshotState.loading}
                isUserLocation={isUserLocation}
                location={location}
                onStep={(index) => { changeMode('forecast'); setSelectedTime(toMs(snapshot.steps[index])); }}
                onClose={closeDetails}
              />
            ) : <LocationAccess location={location} onLocate={goToMyLocation} onSearch={focusSearch} />}
          </div>
          <div className="sidebar-footer"><span className={`dot dot-${baseStatus}`} aria-hidden="true" /><span>{baseStatus === 'ok' ? tr('{source} available', { source: tr(snapshot?.baseLabel ?? 'Weather forecast') }) : tr(baseStatus === 'stale' ? 'Forecast is stale' : snapshotState.loading ? 'Loading forecast…' : 'Forecast data unavailable')}</span><button type="button" onClick={() => setStatusOpen((open) => !open)}>{tr('Details')} <Icon name="arrow" size={14} /></button></div>
        </aside>

        <section className={`map-stage${showLightningPanel ? ' has-lightning-panel' : menuOpen ? ' has-layer-menu' : ''}`} aria-label={tr('Bangladesh weather explorer')}>
          {catalogue ? (
            <MapView
              catalogue={catalogue}
              initialView={initial.view}
              signLayer={signLayer}
              snapshot={snapshot}
              stepIndex={stepIndex}
              baseStatus={baseStatus}
              radarItems={radarItems}
              satelliteSpec={satelliteSpec}
              lightning={lightning}
              selection={selection}
              flyRequest={flyRequest}
              userPosition={location.match ? location.position : null}
              handlers={mapHandlers}
            />
          ) : <div className="splash" role="status">{tr(catalogueError || 'Preparing your weather map…')}</div>}

          <div className="map-toolbar">
            <div className="map-context panel"><Icon name="pin" size={19} /><div><strong>{resolved?.name ?? tr('Explore Bangladesh')}</strong><span>{resolved ? `${tr(resolved.kind)} · ${tr(isUserLocation ? 'Your area' : 'Selected area')}` : tr('Select an area to see its weather')}</span></div></div>
            <div className="map-actions">
              <button type="button" className="panel icon-button" aria-label={tr('Show my location and weather')} title={tr('My location')} onClick={goToMyLocation} disabled={!catalogue || locating}><Icon name="locate" size={21} /></button>
              <button type="button" className="panel icon-button" aria-label={tr('Show all of Bangladesh')} title={tr('Show Bangladesh')} onClick={() => { setFlyRequest({ fit: true }); setHover(null); }}><Icon name="map" size={21} /></button>
            </div>
          </div>

          {bannerText && <p className="banner" role="status">{tr(bannerText)}</p>}
          <div className={`right-stack${showLightningPanel ? ' with-lightning' : ''}`}>
            <LayerMenu
              open={menuOpen}
              onToggleOpen={() => setMenuOpen((open) => !open)}
              signLayer={signLayer}
              onSignLayer={setSignLayer}
              overlays={overlays}
              onToggleOverlay={toggleOverlay}
              satelliteLayer={satelliteLayer}
              onSatelliteLayer={(layer) => { setSatelliteLayer(layer); setSelectedTime(null); }}
              statuses={statuses}
            />
            {showLightningPanel && (
              <LightningPanel
                status={lightningStatusState.data}
                summaries={lightningSummariesState.data}
                statusError={lightningStatusState.error}
                summariesError={lightningSummariesState.error}
                selectedId={lightningSelected}
                onClear={() => setLightningSelected(null)}
                onRetry={() => { lightningStatusState.reload(); lightningSummariesState.reload(); }}
                onClose={() => {
                  setLightningPanelOpen(false);
                  requestAnimationFrame(() => document.getElementById('lightning-summary-toggle')?.focus());
                }}
              />
            )}
            {overlays.lightning && !lightningPanelOpen && (
              <button id="lightning-summary-toggle" type="button" className="lightning-reopen panel" onClick={() => {
                setLightningPanelOpen(true);
                setMenuOpen(false);
                requestAnimationFrame(() => document.querySelector('.lightning-content')?.focus({ preventScroll: true }));
              }} aria-label={tr('Show lightning summaries')}><span><Icon name="bolt" size={18} /> {tr('Lightning summaries')}</span><Icon name="arrow" size={16} /></button>
            )}
          </div>

          <Legend signLayer={signLayer} baseStatus={baseStatus} baseLabel={snapshot?.baseLabel} overlays={overlays} mode={mode} radarTime={radarItems[0]?.time} satelliteTime={satelliteSpec?.time} satelliteLayer={satelliteLayer} />
          <TimeBar
            mode={mode}
            onMode={changeMode}
            timeline={timeline}
            tickIndex={tickIndex}
            onTick={(index) => setSelectedTime(timeline.times[index])}
            playing={playing}
            onPlay={() => setPlaying((value) => !value)}
            currentTime={currentTime}
            onNow={() => { setSelectedTime(null); setPlaying(false); }}
            liveNote={tr(liveNote)}
          />
          <Tooltip hover={hover} snapshot={snapshot} catalogue={catalogue} signLayer={signLayer} stepIndex={stepIndex} />
        </section>
      </main>
    </div>
  );
}
