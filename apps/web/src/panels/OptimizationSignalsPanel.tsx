/**
 * OptimizationSignalsPanel — "Optimization Signals" dashboard section.
 *
 * Renders up to three MetricCards based on available data:
 *
 *   Card 1 — P90 SESSION DURATION (always rendered)
 *     Headline: monthlyRollup.current.sessionDuration.p90Minutes as duration;
 *               "—" when totalCounted === 0 (no recorded sessions)
 *     Context:  "P50: Xm Ys · N sessions" (median + session count)
 *     Delta:    null (no prior-period percentile comparison)
 *
 *   Card 2 — SUBAGENT SUCCESS RATE (conditional: bySubagent.length > 0)
 *     Headline: weighted success rate as "XX.X%"
 *     Context:  "N dispatches total"
 *     Delta:    null
 *
 *   Card 3 — TOP EXPENSIVE PROJECT (conditional: byProject.length > 0)
 *     Headline: basename(byProject[0].project) truncated to 24 chars; uses last
 *               path segment so raw cwd paths display as human-readable project names
 *     Context:  "XX.X% of 30d spend" (guarded: em-dash when costUsd30d === 0)
 *     Delta:    null
 *
 * Section cols is computed dynamically to match actual rendered card count (1, 2, or 3).
 *
 * Architecture: prop-driven. Accepts MetricSummary — does NOT self-fetch.
 * OverviewPage owns the single useQuery and passes data down.
 *
 * Empty/zero state contract:
 *   - bySubagent.length === 0 → card 2 hidden; Section reflows to 1 or 2 cols
 *   - byProject.length === 0  → card 3 hidden; Section reflows to 1 or 2 cols
 *   - costUsd30d === 0        → share context renders em-dash (no division by zero)
 *   - Project name > 24 chars → truncated with ellipsis ("…")
 *   - totalCounted === 0      → value="—" (unambiguous empty state for P90 card)
 */

import type { MetricSummary } from '@tokenomix/shared';
import { Activity, Award, Clock } from 'lucide-react';
import { formatDurationMinutes } from '../lib/formatters.js';
import type { SectionCols } from '../ui/Section.js';
import { Section } from '../ui/Section.js';
import { MetricCard } from './MetricCard.js';

// ---------------------------------------------------------------------------
// Inline helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the last path segment from a project path, mirroring how
 * TokenRow.projectName is derived from cwd on ingest (path.basename).
 * Falls back to the original string when no "/" is present.
 *
 * Examples:
 *   "/Users/example/work/my-project" → "my-project"
 *   "my-project"                     → "my-project"
 *   "/trailing/"                     → "trailing"
 */
function basename(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] || path;
}

/**
 * Truncates a project name to 24 characters, appending "…" when truncated.
 * Uses a Unicode ellipsis character (U+2026) to stay within the character budget.
 */
function truncateProject(name: string): string {
  if (name.length <= 24) return name;
  return `${name.slice(0, 22)}…`;
}

// ---------------------------------------------------------------------------
// OptimizationSignalsPanel
// ---------------------------------------------------------------------------

interface OptimizationSignalsPanelProps {
  /** Pre-fetched MetricSummary from OverviewPage's single useQuery call. */
  data: MetricSummary;
}

