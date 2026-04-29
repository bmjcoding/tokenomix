/**
 * derive.test.ts — Vitest unit tests for derive.ts.
 *
 * All fixtures are purely in-memory — no API calls, no msw.
 */

import type { DailyBucket, HeatmapPoint } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import {
  computeCacheEfficiency,
  computeDailyEfficiencySeries,
  getLast24hSeries,
  getYtdSeries,
} from './derive.js';

// ---------------------------------------------------------------------------
// getLast24hSeries
// ---------------------------------------------------------------------------

describe('getLast24hSeries', () => {
  const anchorNow = new Date(2026, 3, 29, 9, 30);

  it('returns 25 consecutive boundary entries for a 24-hour span when given data', () => {
    const points: HeatmapPoint[] = [];
    for (const date of ['2026-04-28', '2026-04-29']) {
      for (let hour = 0; hour < 24; hour++) {
        points.push({ date, hour, costUsd: hour });
      }
    }

    const result = getLast24hSeries(points, anchorNow);

    expect(result).toHaveLength(25);
    expect(result[0]).toMatchObject({ date: '2026-04-28', hour: 9 });
    expect(result[24]).toMatchObject({ date: '2026-04-29', hour: 9 });
  });

  it('fills missing hours with zero-cost buckets', () => {
    const points: HeatmapPoint[] = [
      { date: '2026-04-29', hour: 8, costUsd: 1.0 },
      { date: '2026-04-29', hour: 9, costUsd: 2.0 },
    ];

    const result = getLast24hSeries(points, anchorNow);

    expect(result).toHaveLength(25);
    expect(result.at(-2)).toEqual({ date: '2026-04-29', hour: 8, costUsd: 1.0 });
    expect(result.at(-1)).toEqual({ date: '2026-04-29', hour: 9, costUsd: 2.0 });
    expect(result.slice(0, -2).every((p) => p.costUsd === 0)).toBe(true);
  });

  it('returns entries in ascending chronological order', () => {
    const result = getLast24hSeries([{ date: '2026-04-29', hour: 9, costUsd: 1 }], anchorNow);

    const keys = result.map((p) => `${p.date}T${String(p.hour).padStart(2, '0')}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('preserves chronological order across midnight', () => {
    const points: HeatmapPoint[] = [
      { date: '2026-04-29', hour: 2, costUsd: 2 },
      { date: '2026-04-28', hour: 22, costUsd: 22 },
      { date: '2026-04-29', hour: 0, costUsd: 0.5 },
      { date: '2026-04-28', hour: 23, costUsd: 23 },
      { date: '2026-04-29', hour: 1, costUsd: 1 },
    ];

    const result = getLast24hSeries(points, new Date(2026, 3, 29, 2, 30));

    expect(
      result
        .filter((p) => p.costUsd > 0)
        .map((p) => `${p.date}T${String(p.hour).padStart(2, '0')}:00`)
    ).toEqual([
      '2026-04-28T22:00',
      '2026-04-28T23:00',
      '2026-04-29T00:00',
      '2026-04-29T01:00',
      '2026-04-29T02:00',
    ]);
  });

  it('excludes buckets outside the rolling 24-hour window', () => {
    const points: HeatmapPoint[] = [
      { date: '2026-04-28', hour: 8, costUsd: 99 },
      { date: '2026-04-28', hour: 9, costUsd: 1 },
      { date: '2026-04-29', hour: 9, costUsd: 2 },
      { date: '2026-04-29', hour: 10, costUsd: 99 },
    ];

    const result = getLast24hSeries(points, anchorNow);

    expect(result[0]).toEqual({ date: '2026-04-28', hour: 9, costUsd: 1 });
    expect(result[24]).toEqual({ date: '2026-04-29', hour: 9, costUsd: 2 });
    expect(result.some((p) => p.costUsd === 99)).toBe(false);
  });

  it('returns an empty array when given an empty input', () => {
    expect(getLast24hSeries([])).toHaveLength(0);
  });

  it('preserves date, hour, and cost fields for chart timestamps', () => {
    const points: HeatmapPoint[] = [{ date: '2026-04-27', hour: 3, costUsd: 0.5 }];
    const result = getLast24hSeries(points, new Date(2026, 3, 27, 3, 30));
    expect(result.at(-1)).toEqual({ date: '2026-04-27', hour: 3, costUsd: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// getYtdSeries
// ---------------------------------------------------------------------------

describe('getYtdSeries', () => {
  it('filters out entries from prior years', () => {
    const currentYear = new Date().getFullYear();
    const series: DailyBucket[] = [
      {
        date: `${currentYear - 1}-12-31`,
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
      },
      {
        date: `${currentYear}-01-01`,
        costUsd: 2,
        inputTokens: 200,
        outputTokens: 100,
        cacheCreationTokens: 20,
        cacheReadTokens: 40,
      },
      {
        date: `${currentYear}-04-15`,
        costUsd: 3,
        inputTokens: 300,
        outputTokens: 150,
        cacheCreationTokens: 30,
        cacheReadTokens: 60,
      },
    ];

    const result = getYtdSeries(series);
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.date.startsWith(String(currentYear)))).toBe(true);
  });

  it('filters out entries from future years', () => {
    const currentYear = new Date().getFullYear();
    const series: DailyBucket[] = [
      {
        date: `${currentYear + 1}-01-01`,
        costUsd: 5,
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
      },
      {
        date: `${currentYear}-06-01`,
        costUsd: 2,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
      },
    ];

    const result = getYtdSeries(series);
    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe(`${currentYear}-06-01`);
  });

  it('preserves the original order of entries', () => {
    const currentYear = new Date().getFullYear();
    const series: DailyBucket[] = [
      {
        date: `${currentYear}-01-10`,
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
      },
      {
        date: `${currentYear}-03-05`,
        costUsd: 2,
        inputTokens: 20,
        outputTokens: 10,
        cacheCreationTokens: 2,
        cacheReadTokens: 4,
      },
      {
        date: `${currentYear}-07-20`,
        costUsd: 3,
        inputTokens: 30,
        outputTokens: 15,
        cacheCreationTokens: 3,
        cacheReadTokens: 6,
      },
    ];

    const result = getYtdSeries(series);
    expect(result).toHaveLength(3);
    expect(result[0]?.date).toBe(`${currentYear}-01-10`);
    expect(result[1]?.date).toBe(`${currentYear}-03-05`);
    expect(result[2]?.date).toBe(`${currentYear}-07-20`);
  });

  it('returns an empty array when given an empty input', () => {
    expect(getYtdSeries([])).toHaveLength(0);
  });

  it('returns an empty array when no entries fall in the current year', () => {
    const currentYear = new Date().getFullYear();
    const series: DailyBucket[] = [
      {
        date: `${currentYear - 2}-06-01`,
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 1,
        cacheReadTokens: 2,
      },
    ];
    expect(getYtdSeries(series)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeCacheEfficiency
// ---------------------------------------------------------------------------

describe('computeCacheEfficiency', () => {
  it('returns 0 when all token counts are zero (zero-denominator guard)', () => {
    expect(
      computeCacheEfficiency({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0 })
    ).toBe(0);
  });

  it('returns 0 when cacheReadTokens is 0 and denominator is nonzero', () => {
    expect(
      computeCacheEfficiency({ cacheReadTokens: 0, cacheCreationTokens: 100, inputTokens: 200 })
    ).toBe(0);
  });

  it('returns 100 when all input-side tokens are cache reads', () => {
    const result = computeCacheEfficiency({
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
      inputTokens: 0,
    });
    expect(result).toBe(100);
  });

  it('computes correct ratio for a typical mixed workload', () => {
    // cacheRead=200, cacheCreation=300, input=500 → denominator=1000
    // efficiency = 200/1000 * 100 = 20
    const result = computeCacheEfficiency({
      cacheReadTokens: 200,
      cacheCreationTokens: 300,
      inputTokens: 500,
    });
    expect(result).toBeCloseTo(20, 5);
  });

  it('returns a value in the 0..100 range for any non-negative inputs', () => {
    const cases: [number, number, number][] = [
      [1, 1, 1],
      [999, 1, 0],
      [0, 999, 1],
      [50, 25, 25],
    ];
    for (const [r, c, i] of cases) {
      const result = computeCacheEfficiency({
        cacheReadTokens: r,
        cacheCreationTokens: c,
        inputTokens: i,
      });
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }
  });

  it('returns 0 when only inputTokens is zero but other counts are zero too', () => {
    expect(
      computeCacheEfficiency({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0 })
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeDailyEfficiencySeries
// ---------------------------------------------------------------------------

describe('computeDailyEfficiencySeries', () => {
  it('returns an empty array when given an empty input', () => {
    expect(computeDailyEfficiencySeries([])).toHaveLength(0);
  });

  it('output length matches input length', () => {
    const series: DailyBucket[] = [
      {
        date: '2026-04-01',
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 20,
        cacheReadTokens: 30,
      },
      {
        date: '2026-04-02',
        costUsd: 2,
        inputTokens: 200,
        outputTokens: 80,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        date: '2026-04-03',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const result = computeDailyEfficiencySeries(series);
    expect(result).toHaveLength(3);
  });

  it('returns 0 for a bucket where all token counts are zero (per-bucket zero guard)', () => {
    const series: DailyBucket[] = [
      {
        date: '2026-04-01',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const result = computeDailyEfficiencySeries(series);
    expect(result[0]).toBe(0);
  });

  it('returns 0 for a bucket where cacheReadTokens is 0', () => {
    const series: DailyBucket[] = [
      {
        date: '2026-04-01',
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 50,
        cacheReadTokens: 0,
      },
    ];
    const result = computeDailyEfficiencySeries(series);
    expect(result[0]).toBe(0);
  });

  it('computes per-bucket efficiency correctly for a mixed series', () => {
    // Bucket A: cacheRead=100, cacheCreation=200, input=700 → denominator=1000 → 10%
    // Bucket B: cacheRead=0, cacheCreation=0, input=0 → 0%
    // Bucket C: cacheRead=500, cacheCreation=0, input=0 → 100%
    const series: DailyBucket[] = [
      {
        date: '2026-04-01',
        costUsd: 1,
        inputTokens: 700,
        outputTokens: 0,
        cacheCreationTokens: 200,
        cacheReadTokens: 100,
      },
      {
        date: '2026-04-02',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        date: '2026-04-03',
        costUsd: 2,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 500,
      },
    ];
    const result = computeDailyEfficiencySeries(series);
    expect(result[0]).toBeCloseTo(10, 5);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(100);
  });

  it('all output values are in the 0..100 range', () => {
    const series: DailyBucket[] = [
      {
        date: '2026-04-01',
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 0,
        cacheCreationTokens: 50,
        cacheReadTokens: 25,
      },
      {
        date: '2026-04-02',
        costUsd: 2,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 999,
      },
    ];
    const result = computeDailyEfficiencySeries(series);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
