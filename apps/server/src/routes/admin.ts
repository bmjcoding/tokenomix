/**
 * POST /api/admin/rescan
 *
 * Triggers a full mtime-based rescan of all known JSONL files without
 * restarting the server. On each invocation the RescanScheduler stats every
 * file under PROJECTS_DIR, compares the current mtime against its cached
 * value, and calls ingestFile() only on files whose mtime has advanced.
 *
 * Requires X-Tokenomix-Local-Action: 1. The server binds exclusively to
 * 127.0.0.1, and the custom header blocks blind cross-site localhost POSTs.
 *
 * Response shape:
 *   { ok: true; ts: number }   — ts is Date.now() at the time of response
 */

import { Hono } from 'hono';
import type { RescanScheduler } from '../rescan-scheduler.js';
import { hasLocalActionHeader } from './local-action.js';

export function adminRoute(scheduler: RescanScheduler): Hono {
  const app = new Hono();

  app.post('/rescan', async (c) => {
    if (!hasLocalActionHeader(c)) {
      return c.json({ error: 'local action header required' }, 403);
    }
    await scheduler.tick();
    return c.json({ ok: true, ts: Date.now() });
  });

  return app;
}
