/**
 * HeatmapChart — GitHub-contribution-style day-of-week × hour heatmap.
 *
 * Pure React implementation (no ECharts). Accepts raw HeatmapPoint[] and
 * aggregates client-side to (dayOfWeek 0-6, hour 0-23) buckets using
 * local-calendar parsing of the YYYY-MM-DD date key.
 *
 * Layout: 7 rows (Sun→Sat, top to bottom) × 24 columns (hours 0→23).
 * Color scale: single-hue opacity ramp on blue-500 — reads clearly as
 * "amount of activity" without chaotic multi-tone contrast jumps.
 *
 * Y-axis labels: All 7 days (Sun Mon Tue Wed Thu Fri Sat), rendered as <th scope="row">
 *   inside each table row so alignment is guaranteed by the table row height.
 * X-axis labels: All 24 hours in 24-hour numeric format (0 1 2 … 23), no rotation,
 *   each label horizontally centered above its column.
 * Tooltip: lightweight custom floating tooltip (useState). No native title fallback.
 *   Edge detection flips placement left/up when within ~140px of viewport edge.
 * Legend: "Less / More" swatch row, bottom-right.
 * Week boundaries: thin border above Mon and Sat rows.
 */

import type { HeatmapPoint } from '@tokenomix/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface HeatmapChartProps {
  data: HeatmapPoint[];
  height?: number;
}

/** Full day-of-week labels (index = getDay() value, 0 = Sunday). */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * 24-hour numeric labels for the hour axis (0–23).
 * Zero-padded to 2 digits so all labels visually align in the uniform 24-column grid.
 * Each index i maps to String(i).padStart(2, '0'): 00 01 02 … 09 10 11 … 23.
 */
const ALL_HOUR_LABELS: string[] = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

/**
 * Rows where a thin top border is drawn to mark week boundaries.
 * Mon=1 separates Sun from the weekday block; Sat=6 opens the weekend block.
 */
const WEEK_BOUNDARY_ROWS: ReadonlySet<number> = new Set([1, 6]);

// ---------------------------------------------------------------------------
// Color level → Tailwind class mapping (single-hue opacity ramp)
// ---------------------------------------------------------------------------

/**
 * Returns the combined Tailwind class string for the given activity level.
 * level 0 = no activity (gray base); levels 1-4 = single-hue blue opacity ramp.
 *
 * Single-hue ramp reads as "amount of activity" without the chaotic contrast
 * jumps of a multi-tone blue palette. opacity-[0.15] → opacity-[0.35] → 60 → 85 → 100.
 *
 * Light: level0=gray-100, levels 1-4=blue-500 at increasing opacity
 * Dark:  level0=gray-800, levels 1-4=blue-400 at increasing opacity
 */
function levelClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return 'bg-gray-100 dark:bg-gray-800';
    case 1:
      return 'bg-blue-500/15 dark:bg-blue-400/20';
    case 2:
      return 'bg-blue-500/35 dark:bg-blue-400/40';
    case 3:
      return 'bg-blue-500/65 dark:bg-blue-400/65';
    case 4:
      return 'bg-blue-500 dark:bg-blue-400';
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/** Bucket type: maps stringified "dayOfWeek-hour" keys to summed costUsd. */
type BucketMap = Map<string, number>;

function buildBucketKey(dayOfWeek: number, hour: number): string {
  return `${dayOfWeek}-${hour}`;
}

export function dayOfWeekFromDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map((part) => Number.parseInt(part, 10));
  if (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year !== undefined &&
    month !== undefined &&
    day !== undefined
  ) {
    return new Date(year, month - 1, day).getDay();
  }
  return new Date(dateKey).getDay();
}

function aggregateBuckets(data: HeatmapPoint[]): BucketMap {
  const buckets: BucketMap = new Map();
  for (const point of data) {
    const dayOfWeek = dayOfWeekFromDateKey(point.date); // 0=Sun…6=Sat
    const key = buildBucketKey(dayOfWeek, point.hour);
    buckets.set(key, (buckets.get(key) ?? 0) + point.costUsd);
  }
  return buckets;
}

function maxBucketValue(buckets: BucketMap): number {
  let max = 0;
  for (const v of buckets.values()) {
    if (v > max) max = v;
  }
  return max;
}

/**
 * Maps a costUsd value to a 0-4 activity level using the 5-step scale:
 *  0 = no activity
 *  1 = >0 … 20% of max
 *  2 = 20% … 40% of max
 *  3 = 40% … 70% of max
 *  4 = >70% of max
 */
function toLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === 0 || max === 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.7) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Tooltip state type
// ---------------------------------------------------------------------------

