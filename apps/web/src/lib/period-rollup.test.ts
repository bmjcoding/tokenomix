/**
 * period-rollup.test.ts — Vitest unit tests for period-rollup.ts.
 *
 * All fixtures are purely in-memory — no API calls, no DOM.
 * Uses injected `today` dates for deterministic boundary assertions.
 */

import type { DailyBucket } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import {
  aggregateDailyBuckets,
  getDateRangeForPeriod,
  getPriorRangeForPeriod,
  periodDisplayLabel,
} from './period-rollup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDate(y: number, m: number, d: number): Date {
  // Constructed as local time (same as the implementation).
  return new Date(y, m - 1, d);
}

function bucket(date: string, costUsd: number, inputTokens = 0, outputTokens = 0): DailyBucket {
  return { date, costUsd, inputTokens, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

// ---------------------------------------------------------------------------
// getDateRangeForPeriod
// ---------------------------------------------------------------------------

describe('getDateRangeForPeriod', () => {
  describe('mtd', () => {
    it('MTD on Apr 15 2026 produces 2026-04-01..2026-04-15', () => {
      const today = makeDate(2026, 4, 15);
      const range = getDateRangeForPeriod('mtd', null, today);
      expect(range.from).toBe('2026-04-01');
      expect(range.to).toBe('2026-04-15');
    });

    it('MTD on Jan 1 includes only Jan 1', () => {
      const today = makeDate(2026, 1, 1);
      const range = getDateRangeForPeriod('mtd', null, today);
      expect(range.from).toBe('2026-01-01');
      expect(range.to).toBe('2026-01-01');
    });
  });

  describe('prev-month', () => {
    it('Prev Month on Mar 3 2026 produces 2026-02-01..2026-02-28', () => {
      const today = makeDate(2026, 3, 3);
      const range = getDateRangeForPeriod('prev-month', null, today);
      expect(range.from).toBe('2026-02-01');
      expect(range.to).toBe('2026-02-28');
    });

    it('Prev Month on Mar 3 2024 (leap year) produces 2024-02-01..2024-02-29', () => {
      const today = makeDate(2024, 3, 3);
      const range = getDateRangeForPeriod('prev-month', null, today);
      expect(range.from).toBe('2024-02-01');
      expect(range.to).toBe('2024-02-29');
    });

    it('Prev Month on Feb 10 wraps back to January of same year', () => {
      const today = makeDate(2026, 2, 10);
      const range = getDateRangeForPeriod('prev-month', null, today);
      expect(range.from).toBe('2026-01-01');
      expect(range.to).toBe('2026-01-31');
    });

    it('Prev Month on Jan 15 wraps back to December of prior year', () => {
      const today = makeDate(2026, 1, 15);
      const range = getDateRangeForPeriod('prev-month', null, today);
      expect(range.from).toBe('2025-12-01');
      expect(range.to).toBe('2025-12-31');
    });
  });

  describe('ytd', () => {
    it('YTD on Jul 4 2026 produces 2026-01-01..2026-07-04', () => {
      const today = makeDate(2026, 7, 4);
      const range = getDateRangeForPeriod('ytd', null, today);
      expect(range.from).toBe('2026-01-01');
      expect(range.to).toBe('2026-07-04');
    });

    it('YTD on Jan 1 includes only Jan 1', () => {
      const today = makeDate(2026, 1, 1);
      const range = getDateRangeForPeriod('ytd', null, today);
      expect(range.from).toBe('2026-01-01');
      expect(range.to).toBe('2026-01-01');
    });
  });

  describe('custom', () => {
    it('Custom with a range returns the range unchanged', () => {
      const custom = { from: '2026-04-10', to: '2026-04-19' };
      const range = getDateRangeForPeriod('custom', custom);
      expect(range).toEqual(custom);
    });

    it('Custom with null falls back to MTD', () => {
      const today = makeDate(2026, 4, 15);
      const range = getDateRangeForPeriod('custom', null, today);
      expect(range.from).toBe('2026-04-01');
      expect(range.to).toBe('2026-04-15');
    });
  });
});

// ---------------------------------------------------------------------------
// getPriorRangeForPeriod
// ---------------------------------------------------------------------------

describe('getPriorRangeForPeriod', () => {
  it('Prior range for MTD on Apr 15 = full March (2026-03-01..2026-03-31)', () => {
    const today = makeDate(2026, 4, 15);
    const currentRange = getDateRangeForPeriod('mtd', null, today);
    const prior = getPriorRangeForPeriod('mtd', currentRange, today);
    expect(prior.from).toBe('2026-03-01');
    expect(prior.to).toBe('2026-03-31');
  });

  it('Prior range for MTD on Feb 10 = full January', () => {
    const today = makeDate(2026, 2, 10);
    const currentRange = getDateRangeForPeriod('mtd', null, today);
    const prior = getPriorRangeForPeriod('mtd', currentRange, today);
    expect(prior.from).toBe('2026-01-01');
    expect(prior.to).toBe('2026-01-31');
  });

  it('Prior range for MTD on Jan 15 wraps to December', () => {
    const today = makeDate(2026, 1, 15);
    const currentRange = getDateRangeForPeriod('mtd', null, today);
    const prior = getPriorRangeForPeriod('mtd', currentRange, today);
    expect(prior.from).toBe('2025-12-01');
    expect(prior.to).toBe('2025-12-31');
  });

  it('Prior range for YTD on Jul 4 2026 = 2025-01-01..2025-07-04', () => {
    const today = makeDate(2026, 7, 4);
    const currentRange = getDateRangeForPeriod('ytd', null, today);
    const prior = getPriorRangeForPeriod('ytd', currentRange, today);
    expect(prior.from).toBe('2025-01-01');
    expect(prior.to).toBe('2025-07-04');
  });

  it('Prior range for a custom 10-day window 2026-04-10..2026-04-19 = 2026-03-31..2026-04-09', () => {
    const currentRange = { from: '2026-04-10', to: '2026-04-19' };
    const prior = getPriorRangeForPeriod('custom', currentRange);
    expect(prior.from).toBe('2026-03-31');
    expect(prior.to).toBe('2026-04-09');
  });

  it('Prior range for prev-month on Mar 2026 = January 2026', () => {
    const today = makeDate(2026, 3, 15);
    const currentRange = getDateRangeForPeriod('prev-month', null, today);
    const prior = getPriorRangeForPeriod('prev-month', currentRange, today);
    expect(prior.from).toBe('2026-01-01');
    expect(prior.to).toBe('2026-01-31');
  });

  it('Prior range for prev-month on Feb 2026 = December 2025', () => {
    const today = makeDate(2026, 2, 10);
    const currentRange = getDateRangeForPeriod('prev-month', null, today);
    const prior = getPriorRangeForPeriod('prev-month', currentRange, today);
    expect(prior.from).toBe('2025-12-01');
    expect(prior.to).toBe('2025-12-31');
  });
});

// ---------------------------------------------------------------------------
// aggregateDailyBuckets
// ---------------------------------------------------------------------------

describe('aggregateDailyBuckets', () => {
  const series: DailyBucket[] = [
    bucket('2026-04-01', 10, 1000, 200),
    bucket('2026-04-05', 20, 2000, 400),
    bucket('2026-04-10', 30, 3000, 600),
    bucket('2026-04-15', 40, 4000, 800),
    bucket('2026-04-20', 50, 5000, 1000),
    bucket('2026-05-01', 99, 9000, 1800), // outside all April ranges
  ];

  it('sums all buckets within the inclusive range', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-04-01', to: '2026-04-15' });
    expect(result.costUsd).toBe(100);
    expect(result.inputTokens).toBe(10000);
    expect(result.outputTokens).toBe(2000);
    expect(result.totalTokens).toBe(12000);
  });

  it('includes the range boundary dates (inclusive both ends)', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-04-05', to: '2026-04-10' });
    expect(result.costUsd).toBe(50);
  });

  it('excludes buckets outside the range', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-04-01', to: '2026-04-20' });
    // Excludes 2026-05-01
    expect(result.costUsd).toBe(150);
  });

  it('returns zero totals when no buckets match', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-03-01', to: '2026-03-31' });
    expect(result.costUsd).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('returns zero totals for an empty buckets array', () => {
    const result = aggregateDailyBuckets([], { from: '2026-04-01', to: '2026-04-30' });
    expect(result.costUsd).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('single-day range matches exactly that day', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-04-10', to: '2026-04-10' });
    expect(result.costUsd).toBe(30);
  });

  it('totalTokens equals inputTokens + outputTokens', () => {
    const result = aggregateDailyBuckets(series, { from: '2026-04-01', to: '2026-04-20' });
    expect(result.totalTokens).toBe(result.inputTokens + result.outputTokens);
  });
});

// ---------------------------------------------------------------------------
// periodDisplayLabel
// ---------------------------------------------------------------------------

describe('periodDisplayLabel', () => {
  it('returns MTD for mtd period', () => {
    const range = { from: '2026-04-01', to: '2026-04-15' };
    expect(periodDisplayLabel('mtd', range)).toBe('MTD');
  });

  it('returns Prev Month for prev-month period', () => {
    const range = { from: '2026-03-01', to: '2026-03-31' };
    expect(periodDisplayLabel('prev-month', range)).toBe('Prev Month');
  });

  it('returns YTD for ytd period', () => {
    const range = { from: '2026-01-01', to: '2026-07-04' };
    expect(periodDisplayLabel('ytd', range)).toBe('YTD');
  });

  it('custom within same year shows no year', () => {
    const range = { from: '2026-04-01', to: '2026-04-28' };
    expect(periodDisplayLabel('custom', range)).toBe('Apr 1 – Apr 28');
  });

  it('custom spanning years includes year on both sides', () => {
    const range = { from: '2025-12-28', to: '2026-01-04' };
    expect(periodDisplayLabel('custom', range)).toBe('Dec 28 2025 – Jan 4 2026');
  });

  it('custom single day displays correctly', () => {
    const range = { from: '2026-03-15', to: '2026-03-15' };
    expect(periodDisplayLabel('custom', range)).toBe('Mar 15 – Mar 15');
  });
});
