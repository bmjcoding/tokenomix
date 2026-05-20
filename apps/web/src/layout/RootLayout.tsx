import { Outlet } from '@tanstack/react-router';
import { useServerEvents } from '../lib/useServerEvents.js';
import { RecommendationChatPanel } from '../panels/RecommendationChatPanel.js';
import ActiveSessionsRail from './ActiveSessionsRail.js';
import FloatingControls from './FloatingControls.js';

/**
 * RootLayout — full-width layout with floating utility controls.
 *
 * The sidebar has been removed. Content fills the full viewport width.
 *
 * useServerEvents() is mounted here so SSE-driven cache invalidation runs on
 * every route (including /report and /report/:sessionId), not just the
 * overview page. This is required because ActiveSessionsRail, rendered on
 * every route, needs live session updates across all routes.
 */
export function RootLayout() {
  // SSE live refresh — invalidates TanStack Query cache on 'updated' events.
  useServerEvents();

  return (
    <div className="min-h-screen bg-background dark:bg-background-dark">
      <main className="flex-1 min-h-screen">
        <Outlet />
      </main>
      <FloatingControls />
      <RecommendationChatPanel />
      <ActiveSessionsRail />
    </div>
  );
}
