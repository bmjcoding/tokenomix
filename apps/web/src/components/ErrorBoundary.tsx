/**
 * ErrorBoundary — React class component that catches render exceptions.
 *
 * Design decisions:
 * - Must be a class component: React's getDerivedStateFromError/componentDidCatch
 *   lifecycle hooks are only available on class components.
 * - Catches any render-time or lifecycle exception from child components and
 *   replaces the crashed subtree with a minimal recovery UI.
 * - Recovery UI: a brief error message and a "Reload" button. The button calls
 *   window.location.reload() — re-renders alone cannot clear a render error
 *   because TanStack Query caches may hold corrupted state.
 * - Logs the error via console.error for devtools visibility; there is no
 *   structured frontend logger in this project.
 * - Achromatic surface (Card-style), red error text per project error pattern.
 * - Every color class has a matching dark: counterpart.
 */

import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ErrorBoundaryState {
  hasError: boolean;
  /** Captured error message for display — sanitised to avoid XSS via JSX text rendering. */
  errorMessage: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional override fallback — if omitted the default recovery UI renders. */
  fallback?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'An unexpected error occurred.';

    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Log to devtools — no structured frontend logger exists in this project.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Render exception caught:', error, info.componentStack);
  }

  handleReload(): void {
    window.location.reload();
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    // Default recovery UI — achromatic card surface, red error label.
    return (
      <div
        role="alert"
        className="flex flex-col items-center justify-center gap-4 py-24 px-6 text-center"
      >
        <p className="text-sm font-medium text-red-600 dark:text-red-400">
          Something went wrong rendering this page.
        </p>
        {/* Render as text content — never via dangerouslySetInnerHTML */}
        {this.state.errorMessage.length > 0 && (
          <p className="max-w-sm text-xs text-gray-500 dark:text-gray-400 font-mono break-words">
            {this.state.errorMessage}
          </p>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-lg transition-colors bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950"
        >
          Reload
        </button>
      </div>
    );
  }
}
