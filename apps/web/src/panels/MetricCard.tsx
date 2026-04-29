/**
 * MetricCard — stat card with optional sparkline and delta indicator.
 *
 * Layout: column flex inside the card.
 *   Row 1: label
 *   Row 2: value (large)
 *   Row 3: pill + sparkline in a flex row with items-end so their BOTTOM
 *           edges share the same Y baseline (resolves CLAUD-013, CLAUD-014).
 *           This row is ONLY rendered when there is real content: a finite
 *           deltaPercent, a sparkline with >1 points, or both.
 *   Row 4: context line (optional)
 *
 * When an icon prop is provided it is rendered inline at the start of the label
 * row, before the label text.
 *
 * Props:
 *   - label        — card heading (screen-reader label for the article)
 *   - value        — pre-formatted headline string (e.g. "15.8M", "78.4%", "1,234")
 *   - sparklineData — raw number array fed to SparklineChart (optional)
 *   - deltaPercent  — percentage change vs prior period.
 *                     Pass a finite number to show the colored trend pill.
 *                     Pass null when a delta cannot be computed (e.g. fewer than
 *                     2 weeks of data, or a zero-denominator). When null AND no
 *                     sparklineData is provided, the trend row is suppressed
 *                     entirely — no pill, no em-dash placeholder.
 *   - context      — optional muted sub-line below the trend row
 *   - icon         — optional ReactNode pinned top-right
 *
 * Middle-row rendering contract:
 *   hasDelta && hasSpark  → pill on left, sparkline on right
 *   hasDelta && !hasSpark → pill only (no empty right placeholder)
 *   !hasDelta && hasSpark → sparkline only, justify-end (right-aligned)
 *   !hasDelta && !hasSpark → row not rendered
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
 * (primary blue, as configured in SparklineChart via primaryColor()).
 */

import type { ReactNode } from 'react';
import { SparklineChart } from '../charts/SparklineChart.js';
import { Card } from '../ui/Card.js';
import { HelpTooltip } from '../ui/HelpTooltip.js';

interface MetricCardProps {
  label: string;
  value: string;
  /** Context line rendered in secondary text below the trend pill. */
  context?: string;
  /**
   * Percentage delta vs prior period (e.g. +12.3 or -5.1).
   * Pass null when a delta cannot be computed (e.g. fewer than 2 weeks of
   * data, or a zero-denominator). null does NOT render an em-dash placeholder;
   * the trend row is suppressed entirely unless sparklineData is also provided.
   */
  deltaPercent: number | null;
  /** Optional spark data; if provided a SparklineChart is rendered on the right. */
  sparklineData?: number[];
  /** Optional icon rendered inline at the start of the label row, before the label text. */
  icon?: ReactNode;
  /** Optional hover/focus explanation for why the metric matters. */
  tooltip?: ReactNode;
  /**
   * How to color the delta pill.
   * - higher-better: positive green, negative red
   * - lower-better: negative green, positive red
   * - neutral: gray regardless of direction
   */
  deltaPolarity?: 'higher-better' | 'lower-better' | 'neutral';
}

export function MetricCard({
  label,
  value,
  context,
  deltaPercent,
  sparklineData,
  icon,
  tooltip,
  deltaPolarity = 'higher-better',
}: MetricCardProps) {
  const hasDelta = deltaPercent !== null && Number.isFinite(deltaPercent);
  const hasSpark = sparklineData !== undefined && sparklineData.length > 1;
  const isPositive = hasDelta && deltaPercent >= 0;
  const deltaTone =
    !hasDelta || deltaPolarity === 'neutral'
      ? 'neutral'
      : deltaPolarity === 'lower-better'
        ? deltaPercent <= 0
          ? 'favorable'
          : 'unfavorable'
        : deltaPercent >= 0
          ? 'favorable'
          : 'unfavorable';

  // Render the pill+sparkline row only when there is real content to show.
  // null delta with no sparkline → row is suppressed (no em-dash placeholder).
  const showMiddleRow = hasDelta || hasSpark;

  return (
    <Card as="article" aria-label={label} className="relative flex flex-col">
      {/* Label */}
      <p className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
        {icon !== undefined && icon}
        <span>{label}</span>
        {tooltip !== undefined && <HelpTooltip label={`Explain ${label}`}>{tooltip}</HelpTooltip>}
      </p>

      {/* Value */}
      <p className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white tabular-nums">
        {value}
      </p>

      {/*
        Middle row: pill (left) + sparkline (right).
        `items-end` bottom-aligns both children so the sparkline's bottom edge
        sits exactly at the same Y as the trend pill's bottom edge (CLAUD-014).
        Row is suppressed entirely when neither hasDelta nor hasSpark is true
        (e.g. deltaPercent={null} with no sparklineData).

        Cases:
          hasDelta && hasSpark  → pill left, sparkline right (justify-between)
          hasDelta && !hasSpark → pill only (justify-start, no empty placeholder)
          !hasDelta && hasSpark → sparkline only, right-aligned (justify-end)
          !hasDelta && !hasSpark → row not rendered (showMiddleRow is false)
      */}
      {showMiddleRow && (
        <div
          className={[
            'flex items-end gap-2 mt-2',
            hasDelta && hasSpark
              ? 'justify-between'
              : !hasDelta && hasSpark
                ? 'justify-end'
                : 'justify-start',
          ].join(' ')}
        >
          {/* Left: trend pill — rendered only when delta is a finite number */}
          {hasDelta && (
            <span
              className={[
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full',
                'bg-gray-100 dark:bg-gray-800',
                'text-xs font-medium',
                deltaTone === 'neutral'
                  ? 'text-gray-500 dark:text-gray-400'
                  : deltaTone === 'favorable'
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400',
              ].join(' ')}
              title={`${isPositive ? 'Up' : 'Down'} ${Math.abs(deltaPercent).toFixed(1)}%${
                deltaTone === 'neutral'
                  ? ''
                  : deltaTone === 'favorable'
                    ? ', favorable'
                    : ', unfavorable'
              }`}
            >
              <span className="sr-only">
                {isPositive ? 'Up' : 'Down'} {Math.abs(deltaPercent).toFixed(1)}%
                {deltaTone === 'neutral'
                  ? ''
                  : deltaTone === 'favorable'
                    ? ', favorable'
                    : ', unfavorable'}
              </span>
              {/* Arrow icon: ↗ for positive, ↘ for negative */}
              <span aria-hidden="true">{isPositive ? '↗' : '↘'}</span>
              <span aria-hidden="true">{Math.abs(deltaPercent).toFixed(1)}%</span>
            </span>
          )}

          {/* Right: sparkline container — proportional width (CLAUD-013).
              flex-[0_0_45%] gives ~45% of card width; max-w-[180px] caps it
              on very wide cards. Rendered only when sparklineData has >1 points. */}
          {hasSpark && (
            <div className="flex-[0_0_45%] max-w-[180px]">
              <SparklineChart data={sparklineData} height={48} />
            </div>
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
