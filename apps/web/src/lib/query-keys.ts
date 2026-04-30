/**
 * TanStack Query cache-key factory for Tokenomix.
 *
 * Keys are stable `readonly unknown[]` arrays.  They start with the route
 * name string so invalidation by prefix (e.g. queryClient.invalidateQueries
 * ({ queryKey: ['metrics'] })) works correctly.
 *
 * Consumers (subtask 5 panels) import from this file and never construct keys
 * inline — keeping cache semantics consistent across the whole app.
 */

import type { MetricsQuery } from '@tokenomix/shared';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const queryKeys = {
  /**
   * Cache key for fetchMetrics(query).
   * Includes the full query object so different filter combos get independent
   * cache entries.
   */
  metrics(query: MetricsQuery): readonly unknown[] {
    return ['metrics', query] as const;
  },

  /**
   * Cache key for fetchSessions(query).
   * `limit` is part of the key so different page sizes are cached separately.
   */
  sessions(query: MetricsQuery & { limit?: number }): readonly unknown[] {
    return ['sessions', query] as const;
  },

  /**
   * Cache key for fetchHealth().
   * Health has no query parameters, so the key is always the same tuple.
   */
  health(): readonly unknown[] {
    return ['health'] as const;
  },

  recommendationChatStatus(): readonly unknown[] {
    return ['recommendationChatStatus'] as const;
  },

  /**
   * Cache key for fetchTurns(params).
   * Tuple format: ['turns', params] — T-006 invalidates by prefix ['turns'].
   */
  turns(params: { since?: string; project?: string; limit?: number }): readonly unknown[] {
    return ['turns', params] as const;
  },

  /**
   * Cache key for fetchSessionDetail(sessionId).
   * Tuple format: ['session', sessionId] — invalidate by prefix ['session'].
   */
  sessionDetail(sessionId: string): readonly [string, string] {
    return ['session', sessionId] as const;
  },
} as const;
