import { Component } from 'react';

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

    return (
      <div className="splash" role="alert">
        <div>
          <p>Something went wrong while drawing this page.</p>
          <button type="button" className="text-button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
