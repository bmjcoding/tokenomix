/**
 * KpiRow2.test.tsx — Vitest smoke tests for KpiRow2 derivation logic.
 *
 * These tests verify the derivation formulas that KpiRow2.tsx applies to a
 * MetricSummary before rendering. No DOM renderer is required — the test
 * style mirrors apps/web/src/lib/derive.test.ts and csvExport.test.ts:
 * pure function assertions against in-memory fixtures.
 *
 * Coverage:
 *   - Empty/zero state: byTool=[] → 2 cards, worst-tool card hidden
 *   - Populated state with no errorRate: byTool non-empty but all errorRates=0 → 2 cards
 *   - Populated state with errorRate>0: worst-tool card shows → 3 cards
 *
 * Derivations under test (mirroring KpiRow2.tsx exactly):
 *   Card 1 — PROJECTS TOUCHED
 *     Intl.NumberFormat('en-US').format(totalProjectsTouched)
 *
 *   Card 2 — AVG COST / TURN (30D)
 *     formatCurrency(avgCostPerTurn30d)
 *     pctDelta(avgCostPerTurn30d, avgCostPerTurnPrev30d) — null when prev is 0
 *
 *   Card 3 — WORST TOOL ERROR (conditional)
 *     worstTool = byTool.sort(desc errorRate)[0] when byTool non-empty
 *     showCard = worstTool !== undefined && worstTool.errorRate > 0
 *     sectionCols: 3 when shown, 2 when hidden
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
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalSessions: 0,
    totalProjects: 0,
    totalProjectsTouched: 0,
    costUsd30d: 0,
    costUsd5d: 0,
    inputTokens30d: 0,
    outputTokens30d: 0,
    cacheCreationTokens30d: 0,
    cacheReadTokens30d: 0,
    dailySeries: [],
    weeklySeries: [],
    byModel: [],
    byProject: [],
    byProject30d: [],
    bySession: [],
    heatmapData: [],
    byTool: [],
    bySubagent: [],
    totalFilesTouched: 0,
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
    turnCostP50_30d: 0,
    turnCostP90_30d: 0,
    turnCostP99_30d: 0,
    inputTokensPrev30d: 0,
    outputTokensPrev30d: 0,
    costUsd30dPrev: 0,
    retroRollup: null,
    retroTimeline: [],
    retroForecast: [],
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
// Inline derivation helpers (mirror KpiRow2.tsx exactly)
// ---------------------------------------------------------------------------

// Must stay in sync with the constant in KpiRow2.tsx.
const MIN_TOOL_CALLS_FOR_ERROR_RATE = 10;

function deriveCard1(data: MetricSummary) {
  return {
    value: new Intl.NumberFormat('en-US').format(data.totalProjectsTouched),
  };
}

function deriveCard2(data: MetricSummary) {
  return {
    value: formatCurrency(data.avgCostPerTurn30d),
    delta: pctDelta(data.avgCostPerTurn30d, data.avgCostPerTurnPrev30d),
  };
}

function deriveWorstTool(data: MetricSummary) {
  // Mirror KpiRow2.tsx: filter to tools with >= MIN_TOOL_CALLS_FOR_ERROR_RATE
  // calls before sorting, so single-use failures can't dominate the metric.
  const qualifiedTools = data.byTool.filter(
    (t) => t.count >= MIN_TOOL_CALLS_FOR_ERROR_RATE,
  );
  const worstTool =
    qualifiedTools.length > 0
      ? [...qualifiedTools].sort((a, b) => b.errorRate - a.errorRate)[0]
      : undefined;
  const showWorstToolCard = worstTool !== undefined && worstTool.errorRate > 0;
  const sectionCols = showWorstToolCard ? 3 : 2;
  const worstToolValue = showWorstToolCard
    ? `${(worstTool.errorRate * 100).toFixed(1)}%`
    : undefined;
  return { worstTool, showWorstToolCard, sectionCols, worstToolValue };
}

// ---------------------------------------------------------------------------
// Empty / zero state (byTool=[])
// ---------------------------------------------------------------------------

describe('KpiRow2 — empty/zero state (byTool=[])', () => {
  const data = buildMetricSummaryFixture();

  it('Card 1: renders "0" for totalProjectsTouched when zero', () => {
    const { value } = deriveCard1(data);
    expect(value).toBe('0');
  });

  it('Card 2: avgCostPerTurn renders "$0.0000" when zero (sub-cent path)', () => {
    const { value } = deriveCard2(data);
    expect(value).toBe('$0.0000');
  });

  it('Card 2: delta is null when avgCostPerTurnPrev30d is zero', () => {
    const { delta } = deriveCard2(data);
    expect(delta).toBeNull();
  });

  it('worst-tool: worstTool is undefined when byTool is empty', () => {
    const { worstTool } = deriveWorstTool(data);
    expect(worstTool).toBeUndefined();
  });

  it('worst-tool: showWorstToolCard is false when byTool is empty', () => {
    const { showWorstToolCard } = deriveWorstTool(data);
    expect(showWorstToolCard).toBe(false);
  });

  it('Section cols is 2 when worst-tool card is hidden', () => {
    const { sectionCols } = deriveWorstTool(data);
    expect(sectionCols).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// byTool non-empty but all errorRates = 0 → still 2 cards
// ---------------------------------------------------------------------------

describe('KpiRow2 — byTool has tools but all errorRate=0', () => {
  const data = buildMetricSummaryFixture({
    byTool: [
      { toolName: 'Bash', count: 100, errorCount: 0, errorRate: 0 },
      { toolName: 'Read', count: 200, errorCount: 0, errorRate: 0 },
    ],
  });

  it('worst-tool: worstTool is defined (Bash or Read)', () => {
    const { worstTool } = deriveWorstTool(data);
    expect(worstTool).toBeDefined();
  });

  it('worst-tool: showWorstToolCard is false when highest errorRate is 0', () => {
    const { showWorstToolCard } = deriveWorstTool(data);
    expect(showWorstToolCard).toBe(false);
  });

  it('Section cols is 2 when worst tool errorRate is 0', () => {
    const { sectionCols } = deriveWorstTool(data);
    expect(sectionCols).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Populated state (errorRate > 0 → 3 cards)
// ---------------------------------------------------------------------------

describe('KpiRow2 — populated state (worst tool errorRate > 0)', () => {
  const data = buildMetricSummaryFixture({
    totalProjectsTouched: 7,
    avgCostPerTurn30d: 0.0235,
    avgCostPerTurnPrev30d: 0.0195,
    byTool: [
      { toolName: 'Bash', count: 80, errorCount: 10, errorRate: 0.125 },
      { toolName: 'Read', count: 200, errorCount: 4, errorRate: 0.02 },
      { toolName: 'Write', count: 50, errorCount: 0, errorRate: 0 },
    ],
  });

  it('Card 1: renders formatted project count', () => {
    const { value } = deriveCard1(data);
    expect(value).toBe('7');
  });

  it('Card 2: delta is non-null when prev30d > 0', () => {
    const { delta } = deriveCard2(data);
    expect(delta).not.toBeNull();
    // (0.0235 - 0.0195) / 0.0195 * 100 ≈ 20.51%
    if (delta !== null) expect(delta).toBeCloseTo(((0.0235 - 0.0195) / 0.0195) * 100, 3);
  });

  it('worst-tool: identifies Bash as worst tool (highest errorRate)', () => {
    const { worstTool } = deriveWorstTool(data);
    expect(worstTool?.toolName).toBe('Bash');
  });

  it('worst-tool: showWorstToolCard is true when errorRate > 0', () => {
    const { showWorstToolCard } = deriveWorstTool(data);
    expect(showWorstToolCard).toBe(true);
  });

  it('Section cols is 3 when worst-tool card is shown', () => {
    const { sectionCols } = deriveWorstTool(data);
    expect(sectionCols).toBe(3);
  });

  it('worst-tool: worstToolValue formats as percentage string', () => {
    const { worstToolValue } = deriveWorstTool(data);
    expect(worstToolValue).toBe('12.5%');
  });

  it('worst-tool: picks the tool with the single highest errorRate from any array order', () => {
    const shuffled = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'Write', count: 50, errorCount: 0, errorRate: 0 },
        { toolName: 'Read', count: 200, errorCount: 4, errorRate: 0.02 },
        { toolName: 'Bash', count: 80, errorCount: 10, errorRate: 0.125 },
      ],
    });
    const { worstTool } = deriveWorstTool(shuffled);
    expect(worstTool?.toolName).toBe('Bash');
  });

  it('worst-tool: a single-tool array with errorRate>0 shows the card', () => {
    const single = buildMetricSummaryFixture({
      byTool: [{ toolName: 'Edit', count: 30, errorCount: 3, errorRate: 0.1 }],
    });
    const { showWorstToolCard, worstToolValue } = deriveWorstTool(single);
    expect(showWorstToolCard).toBe(true);
    expect(worstToolValue).toBe('10.0%');
  });
});

// ---------------------------------------------------------------------------
// Min-call guard: tools with fewer than MIN_TOOL_CALLS_FOR_ERROR_RATE calls
// must not win the worst-tool slot (single-use failure filtering).
// ---------------------------------------------------------------------------

describe('KpiRow2 — MIN_TOOL_CALLS_FOR_ERROR_RATE guard', () => {
  it('hides worst-tool card when the only tool with errorRate>0 has too few calls', () => {
    // mcp__claude-in-chrome__tabs_context_mcp used once and failed → 100% error rate.
    // With only 1 call it must NOT show as worst tool.
    const data = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'mcp__claude-in-chrome__tabs_context_mcp', count: 1, errorCount: 1, errorRate: 1.0 },
      ],
    });
    const { worstTool, showWorstToolCard } = deriveWorstTool(data);
    expect(worstTool).toBeUndefined();
    expect(showWorstToolCard).toBe(false);
  });

  it('hides worst-tool card when all tools are below the threshold', () => {
    const data = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'RareTool', count: 5, errorCount: 5, errorRate: 1.0 },
        { toolName: 'AnotherRare', count: 3, errorCount: 3, errorRate: 1.0 },
      ],
    });
    const { worstTool, showWorstToolCard } = deriveWorstTool(data);
    expect(worstTool).toBeUndefined();
    expect(showWorstToolCard).toBe(false);
  });

  it('selects only from tools that meet the threshold when some are below it', () => {
    // RareTool has 100% error rate but only 1 call — filtered out.
    // Bash has 20% error rate and 50 calls — passes filter and wins the slot.
    const data = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'RareTool', count: 1, errorCount: 1, errorRate: 1.0 },
        { toolName: 'Bash', count: 50, errorCount: 10, errorRate: 0.2 },
      ],
    });
    const { worstTool, showWorstToolCard, worstToolValue } = deriveWorstTool(data);
    expect(worstTool?.toolName).toBe('Bash');
    expect(showWorstToolCard).toBe(true);
    expect(worstToolValue).toBe('20.0%');
  });

  it('shows card when exactly MIN_TOOL_CALLS_FOR_ERROR_RATE calls are present', () => {
    const data = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'Edit', count: MIN_TOOL_CALLS_FOR_ERROR_RATE, errorCount: 1, errorRate: 0.1 },
      ],
    });
    const { showWorstToolCard } = deriveWorstTool(data);
    expect(showWorstToolCard).toBe(true);
  });

  it('hides card when one below threshold call exists (count = MIN - 1)', () => {
    const data = buildMetricSummaryFixture({
      byTool: [
        { toolName: 'Edit', count: MIN_TOOL_CALLS_FOR_ERROR_RATE - 1, errorCount: 1, errorRate: 0.1 },
      ],
    });
    const { worstTool } = deriveWorstTool(data);
    expect(worstTool).toBeUndefined();
  });
});
