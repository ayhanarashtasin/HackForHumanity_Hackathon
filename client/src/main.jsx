import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { normalizeUrl } from './lib/router.js';
import './styles.css';

// Old shared map links ("/#view=...") now live at /map; fix the URL before the first render.
normalizeUrl();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
