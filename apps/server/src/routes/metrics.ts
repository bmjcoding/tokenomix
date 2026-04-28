/**
 * GET /api/metrics
 *
 * Query params:
 *   since   — ISO date string or relative "Nd" / integer days (optional)
 *   project — project path substring filter (optional)
 *
 * Returns MetricSummary with flat all-time totals, windowed totals,
 * series arrays, and retro stubs (null / []).
 */

import type { MetricSummary, MetricsQuery } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';

export function metricsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const since = c.req.query('since');
    const project = c.req.query('project');

    const query: MetricsQuery = {};
    if (since) query.since = since;
    if (project) query.project = project;

    const summary: MetricSummary = store.getMetrics(query);
    return c.json(summary);
  });

  return app;
}
