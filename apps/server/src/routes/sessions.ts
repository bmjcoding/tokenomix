/**
 * GET /api/sessions
 *
 * Query params:
 *   limit   — max sessions to return (default: 50, capped at 500)
 *   project — project path substring filter (optional)
 *   since   — ISO date string or relative "Nd" / integer days (optional)
 *
 * Returns SessionSummary[] sorted by costUsd descending.
 *
 * GET /api/sessions/:id
 *
 * Returns the full SessionDetail for a single session.
 * Path params:
 *   id — session ID (non-empty, max 200 chars, allowlist chars only)
 *
 * Returns 404 with { error: string } when the session is not found.
 * Returns 400 with { error: string } for invalid/unsafe id param values.
 */

import type { MetricsQuery, SessionDetail, SessionSummary } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';
import { logEvent } from '../logger.js';

const MAX_PARAM_LEN = 200;
// Allowlist: Claude session IDs are UUIDs/slugs — only safe identifier chars permitted.
// This rejects NULL bytes, path separators, unicode separators, and all other
// non-identifier characters in a single check (preferred over an enumerated denylist).
const SAFE_ID_RE = /^[A-Za-z0-9_\-.:@]+$/;

export function sessionsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const limitParam = c.req.query('limit');
    const project = c.req.query('project');
    const since = c.req.query('since');

    const limit = limitParam ? Math.min(Number.parseInt(limitParam, 10) || 50, 500) : 50;

    const query: MetricsQuery = {};
    if (since) query.since = since;
    if (project) query.project = project;

    const sessions: SessionSummary[] = store.getSessions(query).slice(0, limit);
    return c.json(sessions);
  });

  app.get('/:id', (c) => {
    const id = c.req.param('id');

    // Guard: reject empty, oversized, or non-allowlist id values.
    // SAFE_ID_RE also implicitly rejects NULL bytes, path separators (/\),
    // unicode separators, and any other non-identifier characters.
    if (!id || id.length === 0 || id.length > MAX_PARAM_LEN || !SAFE_ID_RE.test(id)) {
      return c.json({ error: 'invalid param' }, 400);
    }

    const t0 = performance.now();
    const detail: SessionDetail | null = store.getSessionDetail(id);
    const durationMs = Math.round(performance.now() - t0);

    if (!detail) {
      logEvent('info', 'session_detail', { sessionId: id, found: false, durationMs });
      return c.json({ error: 'session not found' }, 404);
    }

    logEvent('info', 'session_detail', { sessionId: id, found: true, durationMs });
    return c.json(detail);
  });

  return app;
}
