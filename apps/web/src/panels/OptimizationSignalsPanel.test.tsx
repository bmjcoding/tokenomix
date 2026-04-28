/**
 * OptimizationSignalsPanel.test.tsx — Vitest smoke tests for
 * OptimizationSignalsPanel derivation logic.
 *
 * These tests verify the derivation formulas that OptimizationSignalsPanel.tsx
 * applies to a MetricSummary before rendering. No DOM renderer is required —
 * the test style mirrors apps/web/src/lib/derive.test.ts and csvExport.test.ts:
 * pure function assertions against in-memory fixtures.
 *
 * Coverage:
 *   - Empty state: bySubagent=[] && byProject=[] → 1 card (P90 only); cardCount=1
 *   - Populated state: both non-empty → 3 cards; cardCount=3
 *   - Project name truncation: >24 chars → truncated with ellipsis
 *   - Cost share computation: (top.costUsd / costUsd30d * 100).toFixed(1)
 *   - costUsd30d=0 guard: share renders em-dash string
 *   - Subagent weighted success rate: sum(dispatches*successRate)/sum(dispatches)
 *   - Duration formatting for P90 SESSION DURATION card
 *
 * Derivations under test (mirroring OptimizationSignalsPanel.tsx exactly):
 *   Card 1 — P90 SESSION DURATION (always)
 *     value = "—" when totalCounted === 0; else formatDurationMinutes(p90Minutes)
 *     context = "P50: ... · N sessions"
 *
 *   Card 2 — SUBAGENT SUCCESS RATE (conditional)
 *     showCard = bySubagent.length > 0
 *     weightedRate = sum(d*r)/sum(d)
 *     cardCount increases by 1
 *
 *   Card 3 — TOP EXPENSIVE PROJECT (conditional)
 *     showCard = byProject.length > 0
 *     topProject = byProject sorted desc by costUsd [0]
 *     basename(project) applied before truncation (last path segment)
 *     truncated to 24 chars with '…'
 *     share = (top.costUsd / costUsd30d * 100).toFixed(1) | '—'
 *     cardCount increases by 1
 */

import type { MetricSummary } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import { formatDurationMinutes } from '../lib/formatters.js';

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
    bySession: [],
    heatmapData: [],
    byTool: [],
    bySubagent: [],
    totalFilesTouched: 0,
    avgCostPerTurn30d: 0,
    avgCostPerTurnPrev30d: 0,
    toolErrorRate30d: 0,
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
// Inline derivation helpers (mirror OptimizationSignalsPanel.tsx exactly)
// ---------------------------------------------------------------------------

// formatDurationMinutes is imported from lib/formatters.ts (shared export).

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) return path;
  const segment = trimmed.slice(idx + 1);
  return segment.length > 0 ? segment : path;
}

function truncateProject(name: string): string {
  if (name.length <= 24) return name;
  return `${name.slice(0, 22)}…`;
}

function derivePanel(data: MetricSummary) {
  const { monthlyRollup, bySubagent, byProject, costUsd30d } = data;
  const { p90Minutes, medianMinutes, totalCounted } = monthlyRollup.current.sessionDuration;

  // Card 1 — always present
  // Zero-state: totalCounted === 0 → "—" (mirrors OptimizationSignalsPanel.tsx)
  const p90Str = totalCounted === 0 ? '—' : formatDurationMinutes(p90Minutes);
  const p50ContextStr = `P50: ${totalCounted === 0 ? '—' : formatDurationMinutes(medianMinutes)}`;
  const sessionCountStr =
    totalCounted === 1 ? '1 session' : `${totalCounted.toLocaleString('en-US')} sessions`;
  const p90FullContext = `${p50ContextStr} · ${sessionCountStr}`;

  // Card 2 — conditional
  const showSubagentCard = bySubagent.length > 0;
  let subagentRateStr = '—';
  let subagentContext: string | undefined;
  if (showSubagentCard) {
    const totalDispatches = bySubagent.reduce((sum, s) => sum + s.dispatches, 0);
    const weightedSum = bySubagent.reduce((sum, s) => sum + s.dispatches * s.successRate, 0);
    const weightedRate = totalDispatches > 0 ? weightedSum / totalDispatches : null;
    subagentRateStr = weightedRate !== null ? `${(weightedRate * 100).toFixed(1)}%` : '—';
    subagentContext = `${totalDispatches.toLocaleString('en-US')} dispatch${totalDispatches === 1 ? '' : 'es'} total`;
  }

  // Card 3 — conditional
  const showProjectCard = byProject.length > 0;
  let topProjectName = '';
  let topProjectContext: string | undefined;
  if (showProjectCard) {
    const sorted = [...byProject].sort((a, b) => b.costUsd - a.costUsd);
    const top = sorted[0];
    // Apply basename before truncation, consistent with OptimizationSignalsPanel.tsx.
    // Narrow explicitly to satisfy lint/style/noNonNullAssertion.
    if (top) {
      topProjectName = truncateProject(basename(top.project));
      const shareStr =
        costUsd30d > 0
          ? `${((top.costUsd / costUsd30d) * 100).toFixed(1)}% of 30d spend`
          : '— of 30d spend';
      topProjectContext = shareStr;
    }
  }

  const cardCount = 1 + (showSubagentCard ? 1 : 0) + (showProjectCard ? 1 : 0);

  return {
    p90Str,
    p50ContextStr,
    p90FullContext,
    sessionCountStr,
    showSubagentCard,
    subagentRateStr,
    subagentContext,
    showProjectCard,
    topProjectName,
    topProjectContext,
    cardCount,
  };
}