export function OptimizationSignalsPanel({ data }: OptimizationSignalsPanelProps) {
  const { monthlyRollup, bySubagent, byProject30d, costUsd30d } = data;
  const { p90Minutes, medianMinutes, totalCounted } = monthlyRollup.current.sessionDuration;

  // ── Card 1 — P90 SESSION DURATION ─────────────────────────────────────────
  // Always rendered. Source: monthlyRollup.current.sessionDuration.
  // Zero-state: when totalCounted is 0, show "—" instead of a formatted zero;
  // this aligns with the other conditional cards which hide or show "—" when
  // no underlying data exists, making the card's empty state unambiguous.
  const p90Str = totalCounted === 0 ? '—' : formatDurationMinutes(p90Minutes);
  const p50ContextStr = `P50: ${totalCounted === 0 ? '—' : formatDurationMinutes(medianMinutes)}`;
  const sessionCountStr =
    totalCounted === 1 ? '1 session' : `${totalCounted.toLocaleString('en-US')} sessions`;

  // ── Card 2 — SUBAGENT SUCCESS RATE (conditional) ──────────────────────────
  // Show only when bySubagent[] is non-empty.
  // Weighted rate: sum(dispatches * successRate) / sum(dispatches).
  // Guard: if total dispatches is 0 (shouldn't happen in a non-empty array,
  // but guard to avoid NaN/Infinity).
  const showSubagentCard = bySubagent.length > 0;

  let subagentRateStr = '—';
  let subagentContextStr: string | undefined;

  if (showSubagentCard) {
    const totalDispatches = bySubagent.reduce((sum, s) => sum + s.dispatches, 0);
    const weightedSum = bySubagent.reduce((sum, s) => sum + s.dispatches * s.successRate, 0);
    const weightedRate = totalDispatches > 0 ? weightedSum / totalDispatches : null;
    subagentRateStr = weightedRate !== null ? `${(weightedRate * 100).toFixed(1)}%` : '—';
    subagentContextStr = `${totalDispatches.toLocaleString('en-US')} subagent turn${totalDispatches === 1 ? '' : 's'} total`;
  }

  // ── Card 3 — TOP EXPENSIVE PROJECT (conditional) ──────────────────────────
  // Show only when byProject30d[] is non-empty.
  // Sort descending by costUsd; use entry at index 0.
  // Share of 30d spend: guard divide-by-zero with em-dash when costUsd30d === 0.
  const showProjectCard = byProject30d.length > 0;

  let topProjectName = '';
  let topProjectContextStr: string | undefined;

  if (showProjectCard) {
    const sorted = [...byProject30d].sort((a, b) => b.costUsd - a.costUsd);
    const top = sorted[0];
    // sorted is non-empty (byProject30d.length > 0), so top is always defined.
    // Narrow explicitly with an early-return guard to satisfy the lint rule.
    // Extract the basename (last path segment) before truncation so raw cwd
    // paths like "/Users/example/work/my-project" display as "my-project",
    // consistent with how TokenRow.projectName is derived on ingest.
    if (top) {
      topProjectName = truncateProject(basename(top.project));
      const shareStr =
        costUsd30d > 0
          ? `${((top.costUsd / costUsd30d) * 100).toFixed(1)}% of 30d spend`
          : '— of 30d spend';
      topProjectContextStr = shareStr;
    }
  }

  // ── Section column count — reflects actual rendered card count ─────────────
  const cardCount: SectionCols = (1 +
    (showSubagentCard ? 1 : 0) +
    (showProjectCard ? 1 : 0)) as SectionCols;

  return (
    <Section title="Optimization Signals" cols={cardCount} gap="md">
      {/* Card 1 — P90 SESSION DURATION (always rendered) */}
      <MetricCard
        label="P90 SESSION DURATION"
        value={p90Str}
        context={`${p50ContextStr} · ${sessionCountStr}; context risk`}
        deltaPercent={null}
        icon={<Clock size={14} aria-hidden="true" className="shrink-0" />}
        tooltip="Long sessions usually accumulate more context, cache reads, and model state. If P90 is much higher than P50, the expensive tail is likely coming from marathon sessions where earlier /compact, /clear, or project memory could reduce spend."
      />

      {/* Card 2 — SUBAGENT SUCCESS RATE (conditional) */}
      {showSubagentCard && (
        <MetricCard
          label="SUBAGENT SUCCESS RATE"
          value={subagentRateStr}
          {...(subagentContextStr !== undefined
            ? { context: `${subagentContextStr}; pair with spend` }
            : {})}
          deltaPercent={null}
          icon={<Activity size={14} aria-hidden="true" className="shrink-0" />}
          tooltip="This is tool-error success across subagent turns, not business outcome success. A high value is good only when subagents also reduce main-session time or rework. A low value means delegated work may be creating retries and extra context."
        />
      )}

      {/* Card 3 — TOP EXPENSIVE PROJECT (conditional) */}
      {showProjectCard && (
        <MetricCard
          label="TOP EXPENSIVE PROJECT"
          value={topProjectName}
          {...(topProjectContextStr !== undefined
            ? { context: `${topProjectContextStr}; start here` }
            : {})}
          deltaPercent={null}
          icon={<Award size={14} aria-hidden="true" className="shrink-0" />}
          tooltip="This is the project with the largest 30-day spend share. It should be the first place to run controlled optimization trials because concentrated spend produces measurable before/after signal faster than spreading experiments across many small projects."
        />
      )}
    </Section>
  );
}
