/**
 * MetricCard — stat card with optional sparkline and delta indicator.
 *
 * Layout: column flex inside the card.
 *   Row 1: label
 *   Row 2: value (large)
 *   Row 3: pill + sparkline in a flex row with items-end so their BOTTOM
 *           edges share the same Y baseline (resolves CLAUD-013, CLAUD-014).
 *   Row 4: context line (optional)
 *
 * When an icon prop is provided it is pinned to the top-right of the card via
 * a wrapper div that uses `absolute` positioning (card surface is `relative`).
 *
 * Props:
 *   - label        — card heading (screen-reader label for the article)
 *   - value        — pre-formatted headline string (e.g. "15.8M", "78.4%", "1,234")
 *   - sparklineData — raw number array fed to SparklineChart (optional)
 *   - deltaPercent  — percentage change vs prior period; null → render em-dash
 *   - context      — optional muted sub-line below the trend row
 *   - icon         — optional ReactNode pinned top-right
 *
 * Token reference:
 * - Label: text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400
 * - Value: text-2xl font-bold tracking-tight text-gray-950 dark:text-white
 * - Trend pill: bg-gray-100 dark:bg-gray-800 rounded-full
 * - Positive delta: text-green-600 dark:text-green-400
 * - Negative delta: text-red-600 dark:text-red-400
 * - Context: text-xs text-gray-500 dark:text-gray-400
 *
 * NOTE: accentColor prop has been removed. All sparklines use --color-primary
 * (Chase blue, as configured in SparklineChart via primaryColor()).
 */

import type { ReactNode } from 'react';
import { SparklineChart } from '../charts/SparklineChart.js';
import { Card } from '../ui/Card.js';

interface MetricCardProps {
  label: string;
  value: string;
  /** Context line rendered in secondary text below the trend pill. */
  context?: string;
  /**
   * Percentage delta vs prior period (e.g. +12.3 or -5.1).
   * Pass null to render an em-dash — used when a delta cannot be computed
   * (e.g. Cache Efficiency, which has no per-period token breakdown in
   * PeriodRollup, or when previous period value is zero).
   */
  deltaPercent: number | null;
  /** Optional spark data; if provided a SparklineChart is rendered on the right. */
  sparklineData?: number[];
  /** Optional icon slot rendered in top-right corner. */
  icon?: ReactNode;
}

export function MetricCard({
  label,
  value,
  context,
  deltaPercent,
  sparklineData,
  icon,
}: MetricCardProps) {
  const hasDelta = deltaPercent !== null && Number.isFinite(deltaPercent);
  const hasSpark = sparklineData !== undefined && sparklineData.length > 1;
  const isPositive = hasDelta && deltaPercent >= 0;

  // Render the pill+sparkline row only when at least one is present.
  const showMiddleRow = hasDelta || deltaPercent === null || hasSpark;

  return (
    <Card as="article" aria-label={label} className="relative flex flex-col">
      {/* Label */}
      <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
        {icon !== undefined && icon}
        {label}
      </p>

      {/* Value */}
      <p className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white tabular-nums">
        {value}
      </p>

      {/*
        Middle row: pill (left) + sparkline (right).
        `items-end` bottom-aligns both children so the sparkline's bottom edge
        sits exactly at the same Y as the trend pill's bottom edge (CLAUD-014).
        `justify-between` pushes them to opposing ends.
      */}
      {showMiddleRow && (
        <div className="flex items-end justify-between gap-2 mt-2">
          {/* Left: trend pill or em-dash placeholder */}
          {hasDelta ? (
            <span
              className={[
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
                'bg-gray-100 dark:bg-gray-800',
                'text-xs font-medium',
                isPositive
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400',
              ].join(' ')}
              aria-label={`${isPositive ? 'Up' : 'Down'} ${Math.abs(deltaPercent).toFixed(1)}%`}
            >
              {/* Arrow icon: ↗ for positive, ↘ for negative */}
              <span aria-hidden="true">{isPositive ? '↗' : '↘'}</span>
              <span>{Math.abs(deltaPercent).toFixed(1)}%</span>
            </span>
          ) : (
            /* Em-dash rendered when delta is null (no comparable period data) */
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium text-gray-500 dark:text-gray-400"
              aria-label="No comparison data"
            >
              {'—'}
            </span>
          )}

          {/* Right: sparkline container — proportional width (CLAUD-013).
              flex-[0_0_45%] gives ~45% of card width; max-w-[180px] caps it
              on very wide cards. */}
          {hasSpark ? (
            <div className="flex-[0_0_45%] max-w-[180px]">
              <SparklineChart data={sparklineData} height={48} />
            </div>
          ) : (
            // Empty placeholder when sparkline is absent so pill still renders.
            <div aria-hidden="true" />
          )}
        </div>
      )}

      {/* Context line — rendered below the pill+sparkline row */}
      {context !== undefined && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{context}</p>
      )}
    </Card>
  );
}