// ---------------------------------------------------------------------------
// Empty / zero state: bySubagent=[] && byProject=[]
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — empty state (bySubagent=[] && byProject=[])', () => {
  const data = buildMetricSummaryFixture();

  it('cardCount is 1 (P90 card only)', () => {
    const { cardCount } = derivePanel(data);
    expect(cardCount).toBe(1);
  });

  it('showSubagentCard is false when bySubagent is empty', () => {
    const { showSubagentCard } = derivePanel(data);
    expect(showSubagentCard).toBe(false);
  });

  it('showProjectCard is false when byProject is empty', () => {
    const { showProjectCard } = derivePanel(data);
    expect(showProjectCard).toBe(false);
  });

  it('p90Str is "—" when totalCounted is 0', () => {
    const { p90Str } = derivePanel(data);
    expect(p90Str).toBe('—');
  });

  it('p50ContextStr is "P50: —" when totalCounted is 0', () => {
    const { p50ContextStr } = derivePanel(data);
    expect(p50ContextStr).toBe('P50: —');
  });

  it('p90FullContext includes "0 sessions" when totalCounted is 0', () => {
    const { p90FullContext } = derivePanel(data);
    expect(p90FullContext).toBe('P50: — · 0 sessions');
  });
});

// ---------------------------------------------------------------------------
// Populated state: both bySubagent and byProject non-empty → 3 cards
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — populated state (both bySubagent and byProject)', () => {
  const data = buildMetricSummaryFixture({
    costUsd30d: 200,
    bySubagent: [
      {
        agentType: 'sonnet',
        dispatches: 10,
        totalTokens: 5000,
        totalCostUsd: 0.5,
        avgDurationMs: 1200,
        successRate: 0.9,
      },
      {
        agentType: 'haiku',
        dispatches: 20,
        totalTokens: 8000,
        totalCostUsd: 0.3,
        avgDurationMs: 800,
        successRate: 0.95,
      },
    ],
    byProject: [
      { project: 'tokenomix', costUsd: 120, inputTokens: 1000, outputTokens: 500, events: 50 },
      { project: 'other-proj', costUsd: 80, inputTokens: 600, outputTokens: 300, events: 30 },
    ],
    monthlyRollup: {
      current: {
        costUsd: 200,
        totalTokens: 10000,
        sessionCount: 5,
        dailyCost: [],
        dailyTokens: [],
        dailySessions: [],
        sessionDuration: {
          medianMinutes: 8.5,
          p90Minutes: 22.3,
          weeklyMedianTrend: [],
          outliersExcluded: 0,
          totalCounted: 5,
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
  });

  it('cardCount is 3 when both bySubagent and byProject are non-empty', () => {
    const { cardCount } = derivePanel(data);
    expect(cardCount).toBe(3);
  });

  it('showSubagentCard is true when bySubagent is non-empty', () => {
    const { showSubagentCard } = derivePanel(data);
    expect(showSubagentCard).toBe(true);
  });

  it('showProjectCard is true when byProject is non-empty', () => {
    const { showProjectCard } = derivePanel(data);
    expect(showProjectCard).toBe(true);
  });

  it('p90Str formats 22.3 minutes as "22m 18s"', () => {
    const { p90Str } = derivePanel(data);
    // 22.3 min = 22*60 + 0.3*60 = 1320 + 18 = 1338s → "22m 18s"
    expect(p90Str).toBe('22m 18s');
  });

  it('p90FullContext includes session count when totalCounted > 0', () => {
    const { p90FullContext } = derivePanel(data);
    // totalCounted = 5, medianMinutes = 8.5 → "8m 30s"
    expect(p90FullContext).toBe('P50: 8m 30s · 5 sessions');
  });

  it('subagentRateStr computes weighted success rate correctly', () => {
    const { subagentRateStr } = derivePanel(data);
    // sonnet: 10 * 0.9 = 9; haiku: 20 * 0.95 = 19; total = 28; dispatches = 30
    // rate = 28/30 = 0.9333… → "93.3%"
    expect(subagentRateStr).toBe('93.3%');
  });

  it('subagentContext shows total dispatch count', () => {
    const { subagentContext } = derivePanel(data);
    expect(subagentContext).toBe('30 dispatches total');
  });

  it('topProjectName is the project with highest costUsd', () => {
    const { topProjectName } = derivePanel(data);
    expect(topProjectName).toBe('tokenomix');
  });

  it('topProjectContext shows correct share of 30d spend', () => {
    const { topProjectContext } = derivePanel(data);
    // 120 / 200 * 100 = 60.0%
    expect(topProjectContext).toBe('60.0% of 30d spend');
  });
});

// ---------------------------------------------------------------------------
// Project name truncation
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — project name truncation', () => {
  it('names <= 24 chars are not truncated', () => {
    expect(truncateProject('short-name')).toBe('short-name');
    expect(truncateProject('exactly-24-chars-here!!!')).toBe('exactly-24-chars-here!!!');
  });

  it('names > 24 chars are truncated to 22 chars + ellipsis', () => {
    const long = 'this-project-name-is-very-long-indeed';
    const result = truncateProject(long);
    expect(result).toBe('this-project-name-is-v…');
    // Total length: 22 + 1 (ellipsis char) = 23 chars
    expect(result.length).toBe(23);
  });

  it('name of exactly 25 chars is truncated', () => {
    const name25 = 'a'.repeat(25);
    const result = truncateProject(name25);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBe(23);
  });

  it('the panel uses truncateProject for long project names', () => {
    const longProjectName = 'my-super-long-project-name-over-limit';
    const data = buildMetricSummaryFixture({
      costUsd30d: 50,
      byProject: [
        {
          project: longProjectName,
          costUsd: 50,
          inputTokens: 1000,
          outputTokens: 500,
          events: 10,
        },
      ],
    });
    const { topProjectName } = derivePanel(data);
    expect(topProjectName).toBe(truncateProject(longProjectName));
    expect(topProjectName.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost share edge cases
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — cost share computation', () => {
  it('renders em-dash share when costUsd30d is zero (no division by zero)', () => {
    const data = buildMetricSummaryFixture({
      costUsd30d: 0,
      byProject: [
        { project: 'myproject', costUsd: 10, inputTokens: 100, outputTokens: 50, events: 5 },
      ],
    });
    const { topProjectContext } = derivePanel(data);
    expect(topProjectContext).toBe('— of 30d spend');
  });

  it('renders 100.0% when the top project accounts for all 30d spend', () => {
    const data = buildMetricSummaryFixture({
      costUsd30d: 75,
      byProject: [
        { project: 'myproject', costUsd: 75, inputTokens: 100, outputTokens: 50, events: 5 },
      ],
    });
    const { topProjectContext } = derivePanel(data);
    expect(topProjectContext).toBe('100.0% of 30d spend');
  });

  it('picks the most expensive project regardless of byProject array order', () => {
    const data = buildMetricSummaryFixture({
      costUsd30d: 100,
      byProject: [
        { project: 'cheap', costUsd: 20, inputTokens: 100, outputTokens: 50, events: 5 },
        { project: 'expensive', costUsd: 80, inputTokens: 500, outputTokens: 200, events: 20 },
        { project: 'mid', costUsd: 0, inputTokens: 0, outputTokens: 0, events: 0 },
      ],
    });
    const { topProjectName, topProjectContext } = derivePanel(data);
    expect(topProjectName).toBe('expensive');
    expect(topProjectContext).toBe('80.0% of 30d spend');
  });
});

// ---------------------------------------------------------------------------
// Duration formatting (via shared formatDurationMinutes from lib/formatters.ts)
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — formatDurationMinutes', () => {
  it('returns "0ms" for zero input (delegates to formatDuration(0ms))', () => {
    // formatDuration(0) → "0ms" (sub-1000ms branch)
    expect(formatDurationMinutes(0)).toBe('0ms');
  });

  it('returns seconds string for sub-minute durations', () => {
    // 0.5 min = 30s → formatDuration(30000) = "30s"
    expect(formatDurationMinutes(0.5)).toBe('30s');
  });

  it('returns "Xm" when seconds component is zero', () => {
    // Exactly 5 minutes → formatDuration(300000) = "5m"
    expect(formatDurationMinutes(5)).toBe('5m');
  });

  it('returns "Xm Ys" for fractional minutes under 60', () => {
    // 14.5 min = 870000ms → "14m 30s"
    expect(formatDurationMinutes(14.5)).toBe('14m 30s');
  });

  it('returns "Xh Ym" for durations >= 60 minutes', () => {
    // 90 min = 5400000ms → "1h 30m"
    expect(formatDurationMinutes(90)).toBe('1h 30m');
  });

  it('returns "Xh" when minutes component is zero at hour boundary', () => {
    // Exactly 2 hours = 7200000ms → "2h"
    expect(formatDurationMinutes(120)).toBe('2h');
  });
});

