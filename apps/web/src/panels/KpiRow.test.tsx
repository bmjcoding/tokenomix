/**
 * KpiRow.test.tsx — Vitest smoke tests for KpiRow derivation logic.
 *
 * These tests verify the derivation formulas that KpiRow.tsx applies to a
 * MetricSummary before rendering. No DOM renderer is required — the test
 * style mirrors apps/web/src/lib/derive.test.ts and csvExport.test.ts:
 * pure function assertions against in-memory fixtures.
 *
 * Coverage:
 *   - Empty/zero state: all new fields at 0, weeklySeries=[], dailySeries=[]
 *   - Populated state: representative non-zero values including turnCostP90_30d,
 *     weeklySeries with 2 entries, dailySeries with outputTokens data
 *
 * Derivations under test (mirroring KpiRow.tsx exactly):
 *   Card 1 — TOKENS · 30D
 *     tokens30d = inputTokens30d + outputTokens30d
 *     tokensDelta = pctDelta(tokens30d, inputTokensPrev30d + outputTokensPrev30d)
 *
 *   Card 2 — COST / OUTPUT TOKEN (30D)
 *     costPerOutputToken = outputTokens30d > 0 ? costUsd30d / outputTokens30d : null
 *     costPerTokenPrev = outputTokensPrev30d > 0 ? costUsd30dPrev / outputTokensPrev30d : null
 *     costPerTokenDelta = both non-null ? pctDelta(curr, prev) : null
 *     sparkline = dailySeries.filter(d => d.outputTokens > 0).map(d => d.costUsd / d.outputTokens)
 *
 *   Card 3 — TURN P90 COST (30D)
 *     p90Str = turnCostP90_30d > 0 ? formatCurrency(turnCostP90_30d) : '—'
 *     p50Str = turnCostP50_30d > 0 ? formatCurrency(turnCostP50_30d) : '—'
 *
 *   Card 4 — COST WoW DELTA
 *     wowDelta = weeklySeries.length >= 2 ? pctDelta(last, prev) : null
 *     wowValueStr = weeklySeries.length >= 2 ? formatCurrency(lastWeekEntry.costUsd) : '—'
 */

import type { MetricSummary } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import { formatCurrency, pctDelta } from '../lib/formatters.js';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Returns a complete MetricSummary with sane zero defaults.
 * Pass overrides to set specific fields for each test scenario.
 */
