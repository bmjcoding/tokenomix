/**
 * OverviewPage — main dashboard view, broken into 4 navigable tabs.
 *
 * Architecture:
 * - Owns the single useQuery call for MetricSummary (since='all').
 * - Passes MetricSummary down as props to all prop-driven panels:
 *   HeroSpend, CostDriversPanel, KpiRow, KpiRow2, OptimizationOpportunitiesPanel,
 *   OptimizationSignalsPanel, AreaChartPanel.
 * - Self-fetching panels (HeatmapPanel, ModelMixPanel, ToolsBreakdownPanel,
 *   SubagentLeaderboard, TopSessionsTable, TopExpensiveTurnsTable) mount only
 *   when their tab is active — their useQuery hooks do not fire on inactive tabs.
 * - useServerEvents() SSE hook is mounted here for live cache invalidation.
 * - Period state is lifted to this page and passed to AreaChartPanel.
 * - Hash sync via Tabs: reloading with #recommendations lands on that tab.
 *
 * Tab structure:
 *   overview        — HeroSpend → CostDriversPanel → AreaChartPanel → KpiRow
 *   recommendations — OptimizationOpportunitiesPanel → OptimizationSignalsPanel → KpiRow2
 *   activity        — 3-col grid: HeatmapPanel + ModelMixPanel + ToolsBreakdownPanel
 *   sessions        — TopSessionsTable → 2-col grid: SubagentLeaderboard + TopExpensiveTurnsTable
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { useServerEvents } from '../lib/useServerEvents.js';
import { AreaChartPanel } from '../panels/AreaChartPanel.js';
import { CostDriversPanel } from '../panels/CostDriversPanel.js';
import { HeatmapPanel } from '../panels/HeatmapPanel.js';
import { HeroSpend } from '../panels/HeroSpend.js';
import { KpiRow } from '../panels/KpiRow.js';
import { KpiRow2 } from '../panels/KpiRow2.js';
import { ModelMixPanel } from '../panels/ModelMixPanel.js';
import { OptimizationOpportunitiesPanel } from '../panels/OptimizationOpportunitiesPanel.js';
import { OptimizationSignalsPanel } from '../panels/OptimizationSignalsPanel.js';
import type { DashboardPeriod } from '../panels/PeriodSwitcher.js';
import { SubagentLeaderboard } from '../panels/SubagentLeaderboard.js';
import { ToolsBreakdownPanel } from '../panels/ToolsBreakdownPanel.js';
import { TopExpensiveTurnsTable } from '../panels/TopExpensiveTurnsTable.js';
import { TopSessionsTable } from '../panels/TopSessionsTable.js';
import type { TabItem } from '../ui/Tabs.js';
import { Tabs } from '../ui/Tabs.js';

// ---------------------------------------------------------------------------
// Tab content components — each rendered only when its tab is active.
// Using separate components ensures clean unmount/mount lifecycle when
// switching tabs and avoids prop-drilling the MetricSummary through
// the Tabs abstraction.
// ---------------------------------------------------------------------------

interface OverviewTabProps {
  data: MetricSummary;
  period: DashboardPeriod;
  onPeriodChange: (next: DashboardPeriod) => void;
}

function OverviewTabContent({ data, period, onPeriodChange }: OverviewTabProps) {
  return (
    <div className="space-y-6 pt-6">
      {/* 1. Hero — Current Spend (MTD) */}
      <HeroSpend data={data} />

      {/* 2. Cost drivers — explains what is driving spend */}
      <CostDriversPanel data={data} />

      {/* 3. Spend over time — moved up per user request */}
      <AreaChartPanel data={data} period={period} onPeriodChange={onPeriodChange} />

      {/* 4. Key Metrics — moved up to sit with the overview data */}
      <KpiRow data={data} />
    </div>
  );
}

interface RecommendationsTabProps {
  data: MetricSummary;
}

function RecommendationsTabContent({ data }: RecommendationsTabProps) {
  return (
    <div className="space-y-6 pt-6">
      {/* 1. Ranked optimization experiments */}
      <OptimizationOpportunitiesPanel data={data} />

      {/* 2. Optimization Signals — P90 duration, subagent success, top project */}
      <OptimizationSignalsPanel data={data} />

      {/* 3. Usage Insights — Projects Touched / Avg Cost per Turn / Worst Tool Error */}
      <KpiRow2 data={data} />
    </div>
  );
}

function ActivityTabContent() {
  return (
    <div className="pt-6">
      {/* 3-column grid of activity charts — stacked on small viewports */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <HeatmapPanel />
        <ModelMixPanel />
        <ToolsBreakdownPanel since="30d" />
      </div>
    </div>
  );
}

function SessionsTabContent() {
  return (
    <div className="space-y-6 pt-6">
      {/* Top sessions by cost */}
      <TopSessionsTable limit={10} />

      {/* Agent & Turn Breakdown — two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SubagentLeaderboard since="30d" />
        <TopExpensiveTurnsTable limit={10} since="30d" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverviewPage
// ---------------------------------------------------------------------------

export default function OverviewPage() {
  // SSE live refresh — invalidates TanStack Query cache on 'updated' events.
  useServerEvents();

  // Period state lifted here so it persists across tab switches within the
  // session (but is not hashed — only the tab key is hashed).
  const [period, setPeriod] = useState<DashboardPeriod>('30d');

  // Single source of truth for MetricSummary — prop-driven panels share this.
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since: 'all' }),
    queryFn: () => fetchMetrics({ since: 'all' }),
  });

  const containerCls = 'py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl';

  // Loading state — show the tab shell immediately so chrome appears before data.
  // The tab content areas render the loading indicator inline.
  if (isLoading || !data) {
    return (
      <div className={containerCls}>
        <div className="flex items-center justify-center py-24">
          <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>
        </div>
      </div>
    );
  }

  // Error state.
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

  // ── Tab definitions ─────────────────────────────────────────────────────────
  // Each content block is a component call — inactive tabs are not rendered so
  // their useQuery hooks (HeatmapPanel, TopSessionsTable, etc.) don't fire.
  const tabItems: TabItem[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <OverviewTabContent data={data} period={period} onPeriodChange={setPeriod} />
      ),
    },
    {
      key: 'recommendations',
      label: 'Recommendations',
      content: <RecommendationsTabContent data={data} />,
    },
    {
      key: 'activity',
      label: 'Activity',
      content: <ActivityTabContent />,
    },
    {
      key: 'sessions',
      label: 'Sessions',
      content: <SessionsTabContent />,
    },
  ];

  return (
    <div className={containerCls}>
      <Tabs items={tabItems} defaultKey="overview" syncWithHash />
    </div>
  );
}
