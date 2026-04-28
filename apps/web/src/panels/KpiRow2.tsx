/**
 * KpiRow2 — three MetricCards for "Usage Insights" dashboard row.
 *
 * Cards (in order): Projects Touched / Avg Cost/Turn / Tool Error Rate
 *
 * Architecture: prop-driven. KpiRow2 accepts a MetricSummary prop — it does NOT
 * self-fetch. OverviewPage owns the single useQuery and passes data down,
 * matching the existing KpiRow pattern.
 *
 * Card 1 — Projects Touched
 *   Headline: Intl.NumberFormat('en-US').format(totalProjectsTouched)
 *   Context:  "unique projects" (totalProjectsTouched is a lifetime count de-duped by
 *             path.basename(cwd) so the same project name across different parent
 *             directories is counted once.)
 *   Delta:    null (em-dash) — no prior-period project-touch data available
 *
 * Card 2 — Avg Cost / Turn
 *   Headline: formatCurrency(data.avgCostPerTurn30d) — adaptive: 4 decimals for sub-cent values
 *   Context:  "vs prev 30 days" (shown only when a delta is rendered)
 *   Delta:    pctDelta(avgCostPerTurn30d, avgCostPerTurnPrev30d) — null when prev is 0
 *
 * Card 3 — Tool Error Rate
 *   Headline: (data.toolErrorRate30d * 100).toFixed(1) + "%"
 *   Context:  "tool_use → tool_result error pct"
 *   Delta:    null (em-dash) — no prior-period error-rate field in MetricSummary
 *
 * Formatting helpers are shared from lib/formatters.ts:
 * - formatCurrency(usd): adaptive formatter (≥$0.01 → 2dp, <$0.01 → 4dp).
 */

import type { MetricSummary } from '@tokenomix/shared';
import { AlertTriangle, FolderOpen, TrendingUp } from 'lucide-react';
import { formatCurrency, pctDelta } from '../lib/formatters.js';
import { Section } from '../ui/Section.js';
import { MetricCard } from './MetricCard.js';

// ---------------------------------------------------------------------------
// KpiRow2
// ---------------------------------------------------------------------------

interface KpiRow2Props {
  /** Pre-fetched MetricSummary from OverviewPage's single useQuery call. */
  data: MetricSummary;
}

export function KpiRow2({ data }: KpiRow2Props) {
  // ── Card 1 — Projects Touched ─────────────────────────────────────────────
  // Headline: count of distinct project basenames across the lifetime row set.
  // Uses totalProjectsTouched (basename-deduped) rather than totalProjects (raw cwd).
  const projectsTouchedValue = new Intl.NumberFormat('en-US').format(data.totalProjectsTouched);

  // ── Card 2 — Avg Cost / Turn ─────────────────────────────────────────────
  // Headline: mean costUsd per turn in the 30d window.
  // Delta: vs prior 30d window; null when prev is 0 (no data to compare).
  const costPerTurnValue = formatCurrency(data.avgCostPerTurn30d);
  const costPerTurnDelta = pctDelta(data.avgCostPerTurn30d, data.avgCostPerTurnPrev30d);

  // ── Card 3 — Tool Error Rate ─────────────────────────────────────────────
  // Headline: toolErrorRate30d expressed as a percentage with one decimal.
  // Delta: null — no prior-period error rate field in MetricSummary.
  const toolErrorRateValue = `${(data.toolErrorRate30d * 100).toFixed(1)}%`;

  return (
    <Section title="Usage Insights" cols={3} gap="md">
      {/* Card 1 — Projects Touched */}
      <MetricCard
        label="PROJECTS TOUCHED"
        value={projectsTouchedValue}
        context="unique projects"
        deltaPercent={null}
        icon={<FolderOpen size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 2 — Avg Cost / Turn */}
      <MetricCard
        label="AVG COST / TURN (30D)"
        value={costPerTurnValue}
        context="vs prev 30 days"
        deltaPercent={costPerTurnDelta}
        icon={<TrendingUp size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 3 — Tool Error Rate */}
      <MetricCard
        label="TOOL ERROR RATE (30D)"
        value={toolErrorRateValue}
        context="tool_use → tool_result error pct"
        deltaPercent={null}
        icon={<AlertTriangle size={14} aria-hidden="true" className="shrink-0" />}
      />
    </Section>
  );
}