function buildMetricSummaryFixture(overrides: Partial<MetricSummary> = {}): MetricSummary {
  const base: MetricSummary = {
    // All-time totals
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalSessions: 0,
    totalProjects: 0,
    totalProjectsTouched: 0,
    // Windowed totals
    costUsd30d: 0,
    costUsd5d: 0,
    inputTokens30d: 0,
    outputTokens30d: 0,
    cacheCreationTokens30d: 0,
    cacheReadTokens30d: 0,
    // Series / breakdown arrays
    dailySeries: [],
    weeklySeries: [],
    byModel: [],
    byProject: [],
    byProject30d: [],
    bySession: [],
    heatmapData: [],
    // Analytics arrays
    byTool: [],
    bySubagent: [],
    totalFilesTouched: 0,
    // Cost-per-turn KPIs
    avgCostPerTurn30d: 0,
    avgCostPerTurnPrev30d: 0,
    toolErrorRate30d: 0,
    costComponents30d: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheCreationCostUsd: 0,
      cacheReadCostUsd: 0,
      webSearchCostUsd: 0,
    },
    turnCostTop1PctShare30d: 0,
    turnCostTop5PctShare30d: 0,
    mainSessionCostUsd30d: 0,
    subagentCostUsd30d: 0,
    agentToolCalls30d: 0,
    opusToSonnetSavings30d: 0,
    optimizationOpportunities: [],
    pricingAudit: {
      catalog: {
        catalogVersion: 'test',
        billingCurrency: 'USD',
        sourceUrl: 'test',
        sourceLastChecked: '2026-04-28',
        precision: 'micro-usd',
        pricingProvider: 'anthropic_1p',
        costBasis: 'estimated_from_jsonl_usage_static_anthropic_catalog',
      },
      provider: 'anthropic_1p',
      bedrockRegion: null,
      bedrockEndpointScope: 'unknown',
      bedrockServiceTier: 'standard',
      bedrockEndpointScopeSource: 'unknown',
      totalCostUsdMicros: 0,
      fallbackPricedRows: 0,
      fallbackPricedCostUsd: 0,
      fallbackPricedCostUsdMicros: 0,
      fallbackPricedModelIds: [],
      zeroUsageUnknownModelRows: 0,
      internalGatewayRatedRows: 0,
      internalGatewayUnratedRows: 0,
      warnings: [],
    },
    ingestionAudit: {
      filesDiscovered: 0,
      filesAttempted: 0,
      filesWithParseWarnings: 0,
      invalidJsonLines: 0,
      schemaMismatchLines: 0,
      fileOpenErrors: 0,
      assistantUsageEvents: 0,
      assistantEventsWithoutUsage: 0,
      missingDedupIdRows: 0,
      duplicateRowsSkipped: 0,
      duplicateRowsReplaced: 0,
      tokenRowsRejected: 0,
      rowsIndexed: 0,
      ingestErrors: 0,
      lastIndexedAt: null,
      warnings: [],
    },
    // Turn-cost percentiles (ST-1a new fields)
    turnCostP50_30d: 0,
    turnCostP90_30d: 0,
    turnCostP99_30d: 0,
    // Prior 30-day window totals (ST-1a new fields)
    inputTokensPrev30d: 0,
    outputTokensPrev30d: 0,
    costUsd30dPrev: 0,
    // Retro stubs
    retroRollup: null,
    retroTimeline: [],
    retroForecast: [],
    // Period rollups
    monthlyRollup: {
      current: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
      previous: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
    },
    quarterlyRollup: {
      current: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
      previous: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
    },
    yearlyRollup: {
      current: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
      previous: {
        costUsd: 0,
        totalTokens: 0,
        sessionCount: 0,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 0,
          p90Minutes: 0,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 0,
        },
      },
    },
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Inline derivation helpers (mirror KpiRow.tsx exactly)
// ---------------------------------------------------------------------------

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

function deriveCard1(data: MetricSummary) {
  const tokens30d = data.inputTokens30d + data.outputTokens30d;
  const tokensPrev30d = data.inputTokensPrev30d + data.outputTokensPrev30d;
  return {
    value: formatTokenCount(tokens30d),
    delta: pctDelta(tokens30d, tokensPrev30d),
  };
}

function deriveCard2(data: MetricSummary) {
  const costPerOutputToken =
    data.outputTokens30d > 0 ? data.costUsd30d / data.outputTokens30d : null;
  const costPerTokenPrev =
    data.outputTokensPrev30d > 0 ? data.costUsd30dPrev / data.outputTokensPrev30d : null;
  const delta =
    costPerOutputToken !== null && costPerTokenPrev !== null
      ? pctDelta(costPerOutputToken, costPerTokenPrev)
      : null;
  const sparkline = data.dailySeries
    .filter((d) => d.outputTokens > 0)
    .map((d) => d.costUsd / d.outputTokens);
  return { costPerOutputToken, delta, sparklineLength: sparkline.length };
}

function deriveCard3(data: MetricSummary) {
  const p90Str = data.turnCostP90_30d > 0 ? formatCurrency(data.turnCostP90_30d) : '—';
  const p50Str = data.turnCostP50_30d > 0 ? formatCurrency(data.turnCostP50_30d) : '—';
  const p99Str = data.turnCostP99_30d > 0 ? formatCurrency(data.turnCostP99_30d) : '—';
  return { p90Str, p50Str, p99Str };
}

