import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { RootLayout } from './layout/RootLayout.js';

// ─────────────────────────────────────────────────────────────────────────────
// Lazy page imports — subtask 5 creates these files.
// tsc would normally flag missing modules; we use @ts-expect-error to let the
// type-checker pass while keeping the runtime import lazy.
// ─────────────────────────────────────────────────────────────────────────────

const OverviewPage = lazy(() => import('./pages/OverviewPage.js'));
const SessionsPage = lazy(() => import('./pages/SessionsPage.js'));
const ModelsPage = lazy(() => import('./pages/ModelsPage.js'));
const FullReportPage = lazy(() => import('./pages/FullReportPage.js'));

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

const sessionsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/sessions',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <SessionsPage />
    </Suspense>
  ),
});

const modelsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/models',
  component: () => (
    <Suspense fallback={<PageFallback />}>
      <ModelsPage />
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

const routeTree = rootRoute.addChildren([
  layoutRoute.addChildren([overviewRoute, sessionsRoute, modelsRoute, reportRoute]),
]);

export const router = createRouter({ routeTree });

// Augment TanStack Router's type registry so it knows about our router.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
