import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { RootLayout } from './layout/RootLayout.js';

// ─────────────────────────────────────────────────────────────────────────────
// Lazy page imports — subtask 5 creates these files.
// tsc would normally flag missing modules; we use @ts-expect-error to let the
// type-checker pass while keeping the runtime import lazy.
// ─────────────────────────────────────────────────────────────────────────────

const OverviewPage = lazy(() => import('./pages/OverviewPage.js'));
const FullReportPage = lazy(() => import('./pages/FullReportPage.js'));
const SessionDetailPage = lazy(() => import('./pages/SessionDetailPage.js'));

/** Shared Suspense fallback used while page chunks are loading. */
function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route tree
// ─────────────────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  // Render only the Outlet here. RootLayout lives on the _layout child route
  // below so it wraps page content once — not twice. The previous pattern of
  // rendering <RootLayout /> AND <Outlet /> here AND having the _layout child
  // route also use RootLayout produced two sidebars in the DOM.
  component: Outlet,
});

const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_layout',
  component: RootLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <OverviewPage />
    </Suspense>
  ),
});

const reportRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/report',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <FullReportPage />
    </Suspense>
  ),
});

const reportDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/report/$sessionId',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <SessionDetailPage />
    </Suspense>
  ),
});

const routeTree = rootRoute.addChildren([
  layoutRoute.addChildren([overviewRoute, reportRoute, reportDetailRoute]),
]);

export const router = createRouter({ routeTree });

// Augment TanStack Router's type registry so it knows about our router.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
