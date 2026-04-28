/**
 * KpiRow2 — four MetricCards for "Usage Insights" dashboard row.
 *
 * Cards (in order): Active Time / Files Touched / Cost per Turn / Tool Error Rate
 *
 * Architecture: prop-driven. KpiRow2 accepts a MetricSummary prop — it does NOT
 * self-fetch. OverviewPage owns the single useQuery and passes data down,
 * matching the existing KpiRow pattern.
 *
 * Card 1 — Active Time
 *   Headline: formatDuration(data.activeMs30d) → e.g. "14h 32m"
 *   Context:  "Idle " + formatDuration(data.idleMs30d) (planner revision: both MUST be shown)
 *   Delta:    null (em-dash) — no prior-period active/idle data available in MetricSummary
 *
 * Card 2 — Files Touched · Lifetime
 *   Headline: Intl.NumberFormat('en-US').format(totalFilesTouched)
 *   Context:  "unique paths" (totalFilesTouched is a lifetime count de-duped across all rows
 *             in the filtered window; the label carries a "Lifetime" qualifier because
 *             OverviewPage uses a since='all' query for this value, unlike the sibling 30d cards.)
 *
 *   Delta:    null (em-dash) — no prior-period files-touched data available
 *
 * Card 3 — Cost / Turn
 *   Headline: formatCurrency(data.avgCostPerTurn30d) — adaptive: 4 decimals for sub-cent values
 *   Context:  "vs prev 30 days" (shown only when a delta is rendered)
 *   Delta:    pctDelta(avgCostPerTurn30d, avgCostPerTurnPrev30d) — null when prev is 0
 *
 * Card 4 — Tool Error Rate
 *   Headline: (data.toolErrorRate30d * 100).toFixed(1) + "%"
 *   Context:  "tool_use → tool_result error pct"
 *   Delta:    null (em-dash) — no prior-period error-rate field in MetricSummary
 *
 * Formatting helpers are shared from lib/formatters.ts:
 * - formatDuration(ms): canonical multi-scale duration formatter.
 * - formatCurrency(usd): adaptive formatter (≥$0.01 → 2dp, <$0.01 → 4dp).
 */

import type { MetricSummary } from '@tokenomix/shared';
import { Activity, AlertTriangle, FolderOpen, TrendingUp } from 'lucide-react';
import { formatCurrency, formatDuration } from '../lib/formatters.js';
import { Section } from '../ui/Section.js';
import { MetricCard } from './MetricCard.js';

/**
 * Computes percentage delta: ((curr - prev) / prev) * 100.
 * Returns null when prev is 0 to avoid Infinity/NaN — renders as em-dash.
 */
function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

// ---------------------------------------------------------------------------
// KpiRow2
// ---------------------------------------------------------------------------

interface KpiRow2Props {
  /** Pre-fetched MetricSummary from OverviewPage's single useQuery call. */
  data: MetricSummary;
}

export function KpiRow2({ data }: KpiRow2Props) {
  // ── Card 1 — Active Time ─────────────────────────────────────────────────
  // Headline: total active compute time in the 30d window (sum of turnDurationMs).
  // Context: idle time (wallClock30d − active) — both MUST be shown per planner revision.
  // Delta: null — no prior-window active time available in MetricSummary.
  const activeTimeValue = formatDuration(data.activeMs30d);
  const idleTimeContext = `Idle ${formatDuration(data.idleMs30d)}`;

  // ── Card 2 — Files Touched · Lifetime ────────────────────────────────────
  // Headline: cardinality of unique file paths touched across the project lifetime.
  // "Lifetime" qualifier is accurate: OverviewPage uses since='all' for this metric,
  // so the count is not time-bounded. Label distinguishes it from the 30d sibling cards.
  const filesTouchedValue = new Intl.NumberFormat('en-US').format(data.totalFilesTouched);

  // ── Card 3 — Cost / Turn ─────────────────────────────────────────────────
  // Headline: mean costUsd per turn in the 30d window.
  // Delta: vs prior 30d window; null when prev is 0 (no data to compare).
  const costPerTurnValue = formatCurrency(data.avgCostPerTurn30d);
  const costPerTurnDelta = pctDelta(data.avgCostPerTurn30d, data.avgCostPerTurnPrev30d);

  // ── Card 4 — Tool Error Rate ─────────────────────────────────────────────
  // Headline: toolErrorRate30d expressed as a percentage with one decimal.
  // Delta: null — no prior-period error rate field in MetricSummary.
  const toolErrorRateValue = `${(data.toolErrorRate30d * 100).toFixed(1)}%`;

  return (
    <Section title="Usage Insights" cols={4} gap="md">
      {/* Card 1 — Active Time */}
      <MetricCard
        label="Active Time (30d)"
        value={activeTimeValue}
        context={idleTimeContext}
        deltaPercent={null}
        icon={<Activity size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 2 — Files Touched · Lifetime */}
      <MetricCard
        label="Files Touched · Lifetime"
        value={filesTouchedValue}
        context="unique paths"
        deltaPercent={null}
        icon={<FolderOpen size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 3 — Cost / Turn */}
      <MetricCard
        label="Avg Cost / Turn (30d)"
        value={costPerTurnValue}
        context="vs prev 30 days"
        deltaPercent={costPerTurnDelta}
        icon={<TrendingUp size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 4 — Tool Error Rate */}
      <MetricCard
        label="Tool Error Rate (30d)"
        value={toolErrorRateValue}
        context="tool_use → tool_result error pct"
        deltaPercent={null}
        icon={<AlertTriangle size={14} aria-hidden="true" className="shrink-0" />}
      />
    </Section>
  );
}
