/**
 * period-rollup.ts — Pure date-math and aggregation helpers for the hero
 * period switcher.
 *
 * No React, no DOM, fully unit-testable.
 *
 * Date-math contract:
 * - All boundaries are local date strings (YYYY-MM-DD), matching DailyBucket.date.
 * - "today" is injectable for testing; defaults to new Date() (local).
 * - "Custom" with no range yet selected falls back to MTD (same as the default period).
 */

import type { DailyBucket } from '@tokenomix/shared';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type HeroPeriod = 'mtd' | 'prev-month' | 'ytd' | 'custom';

export interface DateRange {
  /** YYYY-MM-DD inclusive */
  from: string;
  /** YYYY-MM-DD inclusive */
  to: string;
}

export interface PeriodTotals {
  costUsd: number;
  /** input + output (matches existing PeriodRollup.totalTokens) */
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Serialize a Date to YYYY-MM-DD using local (not UTC) components. */
function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Last day of a given month (handles leap years). */
function lastDayOfMonth(year: number, month: number): number {
  // new Date(y, month+1, 0) gives the last day of the target month in local time.
  return new Date(year, month + 1, 0).getDate();
}

/** Parse a YYYY-MM-DD string to a numeric value suitable for comparison.
 *  Returns an integer like 20260415 so simple < / > works without Date objects. */
function ymdToInt(ymd: string): number {
  return Number(ymd.replace(/-/g, ''));
}

// ---------------------------------------------------------------------------
// getDateRangeForPeriod
// ---------------------------------------------------------------------------

/**
 * Returns the date range for the given hero period.
 * `today` is injectable for tests (defaults to new Date()).
 *
 * - 'custom' with no range → falls back to MTD.
 */
export function getDateRangeForPeriod(
  period: HeroPeriod,
  customRange: DateRange | null,
  today?: Date
): DateRange {
  const now = today ?? new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  switch (period) {
    case 'mtd':
      return {
        from: toYmd(new Date(y, m, 1)),
        to: toYmd(now),
      };

    case 'prev-month': {
      const prevM = m === 0 ? 11 : m - 1;
      const prevY = m === 0 ? y - 1 : y;
      return {
        from: toYmd(new Date(prevY, prevM, 1)),
        to: toYmd(new Date(prevY, prevM, lastDayOfMonth(prevY, prevM))),
      };
    }

    case 'ytd':
      return {
        from: toYmd(new Date(y, 0, 1)),
        to: toYmd(now),
      };

    case 'custom':
      // Fall back to MTD when no custom range has been selected yet.
      if (customRange === null) {
        return {
          from: toYmd(new Date(y, m, 1)),
          to: toYmd(now),
        };
      }
      return customRange;
  }
}

// ---------------------------------------------------------------------------
// getPriorRangeForPeriod
// ---------------------------------------------------------------------------

/**
 * Returns the natural prior-comparison range for a given period:
 *
 * - mtd        → previous calendar month (full month)
 * - prev-month → month before that (full month)
 * - ytd        → same window in the previous year (Jan 1 prior-year .. (today - 1 year))
 * - custom     → same-length window immediately preceding `currentRange`
 */
export function getPriorRangeForPeriod(
  period: HeroPeriod,
  currentRange: DateRange,
  today?: Date
): DateRange {
  const now = today ?? new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (period) {
    case 'mtd': {
      // Prior = full previous calendar month.
      const prevM = m === 0 ? 11 : m - 1;
      const prevY = m === 0 ? y - 1 : y;
      return {
        from: toYmd(new Date(prevY, prevM, 1)),
        to: toYmd(new Date(prevY, prevM, lastDayOfMonth(prevY, prevM))),
      };
    }

    case 'prev-month': {
      // Prior = month before the previous month.
      const prevM = m === 0 ? 11 : m - 1;
      const prevY = m === 0 ? y - 1 : y;
      const prevPrevM = prevM === 0 ? 11 : prevM - 1;
      const prevPrevY = prevM === 0 ? prevY - 1 : prevY;
      return {
        from: toYmd(new Date(prevPrevY, prevPrevM, 1)),
        to: toYmd(new Date(prevPrevY, prevPrevM, lastDayOfMonth(prevPrevY, prevPrevM))),
      };
    }

    case 'ytd': {
      // Prior = same window in the previous year: Jan 1 (y-1) .. (today's date in y-1).
      const priorY = y - 1;
      // today in prior year (respects Feb 29 → Feb 28 fallback via Date auto-clamp)
      const todayInPriorYear = new Date(priorY, m, now.getDate());
      return {
        from: toYmd(new Date(priorY, 0, 1)),
        to: toYmd(todayInPriorYear),
      };
    }

    case 'custom': {
      // Same-length window immediately preceding currentRange.
      const fromDate = new Date(
        Number(currentRange.from.slice(0, 4)),
        Number(currentRange.from.slice(5, 7)) - 1,
        Number(currentRange.from.slice(8, 10))
      );
      const toDate = new Date(
        Number(currentRange.to.slice(0, 4)),
        Number(currentRange.to.slice(5, 7)) - 1,
        Number(currentRange.to.slice(8, 10))
      );
      // Length in days (inclusive, so +1).
      const lengthMs = toDate.getTime() - fromDate.getTime() + 86_400_000;
      const priorTo = new Date(fromDate.getTime() - 86_400_000);
      const priorFrom = new Date(fromDate.getTime() - lengthMs);
      return {
        from: toYmd(priorFrom),
        to: toYmd(priorTo),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// aggregateDailyBuckets
// ---------------------------------------------------------------------------

/**
 * Sum DailyBucket fields whose date falls within [range.from, range.to] inclusive.
 * Comparison is done via integer representation so no Date parsing overhead.
 */
export function aggregateDailyBuckets(buckets: DailyBucket[], range: DateRange): PeriodTotals {
  const fromInt = ymdToInt(range.from);
  const toInt = ymdToInt(range.to);

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const bucket of buckets) {
    const d = ymdToInt(bucket.date);
    if (d >= fromInt && d <= toInt) {
      costUsd += bucket.costUsd;
      inputTokens += bucket.inputTokens;
      outputTokens += bucket.outputTokens;
    }
  }

  return {
    costUsd,
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// periodDisplayLabel
// ---------------------------------------------------------------------------

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Format a YYYY-MM-DD as "Mon D" or "Mon D YYYY" when `includeYear` is true. */
function fmtDate(ymd: string, includeYear: boolean): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7)) - 1;
  const d = Number(ymd.slice(8, 10));
  const monthStr = SHORT_MONTHS[m] ?? '';
  return includeYear ? `${monthStr} ${d} ${y}` : `${monthStr} ${d}`;
}

/**
 * Human-readable label for the period — used in the hero's subtitle.
 *
 * Examples:
 *   mtd        → "MTD"
 *   prev-month → "Prev Month"
 *   ytd        → "YTD"
 *   custom     → "Apr 1 – Apr 28" or "Dec 28 2025 – Jan 4 2026"
 */
export function periodDisplayLabel(period: HeroPeriod, range: DateRange): string {
  switch (period) {
    case 'mtd':
      return 'MTD';
    case 'prev-month':
      return 'Prev Month';
    case 'ytd':
      return 'YTD';
    case 'custom': {
      const fromYear = Number(range.from.slice(0, 4));
      const toYear = Number(range.to.slice(0, 4));
      const spanYears = fromYear !== toYear;
      return `${fmtDate(range.from, spanYears)} – ${fmtDate(range.to, spanYears)}`;
    }
  }
}
