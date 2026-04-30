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
 *
 * POST /api/sessions/:id/reveal
 *
 * Opens the session's JSONL file in the OS file manager (Finder on macOS,
 * Explorer on Windows, xdg-open on Linux). Returns 204 No Content on success
 * or when spawn fails (the caller cannot recover). Returns 404 when the
 * session has no recorded JSONL path.
 */

import { spawn } from 'node:child_process';
import * as nodePath from 'node:path';
import type { MetricsQuery, SessionDetail, SessionSummary } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';
import { logEvent } from '../logger.js';

const MAX_PARAM_LEN = 200;
// Allowlist: Claude session IDs are UUIDs/slugs — only safe identifier chars permitted.
// This rejects NULL bytes, path separators, unicode separators, and all other
// non-identifier characters in a single check (preferred over an enumerated denylist).
const SAFE_ID_RE = /^[A-Za-z0-9_\-.:@]+$/;

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

    const limit = limitParam
      ? Math.min(Math.max(1, Number.parseInt(limitParam, 10) || 50), 500)
      : 50;

    const query: MetricsQuery = {};
    if (since) query.since = since;
    if (project) query.project = project;

    const sessions: SessionSummary[] = store.getSessions(query).slice(0, limit);
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
   * Does NOT log the path — it may contain sensitive directory names.
   */
  app.post('/:id/reveal', (c) => {
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

    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      logEvent('warn', 'session_reveal_failed', { sessionId: id, err: err.message });
    });
    child.unref();

    logEvent('info', 'session_reveal', { sessionId: id, platform: process.platform });
    return new Response(null, { status: 204 });
  });

  return app;
}