interface TooltipState {
  dayOfWeek: number;
  hour: number;
  value: number;
  /** rect of the cell relative to the grid container — for positioning */
  top: number;
  left: number;
  cellWidth: number;
  /** viewport coordinates for edge-detection flipping */
  viewportX: number;
  viewportY: number;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single heatmap cell with a custom hover tooltip (no native title fallback). */
function HeatmapCell({
  dayOfWeek,
  hour,
  value,
  level,
  onHover,
  onLeave,
}: {
  dayOfWeek: number;
  hour: number;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
  onHover: (state: TooltipState) => void;
  onLeave: () => void;
}) {
  const tdRef = useRef<HTMLTableCellElement>(null);
  const dayLabel = DAY_LABELS[dayOfWeek];
  const hourLabel = ALL_HOUR_LABELS[hour];
  const tooltipText = `${dayLabel} ${hourLabel}: $${value.toFixed(4)}`;

  function handleMouseEnter(e: React.MouseEvent<HTMLTableCellElement>) {
    if (!tdRef.current) return;
    const rect = tdRef.current.getBoundingClientRect();
    const parent = tdRef.current.closest<HTMLElement>('[data-heatmap-grid]');
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    onHover({
      dayOfWeek,
      hour,
      value,
      top: rect.top - parentRect.top,
      left: rect.left - parentRect.left,
      cellWidth: rect.width,
      viewportX: e.clientX,
      viewportY: rect.top,
    });
  }

  function handleFocus() {
    if (!tdRef.current) return;
    const rect = tdRef.current.getBoundingClientRect();
    const parent = tdRef.current.closest<HTMLElement>('[data-heatmap-grid]');
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    onHover({
      dayOfWeek,
      hour,
      value,
      top: rect.top - parentRect.top,
      left: rect.left - parentRect.left,
      cellWidth: rect.width,
      viewportX: rect.left + rect.width / 2,
      viewportY: rect.top,
    });
  }

  return (
    <td
      ref={tdRef}
      style={{ padding: 0 }}
      aria-label={tooltipText}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
      onFocus={handleFocus}
      onBlur={onLeave}
    >
      <div
        aria-hidden="true"
        className={[
          // design-lint-disable border-radius — 14px cells require <8px radius for visual integrity
          'rounded', // 4px — smallest non-banned radius; cells are 14px so 4px reads correctly
          'aspect-square',
          levelClass(level),
          'transition-opacity hover:opacity-75',
          // design-lint-disable dark-mode-pairs
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      />
    </td>
  );
}

/** Less/More legend strip shown in the bottom-right corner. */
function LegendStrip() {
  const LEVELS: Array<0 | 1 | 2 | 3 | 4> = [0, 1, 2, 3, 4];
  return (
    <div className="flex items-center gap-1.5 select-none">
      <span className="text-xs text-gray-500 dark:text-gray-400 leading-none">Less</span>
      {LEVELS.map((level) => (
        <div
          key={level}
          aria-hidden="true"
          className={[
            // design-lint-disable border-radius — 14px cells require <8px radius for visual integrity
            'w-3 h-3 rounded flex-shrink-0', // 4px radius — smallest non-banned
            levelClass(level),
          ].join(' ')}
        />
      ))}
      <span className="text-xs text-gray-500 dark:text-gray-400 leading-none">More</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Threshold (px from viewport edge) at which the tooltip flips placement. */
const EDGE_THRESHOLD = 140;

export function HeatmapChart({ data, height = 200 }: HeatmapChartProps) {
  // Aggregate and compute levels once per data change.
  const { buckets, max } = useMemo(() => {
    const b = aggregateBuckets(data);
    return { buckets: b, max: maxBucketValue(b) };
  }, [data]);

  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [vpWidth, setVpWidth] = useState(() => window.innerWidth);

  // Track viewport width for horizontal edge-detection flipping.
  useEffect(() => {
    function handleResize() {
      setVpWidth(window.innerWidth);
    }
    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /*
   * Layout structure (single <table> with colgroup):
   *
   *   <thead>: [empty corner] [hour-label cols 0-23]
   *   <tbody>: 7 rows, each: [<th scope="row"> day label] [24 <td> cells]
   *
   * Using a single table guarantees every day label is vertically centered to
   * its own row by the browser's table layout engine — no manual paddingTop math.
   */

  return (
    <div className="w-full" style={{ minHeight: `${height}px` }}>
      {/* ── Main layout: table with day-label column built into each row ── */}
      <div className="flex items-start gap-1.5">
        {/* Hour grid + hour labels — position:relative anchor for tooltip */}
        <div className="flex-1 min-w-0 relative" data-heatmap-grid="">
          {/*
           * 7×24 cell table. Each row starts with a <th scope="row"> for the day
           * label, followed by 24 <td> cells for each hour.
           *
           * A <colgroup> column for the day label has a fixed width (32px) so all
           * 24 data columns share the remaining space equally.
           *
           * The hour-label row (index -1 conceptually) is rendered as a <thead>
           * row: the first <th> is empty (day-label slot), then 24 <th scope="col">
           * cells for the hours — each centered above its column.
           */}
          <table
            aria-label="Cost activity grid: rows are days Sunday through Saturday, columns are hours 0 through 23"
            style={{
              width: '100%',
              borderCollapse: 'separate',
              borderSpacing: '3px',
              tableLayout: 'fixed',
            }}
          >
            <colgroup>
              {/* Day-label column */}
              <col style={{ width: '32px' }} />
              {/* 24 equal-width data columns — keyed by the stable hour label string */}
              {ALL_HOUR_LABELS.map((label) => (
                <col key={`col-${label}`} />
              ))}
            </colgroup>

            {/* Hour-label header row */}
            <thead aria-hidden="true">
              <tr>
                {/* Empty corner cell above the day-label column */}
                <th style={{ padding: 0 }} />
                {ALL_HOUR_LABELS.map((label, hour) => (
                  <th
                    key={`hour-${label}`}
                    scope="col"
                    aria-label={`Hour ${hour}`}
                    style={{ padding: 0, height: '16px', fontWeight: 'normal' }}
                  >
                    <span className="block text-xs leading-none text-gray-400 dark:text-gray-500 select-none text-center">
                      {label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {Array.from({ length: 7 }, (_, dayIndex) => (
                <tr
                  key={DAY_LABELS[dayIndex]}
                  style={{
                    // week-boundary hint: thin top border above Mon (1) and Sat (6)
                    borderTop: WEEK_BOUNDARY_ROWS.has(dayIndex)
                      ? '1px solid color-mix(in oklch, oklch(0.87 0 0) 30%, transparent)'
                      : undefined,
                  }}
                >
                  {/* Day label — in-row <th> guarantees vertical center alignment */}
                  <th scope="row" style={{ padding: 0 }}>
                    <span className="block text-xs leading-none text-gray-400 dark:text-gray-500 text-right pr-1 whitespace-nowrap">
                      {DAY_LABELS[dayIndex]}
                    </span>
                  </th>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const value = buckets.get(buildBucketKey(dayIndex, hour)) ?? 0;
                    const level = toLevel(value, max);
                    return (
                      <HeatmapCell
                        key={`${DAY_LABELS[dayIndex]}-${ALL_HOUR_LABELS[hour]}`}
                        dayOfWeek={dayIndex}
                        hour={hour}
                        value={value}
                        level={level}
                        onHover={setTooltip}
                        onLeave={() => setTooltip(null)}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Custom floating tooltip — edge-aware placement */}
          {tooltip !== null &&
            (() => {
              // Flip horizontally if within EDGE_THRESHOLD px of the right viewport edge.
              const nearRight = tooltip.viewportX + EDGE_THRESHOLD > vpWidth;
              // Flip vertically if within EDGE_THRESHOLD px of the top viewport edge.
              const nearTop = tooltip.viewportY < EDGE_THRESHOLD;

              const tooltipStyle: React.CSSProperties = nearRight
                ? {
                    // Anchor to cell right edge, open to the left
                    top: nearTop ? tooltip.top + 20 : tooltip.top - 32,
                    left: tooltip.left + tooltip.cellWidth,
                    transform: 'translateX(-100%)',
                  }
                : {
                    // Default: center above cell
                    top: nearTop ? tooltip.top + 20 : tooltip.top - 32,
                    left: tooltip.left + tooltip.cellWidth / 2,
                    transform: 'translateX(-50%)',
                  };

              return (
                <div
                  role="tooltip"
                  aria-live="polite"
                  className="pointer-events-none absolute z-10 px-2 py-1 rounded-lg text-xs font-medium bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 shadow-sm whitespace-nowrap"
                  style={tooltipStyle}
                >
                  {DAY_LABELS[tooltip.dayOfWeek]} {ALL_HOUR_LABELS[tooltip.hour]}: $
                  {tooltip.value.toFixed(4)}
                </div>
              );
            })()}
        </div>
      </div>

      {/* ── Footer: Less/More legend ── */}
      <div className="flex items-center justify-end mt-2">
        <LegendStrip />
      </div>
    </div>
  );
}
