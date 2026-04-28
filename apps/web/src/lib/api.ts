/**
 * Typed async fetch wrappers for the Tokenomix API.
 *
 * These are plain async functions — NOT TanStack Query hooks.
 * Hooks (useQuery / useMutation) live in panel components (subtask 5).
 *
 * Base URL is '' (empty string) so all requests go through the Vite proxy
 * which forwards /api → http://127.0.0.1:{PORT_BASE+1}.
 */

import type { MetricSummary, MetricsQuery, SessionSummary } from '@tokenomix/shared';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a URL query string from an object, omitting undefined values.
 * Does NOT install any external dependency — purely inline.
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/**
 * Minimal fetch wrapper that throws a descriptive error on non-2xx responses.
 */
async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`API ${path} returned ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET /api/metrics
 *
 * Returns MetricSummary with flat all-time fields, windowed fields, series arrays,
 * and retro forward-compatibility stubs.
 */
export async function fetchMetrics(query: MetricsQuery): Promise<MetricSummary> {
  const qs = buildQuery({ since: query.since, project: query.project });
  return apiFetch<MetricSummary>(`/api/metrics${qs}`);
}

/**
 * GET /api/sessions
 *
 * Returns an array of SessionSummary objects, optionally limited.
 * The `limit` parameter controls the max number of sessions returned.
 */
export async function fetchSessions(
  query: MetricsQuery & { limit?: number }
): Promise<SessionSummary[]> {
  const qs = buildQuery({
    since: query.since,
    project: query.project,
    limit: query.limit,
  });
  return apiFetch<SessionSummary[]>(`/api/sessions${qs}`);
}

/**
 * GET /api/health
 *
 * Returns a lightweight health check object.
 * Throws on non-2xx (server unreachable or in error state).
 */
export async function fetchHealth(): Promise<{
  ok: boolean;
  projectsDir: string;
  isReady: boolean;
  indexedRows: number;
  lastUpdated: string;
}> {
  return apiFetch<{
    ok: boolean;
    projectsDir: string;
    isReady: boolean;
    indexedRows: number;
    lastUpdated: string;
  }>('/api/health');
}
