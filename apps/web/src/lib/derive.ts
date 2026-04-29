/**
 * derive.ts — client-side time-series and ratio derivations.
 *
 * All functions are pure: no fetch, no hooks, no side effects.
 * Type-only imports from @tokenomix/shared — no runtime shared imports.
 *
 * The '24h' and 'ytd' period strings are local to this module's callers
 * and do NOT extend the shared SinceOption type.
 */

import type { DailyBucket, HeatmapPoint } from '@tokenomix/shared';

// ---------------------------------------------------------------------------
// 24-hour series
// ---------------------------------------------------------------------------

export interface HourlySpendPoint {
  date: string;
  hour: number;
  costUsd: number;
}

/** Format a Date as YYYY-MM-DD in the browser's local time zone. */
function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns local hourly boundary buckets spanning the last 24 hours.
 *
 * Missing heatmap buckets are filled with 0 so the chart represents a real
 * rolling 24-hour window instead of the last non-empty usage hours.
 *
 * The output has 25 points: now-24h, every hour between, and the current hour.
 * That makes the visible chart endpoints a full 24 hours apart.
 */
export function getLast24hSeries(
  heatmapData: HeatmapPoint[],
  now = new Date()
): HourlySpendPoint[] {
  if (heatmapData.length === 0) return [];

  const costByHour = new Map<string, number>();
  for (const point of heatmapData) {
    const key = `${point.date}:${point.hour}`;
    costByHour.set(key, (costByHour.get(key) ?? 0) + point.costUsd);
  }

  const end = new Date(now.getTime());
  end.setMinutes(0, 0, 0);

  const series: HourlySpendPoint[] = [];
  for (let offset = 24; offset >= 0; offset--) {
    const bucketTime = new Date(end.getTime());
    bucketTime.setHours(end.getHours() - offset);
    const date = toLocalDateKey(bucketTime);
    const hour = bucketTime.getHours();
    series.push({
      date,
      hour,
      costUsd: costByHour.get(`${date}:${hour}`) ?? 0,
    });
  }
  return series;
}

// ---------------------------------------------------------------------------
// YTD series
// ---------------------------------------------------------------------------

/**
 * Returns only the DailyBucket entries whose date falls in the current
 * calendar year (UTC). Entries are returned in their original order.
 *
 * "Current year" is determined at call time from the system clock.
 */
export function getYtdSeries(dailySeries: DailyBucket[]): DailyBucket[] {
  const currentYear = new Date().getFullYear();
  return dailySeries.filter((bucket) => {
    // date is YYYY-MM-DD; parsing as-is gives local time which is fine for
    // calendar-year filtering because we only need the year component.
    const year = Number.parseInt(bucket.date.slice(0, 4), 10);
    return year === currentYear;
  });
}

// ---------------------------------------------------------------------------
// Cache efficiency ratio
// ---------------------------------------------------------------------------

/**
 * Args shape for computeCacheEfficiency.
 *
 * Callers pass flat MetricSummary fields:
 *   { cacheReadTokens: data.totalCacheReadTokens,
 *     cacheCreationTokens: data.totalCacheCreationTokens,
 *     inputTokens: data.totalInputTokens }
 *
 * Note: PeriodRollup is NOT accepted here — it has no per-type token
 * breakdown. This function operates on flat scalar values only.
 */
export interface CacheEfficiencyArgs {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
}

/**
 * Computes the cache-hit percentage among all input-side tokens.
 *
 * Formula: cacheReadTokens / (cacheReadTokens + cacheCreationTokens + inputTokens) * 100
 *
 * Returns 0 when the denominator is zero to avoid NaN / division-by-zero.
 * Result is in the 0..100 range (inclusive) — no clamping is needed because
 * all token counts are non-negative and cacheReadTokens <= denominator.
 */
export function computeCacheEfficiency(args: CacheEfficiencyArgs): number {
  const { cacheReadTokens, cacheCreationTokens, inputTokens } = args;
  const denominator = cacheReadTokens + cacheCreationTokens + inputTokens;
  if (denominator === 0) return 0;
  return (cacheReadTokens / denominator) * 100;
}

// ---------------------------------------------------------------------------
// Per-day efficiency series
// ---------------------------------------------------------------------------

/**
 * Computes a per-bucket cache efficiency percentage for a DailyBucket array.
 *
 * Each output value corresponds to the same-index input bucket:
 *   value[i] = bucket[i].cacheReadTokens /
 *              (bucket[i].cacheReadTokens + bucket[i].cacheCreationTokens + bucket[i].inputTokens)
 *              * 100
 *
 * Returns 0 for any bucket whose per-bucket denominator is zero.
 * Output array length always equals input array length.
 */
export function computeDailyEfficiencySeries(dailySeries: DailyBucket[]): number[] {
  return dailySeries.map((bucket) => {
    const denominator = bucket.cacheReadTokens + bucket.cacheCreationTokens + bucket.inputTokens;
    if (denominator === 0) return 0;
    return (bucket.cacheReadTokens / denominator) * 100;
  });
}
