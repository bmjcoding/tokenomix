/**
 * AreaChartPanel — prop-driven spend-over-time chart card.
 *
 * Receives pre-fetched MetricSummary from OverviewPage (single useQuery owner).
 * No internal useQuery or fetch. Period state is lifted to OverviewPage.
 *
 * Design decisions:
 * - Card header: "Spend over time" title (left) | PeriodSwitcher + Export (right).
 * - Period-to-series transform is pure client-side — AreaChart always receives DailyBucket[].
 * - 24h mode: 49-point DailyBucket[] built from subhourlySeries (30-min slots);
 *   xAxisLabelFormat slices local HH:MM via raw.slice(11, 16) (no Z suffix).
 * - Export button is disabled + reduced-opacity when dailySeries is empty.
 * - Existing Cost / Input / Output field toggle is preserved.
 */

import type { DailyBucket, MetricSummary } from '@tokenomix/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { AreaChart, type AreaField } from '../charts/AreaChart.js';
import { exportDailySeriesCsv } from '../lib/csvExport.js';
import {
  getLast24hSubhourlySeries,
  getTrailingDailySeries,
  getYtdSeries,
} from '../lib/derive.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { SegmentedToggle } from '../ui/SegmentedToggle.js';
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
 * Builds a DailyBucket[] for the rolling 24h window using 30-minute slots.
 *
 * Delegates entirely to getLast24hSubhourlySeries which returns 49 entries
 * spanning [now-24h, now] at 30-min boundaries. Each DailyBucket.date is a
 * local-time ISO string with no Z suffix (e.g. '2026-04-30T13:30:00.000') so
 * that xAxisLabelFormat can call raw.slice(11, 16) to display local 'HH:MM'.
 *
 * All six DailyBucket fields are sourced from SubhourlyBucket, eliminating the
 * prior bug where inputTokens and outputTokens were always 0 in 24h mode.
 */
function buildSyntheticDailyBuckets(
  subhourlySeries: MetricSummary['subhourlySeries']
): DailyBucket[] {
  return getLast24hSubhourlySeries(subhourlySeries);
}

// ---------------------------------------------------------------------------
// Period → filtered series
// ---------------------------------------------------------------------------

function filterSeries(data: MetricSummary, period: DashboardPeriod): DailyBucket[] {
  switch (period) {
    case '24h':
      // Pass through undefined-safe: getLast24hSubhourlySeries accepts undefined/null
      // for stale-client safety (runtime guard, not a build-time contract change).
      return buildSyntheticDailyBuckets(data.subhourlySeries);
    case '7d':
      return getTrailingDailySeries(data.dailySeries, 7);
    case '30d':
      return getTrailingDailySeries(data.dailySeries, 30);
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
  const isEmpty =
    period === '24h'
      ? (data.subhourlySeries ?? []).length === 0
      : data.dailySeries.length === 0;

  // For 24h, pass xAxisLabelFormat so ticks show HH:MM instead of MM-DD.
  const xAxisLabelFormat = period === '24h' ? (raw: string) => raw.slice(11, 16) : undefined;
  // For 24h, pass tooltipHeaderFormat to convert '2026-04-30T14:30:00.000' → '2026-04-30 14:30'.
  const tooltipHeaderFormat =
    period === '24h' ? (raw: string) => raw.replace('T', ' ').slice(0, 16) : undefined;

  function handleExport() {
    exportDailySeriesCsv(filteredSeries, 'spend-over-time.csv');
  }

  return (
    <Card as="section" aria-label="Spend over time">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">Spend over time</h2>

        {/* Right-side cluster: PeriodSwitcher | Export */}
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
        </div>
      </div>

      {/* ── Field toggle ────────────────────────────────────────────────────── */}
      <div className="mb-3">
        <SegmentedToggle<AreaField>
          ariaLabel="Data field"
          options={FIELD_OPTIONS}
          value={field}
          onChange={setField}
          accent="primary"
        />
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
          {...(tooltipHeaderFormat !== undefined ? { tooltipHeaderFormat } : {})}
        />
      )}
    </Card>
  );
}
