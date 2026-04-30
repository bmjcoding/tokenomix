/**
 * GET /api/health
 *
 * Returns server readiness and index statistics.
 *
 * Response shape:
 *   { ok: boolean; projectsDir: string; isReady: boolean; indexedRows: number; lastUpdated: string;
 *     lastRescanTs: string | null } — lastRescanTs is the formatted local ISO of the most recent
 *     successful RescanScheduler tick completion, or null if no successful tick has occurred yet.
 *
 * Status codes:
 *   200 — server is fully ready. Criteria (ALL must be true):
 *            1. store.isReady() === true (startup scan has completed)
 *            2. PROJECTS_DIR exists on disk OR indexedRows > 0 (data source is accessible
 *               or was previously indexed). This lets a process supervisor or load balancer
 *               distinguish a healthy, indexed server from one still initialising or one
 *               that found no data source at all.
 *   503 — any of the above criteria fails:
 *            - store.isReady() is false (startup scan still in progress), or
 *            - PROJECTS_DIR is missing on disk AND indexedRows === 0 (scan produced nothing
 *              because there is no data source).
 */

import * as fs from 'node:fs';
import { Hono } from 'hono';
import type { IndexStore, RescanScheduler } from '../index-store.js';
import { PROJECTS_DIR } from '../index-store.js';
import { formatLocalIso } from '../time.js';

export function healthRoute(store: IndexStore, scheduler: RescanScheduler): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const indexedRows = store.indexedRows;
    const isReady = store.isReady();
    const lastUpdated = formatLocalIso(new Date(store.lastChangeTs));

    // Emit the epoch ms of the last successful tick as a formatted local ISO
    // string, or null before the first successful tick has completed.
    const lastRescanTsEpoch = scheduler.lastRescanTs;
    const lastRescanTs = lastRescanTsEpoch > 0 ? formatLocalIso(new Date(lastRescanTsEpoch)) : null;

    // Determine if PROJECTS_DIR exists on disk.
    let projectsDirExists = false;
    try {
      fs.accessSync(PROJECTS_DIR, fs.constants.R_OK);
      projectsDirExists = true;
    } catch {
      projectsDirExists = false;
    }

    // Return 503 unless BOTH conditions hold:
    //   1. Initialization has completed (isReady).
    //   2. Data source is accessible (PROJECTS_DIR exists OR rows already indexed).
    const ok = isReady && (projectsDirExists || indexedRows > 0);
    const status = ok ? 200 : 503;

    return c.json(
      {
        ok,
        projectsDir: PROJECTS_DIR,
        isReady,
        indexedRows,
        lastUpdated,
        lastRescanTs,
      },
      status
    );
  });

  return app;
}
