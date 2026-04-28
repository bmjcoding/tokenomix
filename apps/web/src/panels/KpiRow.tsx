/**
 * KpiRow — four actionable MetricCards for the redesigned dashboard.
 *
 * Cards (in order):
 *   1. TOKENS · 30D     — inputTokens30d + outputTokens30d; real prev-30d delta
 *   2. COST / OUTPUT TOKEN (30D) — costUsd30d / outputTokens30d; per-day sparkline
 *   3. TURN P90 COST (30D) — turnCostP90_30d; p50/p99 context line; no sparkline
 *   4. COST WoW DELTA     — pctDelta of last two weeklySeries entries; no sparkline
 *
 * Architecture: prop-driven. KpiRow accepts a MetricSummary prop — it does NOT
 * self-fetch. OverviewPage owns the single useQuery and passes data down.
 *
 * Empty/zero state contract:
 *   - Any divide-by-zero or missing prev-period data renders em-dash (null delta).
 *   - Zero headline values render "0" (or "$0.0000") — not NaN or undefined.
 *   - weeklySeries < 2 entries → WoW card renders em-dash value and null delta.
 */

import type { MetricSummary } from '@tokenomix/shared';
import { BarChart2, Cpu, DollarSign, TrendingUp } from 'lucide-react';
import { formatCurrency, pctDelta } from '../lib/formatters.js';
import { Section } from '../ui/Section.js';
import { MetricCard } from './MetricCard.js';

// ---------------------------------------------------------------------------
// Inline formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a large integer with K/M/B suffix.
 * One decimal place to keep labels compact (e.g. "15.8M", "1.2k").
 */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/**
 * Formats a cost-per-output-token value as an adaptive micro-dollar string.
 * e.g. 0.000004 → "$0.0000" (4dp), 0.0042 → "$0.0042", 0.12 → "$0.12"
 * Appends "/tok" suffix for per-token display.
 * Returns em-dash string when value is not finite (divide-by-zero guard).
 */
function formatCostPerToken(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  return `${formatCurrency(usd)}/tok`;
}

// ---------------------------------------------------------------------------
// KpiRow
// ---------------------------------------------------------------------------

interface KpiRowProps {
  /** Pre-fetched MetricSummary from OverviewPage's single useQuery call. */
  data: MetricSummary;
}

export function KpiRow({ data }: KpiRowProps) {
  // ── Card 1 — TOKENS · 30D ─────────────────────────────────────────────────
  // Headline: 30-day total of input + output tokens only (cache excluded).
  // Delta: pctDelta vs prior 30-day window (days 31-60), null when prev is zero.
  const tokens30d = data.inputTokens30d + data.outputTokens30d;
  const tokensPrev30d = data.inputTokensPrev30d + data.outputTokensPrev30d;
  const tokensDelta = pctDelta(tokens30d, tokensPrev30d);
  // Sparkline: daily token sums from monthlyRollup
  const tokensSparkline = data.monthlyRollup.current.dailyTokens;

  // ── Card 2 — COST / OUTPUT TOKEN (30D) ───────────────────────────────────
  // Headline: costUsd30d / outputTokens30d — guard divide-by-zero with em-dash.
  const costPerOutputToken =
    data.outputTokens30d > 0 ? data.costUsd30d / data.outputTokens30d : null;

  const costPerTokenStr =
    costPerOutputToken !== null ? formatCostPerToken(costPerOutputToken) : '—';

  // Delta: pctDelta vs prior period — both denominators must be non-zero.
  const costPerTokenPrev =
    data.outputTokensPrev30d > 0 ? data.costUsd30dPrev / data.outputTokensPrev30d : null;

  const costPerTokenDelta =
    costPerOutputToken !== null && costPerTokenPrev !== null
      ? pctDelta(costPerOutputToken, costPerTokenPrev)
      : null;

  // Sparkline: cost-per-output-token per day — skip days with 0 outputTokens.
  const costPerTokenSparkline: number[] = data.dailySeries
    .filter((d) => d.outputTokens > 0)
    .map((d) => d.costUsd / d.outputTokens);

  // ── Card 3 — TURN P90 COST (30D) ─────────────────────────────────────────
  // Headline: turnCostP90_30d formatted as currency.
  // Context: "P50: $X.XXXX · P99: $X.XXXX"
  // Delta: null — no prior-period percentile available.
  const p90Str = data.turnCostP90_30d > 0 ? formatCurrency(data.turnCostP90_30d) : '—';
  const p50Str = data.turnCostP50_30d > 0 ? formatCurrency(data.turnCostP50_30d) : '—';
  const p99Str = data.turnCostP99_30d > 0 ? formatCurrency(data.turnCostP99_30d) : '—';
  const turnCostContext = `P50: ${p50Str} · P99: ${p99Str}`;

  // ── Card 4 — COST WoW DELTA ───────────────────────────────────────────────
  // Derive from weeklySeries: compare last two entries sorted by weekStart.
  // Guard: fewer than 2 entries → em-dash headline, null delta.
  const sortedWeeks = [...data.weeklySeries].sort((a, b) =>
    a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0
  );

  // Use explicit index access — TypeScript can't narrow from length checks on
  // ternary-assigned consts when exactOptionalPropertyTypes is on.
  const lastWeekEntry = sortedWeeks[sortedWeeks.length - 1] ?? null;
  const prevWeekEntry = sortedWeeks[sortedWeeks.length - 2] ?? null;

  // wowDelta: number for the colored pill when 2+ weeks exist; null → em-dash pill.
  // value: absolute this-week cost as the headline (meaningful even without delta);
  //        em-dash when fewer than 2 weeks so the card has no standalone signal.
  const wowDelta =
    lastWeekEntry !== null && prevWeekEntry !== null
      ? pctDelta(lastWeekEntry.costUsd, prevWeekEntry.costUsd)
      : null;

  const wowValueStr =
    sortedWeeks.length >= 2 && lastWeekEntry !== null ? formatCurrency(lastWeekEntry.costUsd) : '—';

  // Context: shows the prior-week cost for reference when delta is available.
  const wowContext: string | undefined =
    prevWeekEntry !== null ? `vs ${formatCurrency(prevWeekEntry.costUsd)} prev week` : undefined;

  return (
    <Section title="Key Metrics" cols={4} gap="md">
      {/* Card 1 — TOKENS · 30D */}
      <MetricCard
        label="TOKENS · 30D"
        value={formatTokenCount(tokens30d)}
        sparklineData={tokensSparkline}
        deltaPercent={tokensDelta}
        icon={<Cpu size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 2 — COST / OUTPUT TOKEN (30D) */}
      <MetricCard
        label="COST / OUTPUT TOKEN (30D)"
        value={costPerTokenStr}
        {...(costPerTokenSparkline.length > 1 ? { sparklineData: costPerTokenSparkline } : {})}
        deltaPercent={costPerTokenDelta}
        icon={<DollarSign size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 3 — TURN P90 COST (30D) */}
      <MetricCard
        label="TURN P90 COST (30D)"
        value={p90Str}
        deltaPercent={null}
        context={turnCostContext}
        icon={<BarChart2 size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 4 — COST WoW DELTA */}
      <MetricCard
        label="COST WoW DELTA"
        value={wowValueStr}
        deltaPercent={wowDelta}
        {...(wowContext !== undefined ? { context: wowContext } : {})}
        icon={<TrendingUp size={14} aria-hidden="true" className="shrink-0" />}
      />
    </Section>
  );
}
