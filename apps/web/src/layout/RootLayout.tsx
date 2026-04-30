import { Outlet } from '@tanstack/react-router';
import { RecommendationChatPanel } from '../panels/RecommendationChatPanel.js';
import FloatingControls from './FloatingControls.js';

/**
 * RootLayout — full-width layout with floating utility controls.
 *
 * The sidebar has been removed. Content fills the full viewport width.
 */
export function RootLayout() {
  return (
    <div className="min-h-screen bg-background dark:bg-background-dark">
      <main className="flex-1 min-h-screen">
        <Outlet />
      </main>
      <FloatingControls />
      <RecommendationChatPanel />
    </div>
  );
}