// ---------------------------------------------------------------------------
// Session count context line
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — session count context', () => {
  it('uses singular "session" when totalCounted is 1', () => {
    const data = buildMetricSummaryFixture({
      monthlyRollup: {
        current: {
          costUsd: 0,
          totalTokens: 0,
          sessionCount: 0,
          dailyCost: [],
          dailyTokens: [],
          dailySessions: [],
          sessionDuration: {
            medianMinutes: 5,
            p90Minutes: 10,
            weeklyMedianTrend: [],
            outliersExcluded: 0,
            totalCounted: 1,
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
    });
    const { sessionCountStr } = derivePanel(data);
    expect(sessionCountStr).toBe('1 session');
  });

  it('uses plural "sessions" when totalCounted is > 1', () => {
    const data = buildMetricSummaryFixture({
      monthlyRollup: {
        current: {
          costUsd: 0,
          totalTokens: 0,
          sessionCount: 0,
          dailyCost: [],
          dailyTokens: [],
          dailySessions: [],
          sessionDuration: {
            medianMinutes: 5,
            p90Minutes: 10,
            weeklyMedianTrend: [],
            outliersExcluded: 0,
            totalCounted: 42,
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
    });
    const { sessionCountStr } = derivePanel(data);
    expect(sessionCountStr).toBe('42 sessions');
  });
});

// ---------------------------------------------------------------------------
// Top project basename extraction
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — top project basename', () => {
  it('extracts the last path segment from a full cwd path', () => {
    const data = buildMetricSummaryFixture({
      costUsd30d: 100,
      byProject: [
        {
          project: '/Users/bmj/.claude/projects/my-project',
          costUsd: 100,
          inputTokens: 1000,
          outputTokens: 500,
          events: 10,
        },
      ],
    });
    const { topProjectName } = derivePanel(data);
    expect(topProjectName).toBe('my-project');
  });

  it('falls back to original string when no slash is present', () => {
    const data = buildMetricSummaryFixture({
      costUsd30d: 100,
      byProject: [
        { project: 'plain-name', costUsd: 100, inputTokens: 1000, outputTokens: 500, events: 10 },
      ],
    });
    const { topProjectName } = derivePanel(data);
    expect(topProjectName).toBe('plain-name');
  });
});

// ---------------------------------------------------------------------------
// Subagent: single dispatch (singular "dispatch" label)
// ---------------------------------------------------------------------------

describe('OptimizationSignalsPanel — subagent single dispatch label', () => {
  it('uses singular "dispatch" when totalDispatches is 1', () => {
    const data = buildMetricSummaryFixture({
      bySubagent: [
        {
          agentType: 'sonnet',
          dispatches: 1,
          totalTokens: 500,
          totalCostUsd: 0.05,
          avgDurationMs: 1000,
          successRate: 1.0,
        },
      ],
    });
    const { subagentContext } = derivePanel(data);
    expect(subagentContext).toBe('1 dispatch total');
  });

  it('uses plural "dispatches" when totalDispatches is > 1', () => {
    const data = buildMetricSummaryFixture({
      bySubagent: [
        {
          agentType: 'sonnet',
          dispatches: 5,
          totalTokens: 2500,
          totalCostUsd: 0.25,
          avgDurationMs: 1000,
          successRate: 0.8,
        },
      ],
    });
    const { subagentContext } = derivePanel(data);
    expect(subagentContext).toBe('5 dispatches total');
  });
});
