import { Component } from 'react';
import { useLanguage } from '../i18n/index.js';
import { LanguageToggle } from './LanguageToggle.jsx';

function ErrorScreen() {
  const { tr } = useLanguage();
  return (
    <div className="splash" role="alert">
      <div>
        <LanguageToggle />
        <p>{tr('Something went wrong while drawing this page.')}</p>
        <button type="button" className="text-button" onClick={() => window.location.reload()}>{tr('Reload')}</button>
      </div>
    </div>
  );
}

// A render error in one panel should never leave a blank screen.
export class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('UI error:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return <ErrorScreen />;
  }
}
