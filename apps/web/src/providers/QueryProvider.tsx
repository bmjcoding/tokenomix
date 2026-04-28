import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * QueryProvider — wraps the app in TanStack Query's QueryClientProvider.
 *
 * Default options:
 *   - staleTime: 30 s (data is considered fresh for 30 seconds)
 *   - refetchOnWindowFocus: false (avoids disruptive refetches on tab switch)
 *   - retry: 1 (one retry on failure before surfacing an error state)
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
