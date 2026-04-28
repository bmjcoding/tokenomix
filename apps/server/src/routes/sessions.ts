/**
 * GET /api/sessions
 *
 * Query params:
 *   limit   — max sessions to return (default: 50, capped at 500)
 *   project — project path substring filter (optional)
 *   since   — ISO date string or relative "Nd" / integer days (optional)
 *
 * Returns SessionSummary[] sorted by costUsd descending.
 */

import type { MetricsQuery, SessionSummary } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';

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

  return app;
}
