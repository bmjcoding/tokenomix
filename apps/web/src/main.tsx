import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { MotionPreferenceProvider } from './providers/MotionPreferenceProvider.js';
import { QueryProvider } from './providers/QueryProvider.js';
import { RefreshModeProvider } from './providers/RefreshModeProvider.js';
import { ThemeProvider } from './providers/ThemeProvider.js';
import { router } from './router.js';
import './index.css';

// ---------------------------------------------------------------------------
// SSE-degraded banner
//
// useServerEvents.ts dispatches a `tokenomix:sse-degraded` custom DOM event
// when 3+ consecutive EventSource errors occur. It dispatches
// `tokenomix:sse-recovered` when a new connection succeeds after degradation.
// This banner listens for both events and shows a 1-line notice above the router
// root so users know live updates may be stale.
// ---------------------------------------------------------------------------

function SseDegradedBanner() {
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    function onDegraded() {
      setDegraded(true);
    }
    function onRecovered() {
      setDegraded(false);
    }

    window.addEventListener('tokenomix:sse-degraded', onDegraded);
    window.addEventListener('tokenomix:sse-recovered', onRecovered);

    return () => {
      window.removeEventListener('tokenomix:sse-degraded', onDegraded);
      window.removeEventListener('tokenomix:sse-recovered', onRecovered);
    };
  }, []);

  if (!degraded) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800 px-4 py-2 text-center text-xs text-amber-800 dark:text-amber-200"
    >
      Live updates degraded — refresh if data looks stale.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in document.');
}

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <RefreshModeProvider>
        <MotionPreferenceProvider>
          <QueryProvider>
            {/* ErrorBoundary wraps the entire router so any panel render exception
                shows a recovery UI instead of a blank screen. */}
            <ErrorBoundary>
              <SseDegradedBanner />
              <RouterProvider router={router} />
            </ErrorBoundary>
          </QueryProvider>
        </MotionPreferenceProvider>
      </RefreshModeProvider>
    </ThemeProvider>
  </StrictMode>
);
