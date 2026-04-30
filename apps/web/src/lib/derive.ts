/**
 * derive.ts — client-side time-series and ratio derivations.
 *
 * All functions are pure: no fetch, no hooks, no side effects.
 * Type-only imports from @tokenomix/shared — no runtime shared imports.
 *
 * The '24h' and 'ytd' period strings are local to this module's callers
 * and do NOT extend the shared SinceOption type.
 */

import type { DailyBucket, HeatmapPoint, SubhourlyBucket } from '@tokenomix/shared';

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

function emptyDailyBucket(date: string): DailyBucket {
  return {
    date,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
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
// 24-hour sub-hourly series (30-minute buckets)
// ---------------------------------------------------------------------------

/**
 * Format a Date as a local-time ISO string with no Z or offset suffix.
 *
 * Format: YYYY-MM-DDTHH:MM:00.000
 *
 * This matches the format emitted by the server's aggregate() so that map-key
 * lookups between server buckets and client slots produce identical strings for
 * the same wall-clock instant. The xAxisLabelFormat raw.slice(11, 16) then
 * yields the local "HH:MM" the user expects instead of UTC hours.
 */
function formatLocalIsoNoZ(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day}T${h}:${min}:00.000`;
}

/**
 * Returns 30-minute boundary buckets spanning the last 24 hours.
 *
 * Consumes the SubhourlyBucket[] emitted by the server's aggregate() and maps
 * them onto a fixed 49-point window (offset 48 down to 0, each step 30 min)
 * so the chart always shows a complete rolling 24-hour view. Missing slots
 * are zero-filled.
 *
 * The returned DailyBucket.date is a local-time ISO string with no Z suffix
 * (e.g. '2026-04-30T13:30:00.000'), matching the format emitted by the server
 * so that xAxisLabelFormat can call raw.slice(11, 16) to get local 'HH:MM'.
 *
 * The output has 49 points: offset 48 is the oldest slot (now - 24h) and
 * offset 0 is the most recent slot, making the visible chart endpoints a full
 * 24 hours apart.
 */
export function getLast24hSubhourlySeries(
  subhourlySeries: SubhourlyBucket[] | undefined | null,
  now = new Date()
): DailyBucket[] {
  // Treat undefined/null (stale-client or cached pre-deploy MetricSummary) as [].
  const series = subhourlySeries ?? [];
  if (series.length === 0) return [];

  // Build a map keyed on the server-emitted local-time ISO string (no Z).
  const bucketByTimestamp = new Map<string, SubhourlyBucket>();
  for (const bucket of series) {
    bucketByTimestamp.set(bucket.timestamp, bucket);
  }

  // Floor `end` to the current 30-minute slot boundary.
  const slotMinute = now.getMinutes() >= 30 ? 30 : 0;
  const end = new Date(now.getTime());
  end.setMinutes(slotMinute, 0, 0);

  const STEP_MS = 30 * 60 * 1000;
  const result: DailyBucket[] = [];

  for (let offset = 48; offset >= 0; offset--) {
    const slotStart = new Date(end.getTime() - offset * STEP_MS);
    const localKey = formatLocalIsoNoZ(slotStart);
    const existing = bucketByTimestamp.get(localKey);

    result.push(
      existing
        ? {
            date: localKey,
            costUsd: existing.costUsd,
            inputTokens: existing.inputTokens,
            outputTokens: existing.outputTokens,
            cacheCreationTokens: existing.cacheCreationTokens,
            cacheReadTokens: existing.cacheReadTokens,
          }
        : emptyDailyBucket(localKey)
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Trailing day series
// ---------------------------------------------------------------------------

/**
 * Returns one bucket per local calendar day for a trailing fixed-day window.
 *
 * MetricSummary.dailySeries is intentionally sparse: it only contains days with
 * usage. Fixed dashboard windows such as 7D and 30D need calendar-day windows,
 * so missing days are represented as zero-valued buckets instead of allowing
 * the chart to drift back to older non-empty dates.
 */
export function getTrailingDailySeries(
  dailySeries: DailyBucket[],
  days: number,
  now = new Date()
): DailyBucket[] {
  if (days <= 0 || dailySeries.length === 0) return [];

  const bucketsByDate = new Map(dailySeries.map((bucket) => [bucket.date, bucket]));
  const end = new Date(now.getTime());
  end.setHours(0, 0, 0, 0);

  const result: DailyBucket[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const bucketDate = new Date(end.getTime());
    bucketDate.setDate(end.getDate() - offset);
    const dateKey = toLocalDateKey(bucketDate);
    result.push(bucketsByDate.get(dateKey) ?? emptyDailyBucket(dateKey));
  }

  return result;
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