function deriveCard4(data: MetricSummary) {
  const sorted = [...data.weeklySeries].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0
  );
  const lastWeek = sorted[sorted.length - 1] ?? null;
  const prevWeek = sorted[sorted.length - 2] ?? null;
  const wowDelta =
    lastWeek !== null && prevWeek !== null ? pctDelta(lastWeek.costUsd, prevWeek.costUsd) : null;
  // Mirror KpiRow.tsx: value = absolute last-week cost when 2+ weeks; em-dash otherwise.
  const wowValueStr =
    sorted.length >= 2 && lastWeek !== null ? formatCurrency(lastWeek.costUsd) : '—';
  return { wowDelta, wowValueStr };
}

// ---------------------------------------------------------------------------
// Empty / zero state
// ---------------------------------------------------------------------------

describe('KpiRow — empty/zero state', () => {
  const data = buildMetricSummaryFixture();

  it('Card 1: renders "0" token count when all token fields are zero', () => {
    const { value } = deriveCard1(data);
    expect(value).toBe('0');
  });

  it('Card 1: delta is null when prev token total is zero (em-dash guard)', () => {
    const { delta } = deriveCard1(data);
    expect(delta).toBeNull();
  });

  it('Card 2: costPerOutputToken is null when outputTokens30d is zero', () => {
    const { costPerOutputToken } = deriveCard2(data);
    expect(costPerOutputToken).toBeNull();
  });

  it('Card 2: delta is null when both period costs are zero (em-dash guard)', () => {
    const { delta } = deriveCard2(data);
    expect(delta).toBeNull();
  });

  it('Card 2: sparkline is empty when dailySeries is empty', () => {
    const { sparklineLength } = deriveCard2(data);
    expect(sparklineLength).toBe(0);
  });

  it('Card 3: p90Str is em-dash when turnCostP90_30d is zero', () => {
    const { p90Str } = deriveCard3(data);
    expect(p90Str).toBe('—');
  });

  it('Card 3: p50Str is em-dash when turnCostP50_30d is zero', () => {
    const { p50Str } = deriveCard3(data);
    expect(p50Str).toBe('—');
  });

  it('Card 4: wowDelta is null when weeklySeries is empty', () => {
    const { wowDelta } = deriveCard4(data);
    expect(wowDelta).toBeNull();
  });

  it('Card 4: wowValueStr is em-dash when weeklySeries is empty', () => {
    const { wowValueStr } = deriveCard4(data);
    expect(wowValueStr).toBe('—');
  });

  it('Card 4: wowDelta is null when weeklySeries has exactly 1 entry', () => {
    const single = buildMetricSummaryFixture({
      weeklySeries: [{ weekStart: '2026-04-21', costUsd: 10, inputTokens: 100, outputTokens: 50 }],
    });
    const { wowDelta } = deriveCard4(single);
    expect(wowDelta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Populated state
// ---------------------------------------------------------------------------

describe('KpiRow — populated state', () => {
  const data = buildMetricSummaryFixture({
    inputTokens30d: 8_000_000,
    outputTokens30d: 2_000_000,
    inputTokensPrev30d: 7_000_000,
    outputTokensPrev30d: 1_500_000,
    costUsd30d: 100,
    costUsd30dPrev: 85,
    turnCostP50_30d: 0.0012,
    turnCostP90_30d: 0.0048,
    turnCostP99_30d: 0.025,
    weeklySeries: [
      { weekStart: '2026-04-14', costUsd: 40, inputTokens: 1000, outputTokens: 500 },
      { weekStart: '2026-04-21', costUsd: 50, inputTokens: 1200, outputTokens: 600 },
    ],
    dailySeries: [
      {
        date: '2026-04-20',
        costUsd: 5,
        inputTokens: 400_000,
        outputTokens: 100_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        date: '2026-04-21',
        costUsd: 0,
        inputTokens: 200_000,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      {
        date: '2026-04-22',
        costUsd: 8,
        inputTokens: 600_000,
        outputTokens: 200_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ],
  });

  it('Card 1: value uses M suffix for millions-range token totals', () => {
    const { value } = deriveCard1(data);
    // 8M + 2M = 10M tokens
    expect(value).toBe('10.0M');
  });

  it('Card 1: delta is computed (non-null) when prev tokens > 0', () => {
    const { delta } = deriveCard1(data);
    expect(delta).not.toBeNull();
    // tokens30d=10M, tokensPrev30d=8.5M → ~17.6% increase
    expect(delta).toBeCloseTo(((10_000_000 - 8_500_000) / 8_500_000) * 100, 3);
  });

  it('Card 2: costPerOutputToken is computed correctly', () => {
    const { costPerOutputToken } = deriveCard2(data);
    // costUsd30d=100, outputTokens30d=2_000_000 → 0.00005
    expect(costPerOutputToken).toBeCloseTo(100 / 2_000_000, 8);
  });

  it('Card 2: delta is non-null when both period values are non-zero', () => {
    const { delta } = deriveCard2(data);
    expect(delta).not.toBeNull();
  });

  it('Card 2: sparkline skips days with zero outputTokens', () => {
    const { sparklineLength } = deriveCard2(data);
    // dailySeries has 3 entries; day 2026-04-21 has outputTokens=0 → skipped
    expect(sparklineLength).toBe(2);
  });

  it('Card 3: p90Str is a currency string when turnCostP90_30d > 0', () => {
    const { p90Str } = deriveCard3(data);
    expect(p90Str).toContain('$');
    expect(p90Str).not.toBe('—');
  });

  it('Card 3: p50Str is a currency string when turnCostP50_30d > 0', () => {
    const { p50Str } = deriveCard3(data);
    expect(p50Str).toContain('$');
    expect(p50Str).not.toBe('—');
  });

  it('Card 3: p99Str is a currency string when turnCostP99_30d > 0', () => {
    const { p99Str } = deriveCard3(data);
    expect(p99Str).toContain('$');
    expect(p99Str).not.toBe('—');
  });

  it('Card 4: wowDelta is non-null when weeklySeries has >= 2 entries', () => {
    const { wowDelta } = deriveCard4(data);
    expect(wowDelta).not.toBeNull();
  });

  it('Card 4: wowValueStr shows currency-formatted last-week cost', () => {
    const { wowValueStr } = deriveCard4(data);
    // lastWeek.costUsd=50 → formatCurrency(50) = '$50.00'
    expect(wowValueStr).toBe('$50.00');
  });

  it('Card 4: wowDelta is negative for a cost decrease', () => {
    const decreasing = buildMetricSummaryFixture({
      weeklySeries: [
        { weekStart: '2026-04-14', costUsd: 60, inputTokens: 0, outputTokens: 0 },
        { weekStart: '2026-04-21', costUsd: 45, inputTokens: 0, outputTokens: 0 },
      ],
    });
    const { wowDelta, wowValueStr } = deriveCard4(decreasing);
    expect(wowDelta).not.toBeNull();
    if (wowDelta !== null) expect(wowDelta).toBeLessThan(0);
    // wowValueStr = formatCurrency(lastWeek.costUsd) = '$45.00' (absolute spend)
    expect(wowValueStr).toBe('$45.00');
  });

  it('Card 4: uses the most recent week when series is unsorted', () => {
    // Series intentionally out of chronological order
    const unsorted = buildMetricSummaryFixture({
      weeklySeries: [
        { weekStart: '2026-04-21', costUsd: 50, inputTokens: 0, outputTokens: 0 },
        { weekStart: '2026-04-07', costUsd: 30, inputTokens: 0, outputTokens: 0 },
        { weekStart: '2026-04-14', costUsd: 40, inputTokens: 0, outputTokens: 0 },
      ],
    });
    const { wowDelta } = deriveCard4(unsorted);
    // After sort: [Apr 7=30, Apr 14=40, Apr 21=50] → pctDelta(50, 40) = +25%
    expect(wowDelta).toBeCloseTo(25, 5);
  });
});
