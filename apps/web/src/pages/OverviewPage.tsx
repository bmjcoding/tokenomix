/**
 * OverviewPage — main dashboard view.
 *
 * Architecture:
 * - Owns the single useQuery call for MetricSummary (since='all').
 * - Passes MetricSummary down as props to all prop-driven panels:
 *   HeroSpend, KpiRow, KpiRow2, AreaChartPanel.
 * - HeatmapPanel, ModelMixPanel, ToolsBreakdownPanel, SubagentLeaderboard,
 *   TopSessionsTable, and TopExpensiveTurnsTable self-fetch via their own
 *   useQuery calls — they receive no data prop (except KpiRow2 which is
 *   prop-driven like KpiRow).
 * - useServerEvents() SSE hook is mounted here for live cache invalidation.
 * - Period state is lifted to this page and passed to AreaChartPanel.
 *
 * Layout (top to bottom):
 *   1. HeroSpend              — full-width hero, Current Spend (MTD)
 *   2. KpiRow                 — TOKENS · 30D w/ delta, Cost/Output Token, Turn P90 Cost, Cost WoW Delta
 *   3. KpiRow2                — Projects Touched, Avg Cost/Turn; optional Worst-Tool Error (hidden when none)
 *   3a. OptimizationSignals   — P90 Session Duration; optional Subagent Success Rate + Top Project
 *   4. AreaChartPanel         — spend-over-time chart with period switcher + actions
 *   5. Three-column grid: HeatmapPanel + ModelMixPanel + ToolsBreakdownPanel (hidden when no tool data)
 *   6. TopSessionsTable (top 10 by cost)
 *   7. Two-column grid: SubagentLeaderboard + TopExpensiveTurnsTable (Agent & Turn Breakdown)
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
import { KpiRow2 } from '../panels/KpiRow2.js';
import { ModelMixPanel } from '../panels/ModelMixPanel.js';
import { OptimizationSignalsPanel } from '../panels/OptimizationSignalsPanel.js';
import type { DashboardPeriod } from '../panels/PeriodSwitcher.js';
import { SubagentLeaderboard } from '../panels/SubagentLeaderboard.js';
import { ToolsBreakdownPanel } from '../panels/ToolsBreakdownPanel.js';
import { TopExpensiveTurnsTable } from '../panels/TopExpensiveTurnsTable.js';
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

      {/* 2. KPI row — TOKENS · 30D / Cost per Output Token / Turn P90 Cost / Cost WoW Delta */}
      <KpiRow data={data} />

      {/* 3. KPI row 2 — Projects Touched / Avg Cost per Turn / Worst-Tool Error (conditional) */}
      <KpiRow2 data={data} />

      {/* 3a. Optimization Signals — P90 session duration, subagent success rate, top project */}
      <OptimizationSignalsPanel data={data} />

      {/* 4. Area chart with period switcher, Export, and View full report */}
      <AreaChartPanel data={data} period={period} onPeriodChange={setPeriod} />

      {/* 5. Heatmap + Model mix + Tools breakdown — three-column grid (stacked on small viewports) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <HeatmapPanel />
        <ModelMixPanel />
        <ToolsBreakdownPanel since="30d" />
      </div>

      {/* 6. Top 10 sessions by cost */}
      <TopSessionsTable limit={10} />

      {/* 7. Agent & Turn Breakdown — two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SubagentLeaderboard since="30d" />
        <TopExpensiveTurnsTable limit={10} since="30d" />
      </div>
    </div>
  );
}
