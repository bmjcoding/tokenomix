/**
 * Typed async fetch wrappers for the Tokenomix API.
 *
 * These are plain async functions — NOT TanStack Query hooks.
 * Hooks (useQuery / useMutation) live in panel components (subtask 5).
 *
 * Base URL is '' (empty string) so all requests go through the Vite proxy
 * which forwards /api → http://127.0.0.1:{PORT_BASE+1}.
 */

import type {
  MetricSummary,
  MetricsQuery,
  RecommendationChatMessage,
  RecommendationChatResponse,
  RecommendationChatStatus,
  SessionDetail,
  SessionSummary,
  TurnBucket,
} from '@tokenomix/shared';

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
async function responseErrorMessage(res: Response, path: string): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      // Fall through to raw text.
    }
    return `API ${path} returned ${res.status}: ${text}`;
  }
  return `API ${path} returned ${res.status}: ${res.statusText}`;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, path));
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, path));
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

export async function fetchRecommendationChatStatus(): Promise<RecommendationChatStatus> {
  return apiFetch<RecommendationChatStatus>('/api/recommendations/chat/status');
}

export async function sendRecommendationChat(params: {
  message: string;
  history: RecommendationChatMessage[];
}): Promise<RecommendationChatResponse> {
  return apiPost<RecommendationChatResponse>('/api/recommendations/chat', params);
}

type RecommendationChatStreamEvent =
  | { type: 'start'; sessionSeeded: boolean }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: RecommendationChatResponse }
  | { type: 'error'; error: string };

export async function streamRecommendationChat(
  params: { message: string },
  handlers: {
    onStart?: (sessionSeeded: boolean) => void;
    onDelta: (text: string) => void;
    onDone: (response: RecommendationChatResponse) => void;
    onError: (message: string) => void;
  }
): Promise<void> {
  const res = await fetch('/api/recommendations/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    handlers.onError(await responseErrorMessage(res, '/api/recommendations/chat/stream'));
    return;
  }
  if (!res.body) {
    handlers.onError('Chat stream did not return a response body.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function handleChunk(chunk: string): void {
    buffer = (buffer + chunk).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) handleEvent(data);
      boundary = buffer.indexOf('\n\n');
    }
  }

  function flushRemainder(): void {
    const rawEvent = buffer.trim();
    buffer = '';
    if (!rawEvent) return;
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) handleEvent(data);
  }

  function handleEvent(data: string): void {
    let parsed: RecommendationChatStreamEvent;
    try {
      parsed = JSON.parse(data) as RecommendationChatStreamEvent;
    } catch {
      return;
    }

    if (parsed.type === 'start') {
      handlers.onStart?.(parsed.sessionSeeded);
    } else if (parsed.type === 'delta') {
      handlers.onDelta(parsed.text);
    } else if (parsed.type === 'done') {
      handlers.onDone(parsed.result);
    } else if (parsed.type === 'error') {
      handlers.onError(parsed.error);
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handleChunk(decoder.decode(value, { stream: true }));
    }
    handleChunk(decoder.decode());
    flushRemainder();
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : 'Chat stream failed.');
  }
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
 * GET /api/turns
 *
 * Returns an array of TurnBucket objects sorted by costUsd descending.
 * The `limit` parameter controls the max number of turns returned (default 10, max 50 on server).
 * The `since` parameter accepts the same values as MetricsQuery.since.
 */
export async function fetchTurns(
  params: { since?: string; project?: string; limit?: number } = {}
): Promise<TurnBucket[]> {
  const qs = buildQuery({
    since: params.since,
    project: params.project,
    limit: params.limit,
  });
  return apiFetch<TurnBucket[]>(`/api/turns${qs}`);
}

/**
 * GET /api/sessions/:sessionId
 *
 * Returns a SessionDetail object for the given session.
 * Throws on non-2xx (404 when session not found, 400 for invalid id).
 */
export async function fetchSessionDetail(sessionId: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * POST /api/sessions/:sessionId/reveal
 *
 * Asks the server to reveal the session's JSONL file in the OS file manager
 * (e.g. Finder on macOS). Returns void on success (204).
 * Throws on non-2xx.
 */
export async function revealSessionJsonl(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reveal`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`reveal failed: ${res.status}`);
  }
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
  lastRescanTs: string | null;
}> {
  return apiFetch<{
    ok: boolean;
    projectsDir: string;
    isReady: boolean;
    indexedRows: number;
    lastUpdated: string;
    lastRescanTs: string | null;
  }>('/api/health');
}
