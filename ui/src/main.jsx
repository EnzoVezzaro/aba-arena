import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import BattlePage from './BattlePage.jsx';
import { Icon } from './components.jsx';
import './styles.css';

/**
 * Error boundary — an uncaught render/lifecycle error must never blank the
 * page. Shows a recoverable screen with the error and a reload button
 * instead of a white viewport.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ABA] render error:', error, info);
  }

  componentDidMount() {
    // Error boundaries only catch render/lifecycle errors. Event-handler and
    // async rejections would otherwise leave a silent blank page — surface
    // them through the same recoverable screen instead.
    this._onError = (event) => {
      if (event.error) this.setState({ error: event.error });
    };
    this._onRejection = (event) => {
      const reason = event.reason;
      this.setState({ error: reason instanceof Error ? reason : new Error(String(reason)) });
    };
    window.addEventListener('error', this._onError);
    window.addEventListener('unhandledrejection', this._onRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('error', this._onError);
    window.removeEventListener('unhandledrejection', this._onRejection);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid-bg min-h-screen">
          <div className="app-shell flex min-h-screen flex-col items-center justify-center gap-4 px-6 py-24 text-center">
            <span className="grid size-14 place-items-center rounded-2xl border border-red-400/30 bg-red-400/10 text-red-400">
              <Icon name="alert" className="size-7" />
            </span>
            <div className="max-w-md">
              <p className="font-pixel text-[13px] tracking-[0.1em] text-[var(--color-ink-dim)]">something broke</p>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
                The arena hit an unexpected error. Your battle data is safe — reload to continue.
              </p>
              <p className="mt-3 break-words rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 font-mono text-[10px] text-red-400/80">
                {String(this.state.error?.message || this.state.error).slice(0, 300)}
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="action-primary mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-semibold"
            >
              <Icon name="refresh" className="size-4" />
              <span>reload</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Root() {
  const isBattle = window.location.pathname.startsWith('/battle');
  if (isBattle) {
    return <BattlePage onBack={() => { window.location.href = '/'; }} />;
  }
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
);
