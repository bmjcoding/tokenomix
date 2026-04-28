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
  it('returns exactly 24 entries when given more than 24 points', () => {
    // Build 48 heatmap points across two days (hours 0-23 each).
    const points: HeatmapPoint[] = [];
    for (let h = 0; h < 24; h++) {
      points.push({ date: '2026-04-26', hour: h, costUsd: h * 0.1 });
      points.push({ date: '2026-04-27', hour: h, costUsd: h * 0.2 });
    }

    const result = getLast24hSeries(points);
    expect(result).toHaveLength(24);
  });

  it('returns fewer than 24 entries when given fewer than 24 points', () => {
    const points: HeatmapPoint[] = [
      { date: '2026-04-27', hour: 10, costUsd: 1.0 },
      { date: '2026-04-27', hour: 11, costUsd: 2.0 },
    ];
    const result = getLast24hSeries(points);
    expect(result).toHaveLength(2);
  });

  it('returns entries in ascending order (oldest hour first)', () => {
    const points: HeatmapPoint[] = [];
    // Intentionally add hours out of order.
    for (const h of [5, 23, 1, 14, 8]) {
      points.push({ date: '2026-04-27', hour: h, costUsd: h * 0.1 });
    }
    const result = getLast24hSeries(points);
    for (let i = 1; i < result.length; i++) {
      // Within same day, hour should be non-decreasing.
      const prev = result[i - 1];
      const curr = result[i];
      if (!prev || !curr) throw new Error('unexpected undefined element');
      expect(curr.hour).toBeGreaterThanOrEqual(prev.hour);
    }
  });

  it('selects the most recent 24 when given two days of data (prefers later date)', () => {
    const points: HeatmapPoint[] = [];
    // Day 1: hours 0-23
    for (let h = 0; h < 24; h++) {
      points.push({ date: '2026-04-26', hour: h, costUsd: 0.01 });
    }
    // Day 2: hours 0-23 with higher cost
    for (let h = 0; h < 24; h++) {
      points.push({ date: '2026-04-27', hour: h, costUsd: 1.0 });
    }

    const result = getLast24hSeries(points);
    // All 24 results should come from the more recent day (costUsd === 1.0).
    expect(result.every((p) => p.costUsd === 1.0)).toBe(true);
  });

  it('returns an empty array when given an empty input', () => {
    expect(getLast24hSeries([])).toHaveLength(0);
  });

  it('maps only hour and costUsd fields (no date in output)', () => {
    const points: HeatmapPoint[] = [{ date: '2026-04-27', hour: 3, costUsd: 0.5 }];
    const result = getLast24hSeries(points);
    expect(result[0]).toEqual({ hour: 3, costUsd: 0.5 });
    expect(Object.keys(result[0] as object)).not.toContain('date');
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
