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
 * GET /api/sessions/active
 *
 * Returns sessions whose last activity falls within a recent time window,
 * sorted by lastTs descending (most-recently-active first). This surfaces
 * recent sessions that would otherwise be truncated when many expensive
 * historical sessions exist in the costUsd-sorted list.
 *
 * Query params:
 *   windowMs — activity window in milliseconds (default: 300_000 / 5 min,
 *               capped at 86_400_000 / 24 h). Must be a positive integer.
 *   limit    — max sessions to return (default: 10, capped at 100). Must be a
 *               positive integer.
 *
 * Returns SessionSummary[] (same shape as GET /api/sessions).
 * Returns 400 with { error: string } when params are invalid.
 *
 * GET /api/sessions/:id
 *
 * Returns the full SessionDetail for a single session.
 * Path params:
 *   id — session ID (non-empty, max 200 chars, allowlist chars only)
 *
 * Returns 404 with { error: string } when the session is not found.
 * Returns 400 with { error: string } for invalid/unsafe id param values.
 *
 * POST /api/sessions/:id/reveal
 *
 * Opens the session's JSONL file in the OS file manager (Finder on macOS,
 * Explorer on Windows, xdg-open on Linux). Returns 204 No Content on success.
 * Requires X-Tokenomix-Local-Action: 1. Returns 500 with { error: string }
 * when the spawn fails. Returns 404 when the session has no recorded JSONL path.
 */

import { spawn } from 'node:child_process';
import * as nodePath from 'node:path';
import type { MetricsQuery, SessionDetail, SessionSummary } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';
import { logEvent } from '../logger.js';
import { hasLocalActionHeader } from './local-action.js';
import { parsePositiveIntegerParam } from './query-params.js';

const MAX_PARAM_LEN = 200;
// Allowlist: Claude session IDs are UUIDs/slugs — only safe identifier chars permitted.
// This rejects NULL bytes, path separators, unicode separators, and all other
// non-identifier characters in a single check (preferred over an enumerated denylist).
const SAFE_ID_RE = /^[A-Za-z0-9_\-.:@]+$/;

const ACTIVE_WINDOW_DEFAULT_MS = 300_000; // 5 minutes
const ACTIVE_WINDOW_MAX_MS = 86_400_000; // 24 hours
const ACTIVE_LIMIT_DEFAULT = 10;
const ACTIVE_LIMIT_MAX = 100;

/**
 * Validate a session ID path parameter.
 * Returns the id string when valid, or null when the value is absent,
 * oversized, or contains non-allowlist characters.
 */
function validateId(id: string | undefined): string | null {
  if (!id || id.length === 0 || id.length > MAX_PARAM_LEN || !SAFE_ID_RE.test(id)) {
    return null;
  }
  return id;
}

export function sessionsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const limitParam = c.req.query('limit');
    const project = c.req.query('project');
    const since = c.req.query('since');

    const parsedLimit = parsePositiveIntegerParam(limitParam);
    if (parsedLimit === null) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }
    const limit = Math.min(parsedLimit ?? 50, 500);

    const query: MetricsQuery = {};
    if (since) query.since = since;
    if (project) query.project = project;

    const sessions: SessionSummary[] = store.getSessions(query).slice(0, limit);
    return c.json(sessions);
  });

  app.get('/active', (c) => {
    const windowParam = c.req.query('windowMs');
    const limitParam = c.req.query('limit');

    // Validate windowMs: must be a positive integer when provided.
    let windowMs = ACTIVE_WINDOW_DEFAULT_MS;
    if (windowParam !== undefined) {
      const parsed = parsePositiveIntegerParam(windowParam);
      if (parsed === null || parsed === undefined) {
        return c.json({ error: 'windowMs must be a positive integer' }, 400);
      }
      if (parsed > ACTIVE_WINDOW_MAX_MS) {
        return c.json({ error: `windowMs must not exceed ${ACTIVE_WINDOW_MAX_MS} (24 h)` }, 400);
      }
      windowMs = parsed;
    }

    // Validate limit: must be a positive integer in [1, 100] when provided.
    let limit = ACTIVE_LIMIT_DEFAULT;
    if (limitParam !== undefined) {
      const parsed = parsePositiveIntegerParam(limitParam);
      if (parsed === null || parsed === undefined) {
        return c.json({ error: 'limit must be a positive integer' }, 400);
      }
      if (parsed > ACTIVE_LIMIT_MAX) {
        return c.json({ error: `limit must not exceed ${ACTIVE_LIMIT_MAX}` }, 400);
      }
      limit = parsed;
    }

    const sessions: SessionSummary[] = store.getActiveSessions(windowMs, limit);
    logEvent('info', 'sessions_active', { windowMs, limit, count: sessions.length });
    return c.json(sessions);
  });

  app.get('/:id', (c) => {
    const id = validateId(c.req.param('id'));

    if (!id) {
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

  /**
   * POST /api/sessions/:id/reveal
   *
   * Opens the session's JSONL file in the OS file manager and returns 204.
   * Uses spawn (not exec) so the path is passed as a separate argv element —
   * no shell interpolation, no injection risk.
   *
   * Returns 500 with { error } when spawn emits an error event (e.g. the OS
   * file manager command is not found or not executable).
   *
   * Does NOT log the path — it may contain sensitive directory names.
   */
  app.post('/:id/reveal', async (c) => {
    if (!hasLocalActionHeader(c)) {
      return c.json({ error: 'local action header required' }, 403);
    }

    const id = validateId(c.req.param('id'));

    if (!id) {
      return c.json({ error: 'invalid param' }, 400);
    }

    const jsonlPath = store.getJsonlPathForSession(id);

    if (jsonlPath === null) {
      logEvent('info', 'session_reveal', { sessionId: id, found: false });
      return c.json({ error: 'session not found' }, 404);
    }

    let cmd: string;
    let args: string[];

    if (process.platform === 'darwin') {
      cmd = 'open';
      args = ['-R', jsonlPath];
    } else if (process.platform === 'win32') {
      cmd = 'explorer.exe';
      // /select, must be a single argument with the comma attached; path is separate.
      args = ['/select,', jsonlPath];
    } else {
      // Linux: file managers don't reliably support "select-and-reveal", so open
      // the parent directory instead.
      cmd = 'xdg-open';
      args = [nodePath.dirname(jsonlPath)];
    }

    const REVEAL_TIMEOUT_MS = 10_000; // 10 s — file manager should ack quickly

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        const timer = setTimeout(() => {
          child.unref();
          reject(new Error(`file manager did not respond within ${REVEAL_TIMEOUT_MS} ms`));
        }, REVEAL_TIMEOUT_MS);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', () => {
          clearTimeout(timer);
          child.unref();
          resolve();
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent('warn', 'session_reveal_failed', { sessionId: id, err: message });
      return c.json({ error: `Failed to open file manager: ${message}` }, 500);
    }

    logEvent('info', 'session_reveal', { sessionId: id, platform: process.platform });
    return new Response(null, { status: 204 });
  });

  return app;
}
