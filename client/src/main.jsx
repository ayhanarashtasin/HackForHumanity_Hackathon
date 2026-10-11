import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { resolveRoute, normalizeUrl } from './lib/router.js';
import { preloadPage } from './pages/pageLoader.js';
import './styles.css';

// Old shared map links ("/#view=...") now live at /map; fix the URL before the first render.
normalizeUrl();

const root = createRoot(document.getElementById('root'));
const render = () => root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Fetch the code of the screen this URL opens first, so the first thing painted is the screen itself and not a loading splash (index.html
// shows a quiet placeholder in the right colours meanwhile). If the chunk cannot be fetched, render anyway: the app shows its own error.
preloadPage(resolveRoute(window.location.pathname)).then(render, render);
