/**
 * AreaChartPanel — prop-driven spend-over-time chart card.
 *
 * Receives pre-fetched MetricSummary from OverviewPage (single useQuery owner).
 * No internal useQuery or fetch. Period state is lifted to OverviewPage.
 *
 * Design decisions:
 * - Card header: "Spend over time" title (left) | PeriodSwitcher + Export (right).
 * - Period-to-series transform is pure client-side — AreaChart always receives DailyBucket[].
 * - 24h mode: synthetic DailyBucket[] built from heatmapData; xAxisLabelFormat slices HH:00.
 * - Export button is disabled + reduced-opacity when dailySeries is empty.
 * - Existing Cost / Input / Output field toggle is preserved.
 */

import type { DailyBucket, MetricSummary } from '@tokenomix/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { AreaChart, type AreaField } from '../charts/AreaChart.js';
import { exportDailySeriesCsv } from '../lib/csvExport.js';
import { getLast24hSeries, getTrailingDailySeries, getYtdSeries } from '../lib/derive.js';
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
        />
      )}
    </Card>
  );
}
