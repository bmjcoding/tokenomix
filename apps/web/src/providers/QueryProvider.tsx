import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api.js';

/** A 503 from the API means the server is still building its startup index. */
function isIndexingError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

/**
 * QueryProvider — wraps the app in TanStack Query's QueryClientProvider.
 *
 * Default options:
 *   - staleTime: 30 s (data is considered fresh for 30 seconds)
 *   - refetchOnWindowFocus: false (avoids disruptive refetches on tab switch)
 *   - retry: 1 for real failures; while the server is still indexing (503),
 *     retry up to 60× at 1 s spacing so panels stay in their loading state
 *     instead of rendering partial data.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        isIndexingError(error) ? failureCount < 60 : failureCount < 1,
      retryDelay: (failureCount, error) =>
        isIndexingError(error) ? 1_000 : Math.min(1_000 * 2 ** failureCount, 30_000),
    },
  },
});

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
