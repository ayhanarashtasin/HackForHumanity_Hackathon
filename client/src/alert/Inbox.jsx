import { Icon } from '../components/Icon.jsx';
import { AlertCard } from './AlertCard.jsx';
import { useAlert } from './context.js';

// The inbox: current alerts (most severe first, as the server orders them) and earlier ones. Several hazards are always
// separate cards: a rain advisory never hides a lightning warning.
export function Inbox({ inbox, unread }) {
  const { tr } = useAlert();
  const {
    active, earlier, error, markRead, markAllRead, loadMore,
  } = inbox;

  return (
    <section className="alert-panel alert-inbox" aria-labelledby="alert-inbox-title">
      <div className="alert-inbox-head">
        <h2 id="alert-inbox-title">{tr('inbox.panel')}</h2>
        {unread > 0 && <span className="alert-tag alert-tag--new">{tr('inbox.unread', { n: unread })}</span>}
        <button type="button" className="alert-link-button" onClick={markAllRead} disabled={unread === 0}>{tr('inbox.markAll')}</button>
      </div>

      {error && active && <p className="alert-note" role="status">{tr('inbox.loadError')}</p>}

      <h3 className="alert-subhead">{tr('inbox.active')}</h3>
      {active === null && !error && <p className="alert-muted" role="status">{tr('page.loading')}</p>}
      {active === null && error && <p className="alert-note" role="status">{tr('inbox.loadError')}</p>}
      {active && active.length === 0 && (
        <div className="alert-empty">
          <Icon name="cloud" size={28} />
          <div>
            <p><strong>{tr('inbox.empty')}</strong></p>
            <p className="alert-help">{tr('inbox.empty.note')}</p>
          </div>
        </div>
      )}
      {active && active.map((item) => <AlertCard key={item.id} item={item} onRead={markRead} />)}

      <h3 className="alert-subhead">{tr('inbox.earlier')}</h3>
      {earlier.loaded && earlier.items.length === 0 && <p className="alert-muted">{tr('inbox.earlier.empty')}</p>}
      {earlier.items.map((item) => <AlertCard key={item.id} item={item} onRead={markRead} />)}
      {earlier.error && <p className="alert-note" role="status">{tr('inbox.loadError')}</p>}
      {earlier.hasMore && (
        <button type="button" className="alert-button alert-button--ghost" onClick={loadMore} disabled={earlier.loadingMore}>
          {tr('inbox.more')}
        </button>
      )}
    </section>
  );
}
