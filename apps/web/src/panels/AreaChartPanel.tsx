/**
 * AreaChartPanel — prop-driven spend-over-time chart card.
 *
 * Receives pre-fetched MetricSummary from OverviewPage (single useQuery owner).
 * No internal useQuery or fetch. Period state is lifted to OverviewPage.
 *
 * Design decisions:
 * - Card header: "Spend over time" title (left) | PeriodSwitcher + Export + View full report (right).
 * - Period-to-series transform is pure client-side — AreaChart always receives DailyBucket[].
 * - 24h mode: synthetic DailyBucket[] built from heatmapData; xAxisLabelFormat slices HH:00.
 * - Export button is disabled + reduced-opacity when dailySeries is empty.
 * - View full report uses TanStack Router Link with a string literal to '/report'.
 *   The /report route is registered by subtask 8 (parallel group 3); type augmentation
 *   may not be present yet, so we suppress the type error inline.
 * - Existing Cost / Input / Output field toggle is preserved.
 */

import { Link } from '@tanstack/react-router';
import type { DailyBucket, MetricSummary } from '@tokenomix/shared';
import { Download, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { AreaChart, type AreaField } from '../charts/AreaChart.js';
import { exportDailySeriesCsv } from '../lib/csvExport.js';
import { getLast24hSeries, getYtdSeries } from '../lib/derive.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { type DashboardPeriod, PeriodSwitcher } from './PeriodSwitcher.js';

// ---------------------------------------------------------------------------
// Field toggle config (preserved from original)
// ---------------------------------------------------------------------------

const FIELD_OPTIONS: { value: AreaField; label: string }[] = [
  { value: 'costUsd', label: 'Cost' },
  { value: 'inputTokens', label: 'Input' },
  { value: 'outputTokens', label: 'Output' },
];

// ---------------------------------------------------------------------------
// 24h synthetic series builder
// ---------------------------------------------------------------------------

/**
 * Builds a synthetic DailyBucket[] from getLast24hSeries output.
 *
 * Each hourly point becomes a DailyBucket whose `date` field is an ISO
 * timestamp string `YYYY-MM-DDTHH:00:00`. AreaChart uses these strings as the
 * x-axis category data; the xAxisLabelFormat prop then slices `HH:00` via
 * `raw.slice(11, 16)` so each tick shows a different hour label.
 *
 * Non-cost token fields are zero because heatmapData only carries costUsd.
 */
function buildSyntheticDailyBuckets(heatmapData: MetricSummary['heatmapData']): DailyBucket[] {
  const hourPoints = getLast24hSeries(heatmapData);
  return hourPoints.map(({ date, hour, costUsd }) => {
    // Preserve the heatmap bucket date so 24h windows crossing midnight stay chronological.
    const hourStr = String(hour).padStart(2, '0');
    return {
      date: `${date}T${hourStr}:00:00`,
      costUsd,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Period → filtered series
// ---------------------------------------------------------------------------

function filterSeries(data: MetricSummary, period: DashboardPeriod): DailyBucket[] {
  switch (period) {
    case '24h':
      return buildSyntheticDailyBuckets(data.heatmapData);
    case '7d':
      return data.dailySeries.slice(-7);
    case '30d':
      return data.dailySeries.slice(-30);
    case 'ytd':
      return getYtdSeries(data.dailySeries);
    default: {
      // Exhaustive guard — TypeScript will catch unhandled DashboardPeriod values.
      const _never: never = period;
      return data.dailySeries;
    }
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AreaChartPanelProps {
  data: MetricSummary;
  period: DashboardPeriod;
  onPeriodChange: (next: DashboardPeriod) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AreaChartPanel({ data, period, onPeriodChange }: AreaChartPanelProps) {
  const [field, setField] = useState<AreaField>('costUsd');

  const filteredSeries = filterSeries(data, period);
  const isEmpty = period === '24h' ? data.heatmapData.length === 0 : data.dailySeries.length === 0;

  // For 24h, pass xAxisLabelFormat so ticks show HH:00 instead of MM-DD.
  const xAxisLabelFormat = period === '24h' ? (raw: string) => raw.slice(11, 16) : undefined;

  function handleExport() {
    exportDailySeriesCsv(filteredSeries, 'spend-over-time.csv');
  }

  return (
    <Card as="section" aria-label="Spend over time">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">Spend over time</h2>

        {/* Right-side cluster: PeriodSwitcher | Export | View full report */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Period segmented switcher */}
          <PeriodSwitcher value={period} onChange={onPeriodChange} />

          {/* Divider — visual separation between switcher and action buttons */}
          <div className="h-5 w-px bg-gray-200 dark:bg-gray-700" aria-hidden="true" />

          {/* Export button — visually muted when no data */}
          <Button
            variant="ghost"
            size="sm"
            Icon={Download}
            onClick={handleExport}
            disabled={isEmpty}
            aria-label="Export chart data as CSV"
            className={isEmpty ? 'opacity-40' : ''}
          >
            Export
          </Button>

          {/* View full report — TanStack Router Link styled as a ghost button.
              /report route is registered by subtask 8 (parallel group 3).
              Cast required until that route is in the routeTree type augmentation. */}
          <Link
            to="/report"
            className={[
              // Layout & typography — matches ghost Button primitive
              'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors',
              // Colours (light + dark pairs on the same line)
              // design-lint-disable dark-mode-pairs
              'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800',
              // Focus ring per design-authority pattern
              // design-lint-disable dark-mode-pairs
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white dark:focus-visible:ring-offset-gray-950',
            ].join(' ')}
            aria-label="View full report"
          >
            <ExternalLink size={14} aria-hidden="true" className="shrink-0" />
            View full report
          </Link>
        </div>
      </div>

      {/* ── Field toggle ────────────────────────────────────────────────────── */}
      {/* biome-ignore lint/a11y/useSemanticElements: role=group with aria-label is the canonical toolbar buttongroup pattern; <fieldset> would impose default browser visual styling */}
      <div className="flex items-center gap-1 mb-3" role="group" aria-label="Data field">
        {FIELD_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={field === opt.value ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setField(opt.value)}
            aria-pressed={field === opt.value}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {/* ── Chart ───────────────────────────────────────────────────────────── */}
      {filteredSeries.length === 0 ? (
        <div className="flex items-center justify-center h-56">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No data for the selected period.
          </p>
        </div>
      ) : (
        <AreaChart
          data={filteredSeries}
          field={field}
          height={220}
          {...(xAxisLabelFormat !== undefined ? { xAxisLabelFormat } : {})}
        />
      )}
    </Card>
  );
}
