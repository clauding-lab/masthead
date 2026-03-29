import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] px-6 text-center">
          <div className="w-16 h-16 mb-4 rounded-xl flex items-center justify-center" style={{ backgroundColor: 'var(--bg-surface)' }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 className="font-display text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            Something went wrong
          </h2>
          <p className="font-ui text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            An error occurred while loading this page.
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false });
              window.history.back();
            }}
            className="px-5 py-2.5 rounded-lg font-ui text-sm font-medium"
            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
          >
            Go Back
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
