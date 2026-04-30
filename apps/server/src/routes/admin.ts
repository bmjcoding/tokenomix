/**
 * POST /api/admin/rescan
 *
 * Triggers a full mtime-based rescan of all known JSONL files without
 * restarting the server. On each invocation the RescanScheduler stats every
 * file under PROJECTS_DIR, compares the current mtime against its cached
 * value, and calls ingestFile() only on files whose mtime has advanced.
 *
 * No authentication is required because the server binds exclusively to
 * 127.0.0.1 — only local processes can reach this endpoint.
 *
 * Response shape:
 *   { ok: true; ts: number }   — ts is Date.now() at the time of response
 */

import { Hono } from 'hono';
import type { RescanScheduler } from '../index-store.js';

export function adminRoute(scheduler: RescanScheduler): Hono {
  const app = new Hono();

  app.post('/rescan', async (c) => {
    await scheduler.tick();
    return c.json({ ok: true, ts: Date.now() });
  });

  return app;
}
