/**
 * HeatmapChart — GitHub-contribution-style day-of-week × hour heatmap.
 *
 * Pure React implementation (no ECharts). Accepts raw HeatmapPoint[] and
 * aggregates client-side to (dayOfWeek 0-6, hour 0-23) buckets using
 * `new Date(point.date).getDay()`.
 *
 * Layout: 7 rows (Sun→Sat, top to bottom) × 24 columns (hours 0→23).
 * Color scale: 5-step monochrome-gray + blue ramp matching the project's
 * Chase-blue design tokens.
 *
 * Y-axis labels: Mon, Wed, Fri only (GitHub-style sparse labels).
 * X-axis labels: 12a, 6a, 12p, 6p (every 6 hours).
 * Tooltip: native `title` attribute — no third-party dependency.
 * Legend: "Less / More" swatch row, bottom-right.
 */

import type { HeatmapPoint } from '@tokenomix/shared';
import { useMemo } from 'react';

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
 * Human-readable hour labels for all 24 hours.
 * 0 → "12a", 1–11 → "1a"…"11a", 12 → "12p", 13–23 → "1p"…"11p".
 */
const ALL_HOUR_LABELS: string[] = Array.from({ length: 24 }, (_, i) => {
  if (i === 0) return '12a';
  if (i < 12) return `${i}a`;
  if (i === 12) return '12p';
  return `${i - 12}p`;
});

/** Rows (dayOfWeek) that show a visible label — matching GitHub's sparse style. */
const LABELED_DAYS: ReadonlySet<number> = new Set([1, 3, 5]); // Mon=1, Wed=3, Fri=5

/** Hours that show a visible label in the top axis. */
const LABELED_HOURS: ReadonlySet<number> = new Set([0, 6, 12, 18]); // 12a, 6a, 12p, 6p

// ---------------------------------------------------------------------------
// Color level → Tailwind class mapping (light + dark counterparts)
// ---------------------------------------------------------------------------

/**
 * Returns the combined Tailwind class string for the given activity level.
 * level 0 = no activity (gray base); levels 1-4 = blue ramp (light → dark).
 *
 * Data-viz convention: light blue = light usage, dark blue = heavy usage.
 *
 * Light: level0=gray-100, level1=blue-200, level2=blue-400, level3=blue-600, level4=blue-800
 * Dark:  level0=gray-800, level1=blue-300, level2=blue-500, level3=blue-700, level4=blue-900
 */
function levelClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return 'bg-gray-100 dark:bg-gray-800';
    case 1:
      return 'bg-blue-200 dark:bg-blue-300';
    case 2:
      return 'bg-blue-400 dark:bg-blue-500';
    case 3:
      return 'bg-blue-600 dark:bg-blue-700';
    case 4:
      return 'bg-blue-800 dark:bg-blue-900';
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

function aggregateBuckets(data: HeatmapPoint[]): BucketMap {
  const buckets: BucketMap = new Map();
  for (const point of data) {
    const dayOfWeek = new Date(point.date).getDay(); // 0=Sun…6=Sat
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
// Sub-components
// ---------------------------------------------------------------------------

/** A single heatmap cell with a native title tooltip. */
function HeatmapCell({
  dayOfWeek,
  hour,
  value,
  level,
}: {
  dayOfWeek: number;
  hour: number;
  value: number;
  level: 0 | 1 | 2 | 3 | 4;
}) {
  const dayLabel = DAY_LABELS[dayOfWeek];
  const hourLabel = ALL_HOUR_LABELS[hour];
  const tooltipText = `${dayLabel} ${hourLabel}: $${value.toFixed(4)}`;

  return (
    <td style={{ padding: 0 }}>
      <div
        role="gridcell"
        tabIndex={0}
        aria-label={tooltipText}
        title={tooltipText}
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
      <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">Less</span>
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
      <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">More</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HeatmapChart({ data, height = 200 }: HeatmapChartProps) {
  // Aggregate and compute levels once per data change.
  const { buckets, max } = useMemo(() => {
    const b = aggregateBuckets(data);
    return { buckets: b, max: maxBucketValue(b) };
  }, [data]);

  /*
   * Layout structure:
   *
   *   [day-label col] [24-column hour grid]
   *
   * The hour-label row sits above the grid (column-spanning header row).
   * The day labels are a parallel column of 7 rows at the same height as the grid rows.
   */

  return (
    <div className="w-full" style={{ minHeight: `${height}px` }}>
      {/* ── Main layout: day-label column + hour grid ── */}
      <div className="flex items-start gap-1.5">
        {/* Day label column */}
        <div
          className="flex flex-col"
          aria-hidden="true"
          style={{ gap: '3px', paddingTop: '18px' /* offset for hour-label row */ }}
        >
          {Array.from({ length: 7 }, (_, dayIndex) => (
            <div
              key={DAY_LABELS[dayIndex]}
              className="flex items-center justify-end"
              style={{ height: '14px' }}
            >
              {LABELED_DAYS.has(dayIndex) ? (
                <span className="text-[10px] leading-none text-gray-500 dark:text-gray-400 pr-1 whitespace-nowrap">
                  {DAY_LABELS[dayIndex]}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {/* Hour grid + hour labels */}
        <div className="flex-1 min-w-0">
          {/* Hour labels row */}
          <div
            className="grid"
            aria-hidden="true"
            style={{
              gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
              gap: '3px',
              marginBottom: '2px',
            }}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={ALL_HOUR_LABELS[hour]}
                className="text-[10px] leading-none text-gray-500 dark:text-gray-400"
                style={{ height: '14px', display: 'flex', alignItems: 'center' }}
              >
                {LABELED_HOURS.has(hour) ? ALL_HOUR_LABELS[hour] : null}
              </div>
            ))}
          </div>

          {/* 7×24 cell grid — semantic <table>/<tr>/<td> with CSS grid display for responsive cell sizing */}
          <table
            aria-label="Cost activity grid: rows are days Sunday through Saturday, columns are hours 0 through 23"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              borderCollapse: 'separate',
              borderSpacing: 0,
            }}
          >
            <tbody style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {Array.from({ length: 7 }, (_, dayIndex) => (
                <tr
                  key={DAY_LABELS[dayIndex]}
                  aria-label={DAY_LABELS[dayIndex]}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
                    gap: '3px',
                  }}
                >
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
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Footer: Less/More legend ── */}
      <div className="flex items-center justify-end mt-2">
        <LegendStrip />
      </div>
    </div>
  );
}
