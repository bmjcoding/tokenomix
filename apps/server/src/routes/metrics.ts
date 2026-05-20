/**
 * GET /api/metrics
 *
 * Query params:
 *   since   — ISO date string or relative "Nd" / integer days (optional)
 *   project — project path substring filter (optional)
 *   provider — claude-code | codex | local-models | all (optional)
 *
 * Returns MetricSummary with flat all-time totals, windowed totals,
 * series arrays, and retro stubs (null / []).
 */

import type { MetricSummary, MetricsQuery } from '@tokenomix/shared';
import { Hono } from 'hono';
import type { IndexStore } from '../index-store.js';
import { parseUsageProviderFilterParam } from './query-params.js';

export function metricsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const since = c.req.query('since');
    const project = c.req.query('project');
    const provider = c.req.query('provider');

    const query: MetricsQuery = {};
    if (since) query.since = since;
    if (project) query.project = project;
    const parsedProvider = parseUsageProviderFilterParam(provider);
    if (parsedProvider === null) return c.json({ error: 'invalid provider' }, 400);
    if (parsedProvider && parsedProvider !== 'all') {
      query.provider = parsedProvider;
    }

    const summary: MetricSummary = store.getMetrics(query);
    return c.json(summary);
  });

  return app;
}
