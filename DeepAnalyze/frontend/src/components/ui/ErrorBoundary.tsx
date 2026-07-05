import React, { Component } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional custom fallback renderer */
  fallback?: (error: Error, retry: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/* -------------------------------------------------------------------------- */
/*  Default fallback UI                                                       */
/* -------------------------------------------------------------------------- */

const DefaultFallback: React.FC<{
  error: Error;
  onRetry: () => void;
}> = ({ error, onRetry }) => {
  const wrapperStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-8) var(--space-6)',
    textAlign: 'center',
    width: '100%',
    minHeight: '200px',
  };

  const iconWrapStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--error-light)',
    color: 'var(--error)',
    marginBottom: 'var(--space-4)',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: 'var(--text-lg)',
    fontWeight: 'var(--font-semibold)' as unknown as number,
    color: 'var(--text-primary)',
    margin: 0,
  };

  const messageStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--text-tertiary)',
    lineHeight: 'var(--leading-relaxed)' as unknown as number,
    margin: 0,
    marginTop: 'var(--space-2)',
    maxWidth: '420px',
  };

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    marginTop: 'var(--space-5)',
    padding: '0 var(--space-3)',
    height: '32px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-primary)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--font-medium)' as unknown as number,
    cursor: 'pointer',
    transition: `all var(--transition-fast)`,
    fontFamily: 'var(--font-sans)',
  };

  return (
    <div style={wrapperStyle}>
      <span style={iconWrapStyle}>
        <AlertCircle size={22} />
      </span>
      <h3 style={titleStyle}>Something went wrong</h3>
      <p style={messageStyle}>
        {error.message || 'An unexpected error occurred. Please try again.'}
      </p>
      <button
        type="button"
        style={btnStyle}
        onClick={onRetry}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-secondary)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)';
          (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-primary)';
        }}
      >
        <RefreshCw size={14} />
        Try again
      </button>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/*  ErrorBoundary                                                             */
/* -------------------------------------------------------------------------- */

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }
      return (
        <DefaultFallback
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
