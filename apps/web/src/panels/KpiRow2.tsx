/**
 * KpiRow2 — "Usage Insights" dashboard row with 2 or 3 MetricCards.
 *
 * Cards (in order): Projects Touched / Avg Cost/Turn / Worst Tool Error (conditional)
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
 *   Context:  "vs prev 30 days"
 *   Delta:    pctDelta(avgCostPerTurn30d, avgCostPerTurnPrev30d) — null when prev is 0
 *
 * Card 3 — Worst Tool Error (conditional)
 *   Renders ONLY when byTool[] is non-empty AND at least one tool has errorRate > 0.
 *   Headline: worst tool's errorRate as a percentage (e.g. "12.5%")
 *   Context:  the worst tool's name (e.g. "Bash")
 *   Delta:    null (em-dash) — no prior-period per-tool error data
 *   When the condition is false this card slot is omitted entirely so the
 *   parent grid reflows to 2 columns.
 *
 * The Section's cols prop is computed dynamically:
 *   - 2 when the worst-tool card is hidden
 *   - 3 when the worst-tool card is shown
 *
 * Formatting helpers are shared from lib/formatters.ts:
 * - formatCurrency(usd): adaptive formatter (≥$0.01 → 2dp, <$0.01 → 4dp).
 */

import type { MetricSummary } from '@tokenomix/shared';
import { AlertTriangle, FolderOpen, TrendingUp } from 'lucide-react';
import { formatCurrency, pctDelta } from '../lib/formatters.js';
import type { SectionCols } from '../ui/Section.js';
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

  // ── Card 3 — Worst Tool Error (conditional) ───────────────────────────────
  // Derive worst tool: sort byTool[] descending by errorRate, take the first.
  // Render the card only when the worst tool's errorRate is > 0.
  const worstTool =
    data.byTool.length > 0
      ? [...data.byTool].sort((a, b) => b.errorRate - a.errorRate)[0]
      : undefined;
  const showWorstToolCard = worstTool !== undefined && worstTool.errorRate > 0;

  // Section column count reflects the actual rendered card count.
  const sectionCols: SectionCols = showWorstToolCard ? 3 : 2;

  // Pre-format the worst-tool headline when applicable.
  const worstToolValue = showWorstToolCard
    ? `${(worstTool.errorRate * 100).toFixed(1)}%`
    : undefined;

  return (
    <Section title="Usage Insights" cols={sectionCols} gap="md">
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

      {/* Card 3 — Worst Tool Error (conditional: only when a tool has errorRate > 0) */}
      {showWorstToolCard && worstToolValue !== undefined && (
        <MetricCard
          label="TOOL ERROR RATE (WORST)"
          value={worstToolValue}
          context={worstTool.toolName}
          deltaPercent={null}
          icon={<AlertTriangle size={14} aria-hidden="true" className="shrink-0" />}
        />
      )}
    </Section>
  );
}
