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

/**
 * Returns the last 24 hourly buckets from heatmapData, sorted ascending by
 * (date, hour).
 *
 * Strategy: sort all heatmap points by date + hour descending, take the first
 * 24, then reverse to get ascending order for chart rendering.
 */
export function getLast24hSeries(heatmapData: HeatmapPoint[]): { hour: number; costUsd: number }[] {
  // Sort descending by (date, hour) so slice(0, 24) grabs the most recent 24.
  const sorted = [...heatmapData].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.hour - a.hour;
  });

  // Take the 24 most recent buckets, then reverse to ascending.
  const last24 = sorted.slice(0, 24).reverse();

  return last24.map((p) => ({ hour: p.hour, costUsd: p.costUsd }));
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
