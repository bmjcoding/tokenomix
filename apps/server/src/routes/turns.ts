/**
 * GET /api/turns
 *
 * Returns the top N most expensive assistant turns as TurnBucket[],
 * sorted by costUsd descending.
 *
 * Query params:
 *   since   — ISO date string or relative "Nd" / integer days (optional)
 *             Sentinel 'all' is treated as no filter (same as omitting since).
 *   limit   — max turns to return (default: 10, capped at 50)
 *   project — project path substring filter (optional)
 *
 * Each entry in the response corresponds to one TokenRow (one assistant turn).
 * The timestamp field uses hour-level precision (YYYY-MM-DDTHH:00:00), which
 * is the granularity available without storing full epoch ms in TokenRow.
 */

import type { MetricsQuery, TurnBucket } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';

export function turnsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const limitParam = c.req.query('limit');
    const since = c.req.query('since');
    const project = c.req.query('project');

    // Reject query params that exceed the maximum allowed length (200 chars)
    // to prevent log pollution and potential ReDoS from crafted patterns.
    const MAX_PARAM_LEN = 200;
    if ((since && since.length > MAX_PARAM_LEN) || (project && project.length > MAX_PARAM_LEN)) {
      return c.json({ error: 'invalid param' }, 400);
    }

    // Cap limit at 50; default 10.
    const limit = limitParam
      ? Math.min(Math.max(1, Number.parseInt(limitParam, 10) || 10), 50)
      : 10;

    const query: MetricsQuery = {};
    // 'all' is a sentinel meaning no time filter — treat as absent.
    if (since && since !== 'all') query.since = since;
    if (project) query.project = project;

    const turns: TurnBucket[] = store.getTurns(query, limit);
    return c.json(turns);
  });

  return app;
}
