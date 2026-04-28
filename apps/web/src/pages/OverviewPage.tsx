/**
 * OverviewPage — main dashboard view.
 *
 * Architecture:
 * - Owns the single useQuery call for MetricSummary (since='all').
 * - Passes MetricSummary down as props to all prop-driven panels:
 *   HeroSpend, KpiRow, AreaChartPanel.
 * - HeatmapPanel, ModelMixPanel, and TopSessionsTable self-fetch via their
 *   own useQuery calls — they receive no data prop.
 * - useServerEvents() SSE hook is mounted here for live cache invalidation.
 * - Period state is lifted to this page and passed to AreaChartPanel.
 *
 * Layout (top to bottom):
 *   1. HeroSpend  — full-width hero, Current Spend (MTD)
 *   2. KpiRow     — four KPI cards: Tokens, Cache Efficiency, Sessions, Avg Duration
 *   3. AreaChartPanel — spend-over-time chart with period switcher + actions
 *   4. Two-column grid: HeatmapPanel (left) + ModelMixPanel (right)
 *   5. TopSessionsTable (top 10 by cost)
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { useServerEvents } from '../lib/useServerEvents.js';
import { AreaChartPanel } from '../panels/AreaChartPanel.js';
import { HeatmapPanel } from '../panels/HeatmapPanel.js';
import { HeroSpend } from '../panels/HeroSpend.js';
import { KpiRow } from '../panels/KpiRow.js';
import { ModelMixPanel } from '../panels/ModelMixPanel.js';
import type { DashboardPeriod } from '../panels/PeriodSwitcher.js';
import { TopSessionsTable } from '../panels/TopSessionsTable.js';

export default function OverviewPage() {
  // SSE live refresh — invalidates TanStack Query cache on 'updated' events.
  useServerEvents();

  // Single source of truth for the chart period switcher.
  const [period, setPeriod] = useState<DashboardPeriod>('30d');

  // Single useQuery for MetricSummary — all prop-driven panels share this result.
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since: 'all' }),
    queryFn: () => fetchMetrics({ since: 'all' }),
  });

  const containerCls = 'space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl';

  // Loading state — inline spinner text matching ModelsPage convention.
  if (isLoading || !data) {
    return (
      <div className={containerCls}>
        <div className="flex items-center justify-center py-24">
          <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>
        </div>
      </div>
    );
  }

  // Error state — inline error message matching ModelsPage convention.
  if (isError) {
    return (
      <div className={containerCls}>
        <div className="flex items-center justify-center py-24">
          <span className="text-sm text-red-500 dark:text-red-400">
            Failed to load dashboard data.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={containerCls}>
      {/* 1. Hero — Current Spend (MTD) */}
      <HeroSpend data={data} />

      {/* 2. KPI row — Tokens / Cache Efficiency / Sessions / Avg Session Duration */}
      <KpiRow data={data} />

      {/* 3. Area chart with period switcher, Export, and View full report */}
      <AreaChartPanel data={data} period={period} onPeriodChange={setPeriod} />

      {/* 4. Heatmap + Model mix — two-column grid (stacked on small viewports) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <HeatmapPanel />
        <ModelMixPanel />
      </div>

      {/* 5. Top 10 sessions by cost */}
      <TopSessionsTable limit={10} />
    </div>
  );
}
