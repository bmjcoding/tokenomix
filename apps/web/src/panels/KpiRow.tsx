/**
 * KpiRow — four MetricCards for the redesigned dashboard.
 *
 * Cards (in order): Tokens · 30D / Cache Efficiency / Sessions / Avg Session Duration
 *
 * Architecture: prop-driven. KpiRow accepts a MetricSummary prop — it does NOT
 * self-fetch. OverviewPage owns the single useQuery and passes data down.
 * There is no period toggle here; all four cards always reflect MTD (current
 * calendar month via monthlyRollup.current) for sparklines and deltas, and
 * lifetime totals (flat MetricSummary fields) for headline numbers where noted.
 *
 * Card 1 — Tokens · 30D
 *   Headline: inputTokens30d + outputTokens30d + cacheCreationTokens30d
 *             (30-day window; cache READS are excluded — they represent free reuse)
 *   Sparkline: monthlyRollup.current.dailyTokens
 *   Delta: null (em-dash) — the prior-period totalTokens on PeriodRollup is
 *          input+output only with no cacheCreation component; comparing it
 *          against the new 30d headline (which includes cacheCreation) would be
 *          a mismatched comparison. Prefer null over a misleading delta.
 *
 * Card 2 — Cache Efficiency
 *   Headline: computeCacheEfficiency(flat lifetime token fields) → formatted %
 *   Sparkline: computeDailyEfficiencySeries(data.dailySeries)
 *   Delta: em-dash — PeriodRollup has no per-type token breakdown, so a
 *          per-period efficiency delta cannot be computed cleanly.
 *
 * Card 3 — Sessions
 *   Headline: data.totalSessions (lifetime, locale-grouped)
 *   Sparkline: monthlyRollup.current.dailySessions
 *   Delta: MTD vs prior month via monthlyRollup.{current,previous}.sessionCount
 *
 * Card 4 — Avg Session Duration
 *   Headline: monthlyRollup.current.sessionDuration.medianMinutes (Xm Ys)
 *   Sparkline: monthlyRollup.current.sessionDuration.weeklyMedianTrend
 *   Delta: MTD vs prior month via sessionDuration.medianMinutes
 */

import type { MetricSummary } from '@tokenomix/shared';
import { Activity, Clock, Cpu, Zap } from 'lucide-react';
import { computeCacheEfficiency, computeDailyEfficiencySeries } from '../lib/derive.js';
import { pctDelta } from '../lib/formatters.js';
import { Section } from '../ui/Section.js';
import { MetricCard } from './MetricCard.js';

// ---------------------------------------------------------------------------
// Inline formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a large integer with K/M/B suffix.
 * Uses one decimal place to keep labels compact (e.g. "15.8M", "1.2k").
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/**
 * Formats a session count with locale grouping separators (e.g. "1,234").
 */
function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Formats a fractional percentage to one decimal place (e.g. "78.4%").
 */
function formatEfficiency(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/**
 * Formats a duration given in decimal minutes as "Xm Ys" (e.g. "34m 22s").
 * If seconds are zero, renders just "Xm" (e.g. "5m").
 * If the duration is less than 1 minute, renders "Xs" (e.g. "45s").
 * For durations >= 60 min, renders "Xh Ym" (e.g. "1h 15m").
 */
function formatDurationMinutes(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (min < 60) {
    const wholeMin = Math.floor(min);
    const sec = Math.round((min - wholeMin) * 60);
    return sec > 0 ? `${wholeMin}m ${sec}s` : `${wholeMin}m`;
  }
  const hr = Math.floor(min / 60);
  const remMin = Math.round(min - hr * 60);
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

// ---------------------------------------------------------------------------
// KpiRow
// ---------------------------------------------------------------------------

interface KpiRowProps {
  /** Pre-fetched MetricSummary from OverviewPage's single useQuery call. */
  data: MetricSummary;
}

export function KpiRow({ data }: KpiRowProps) {
  const current = data.monthlyRollup.current;
  const previous = data.monthlyRollup.previous;

  // ── Card 1 — Tokens · 30D ────────────────────────────────────────────────
  // Headline: 30-day total of input + output + cache creation tokens.
  // Cache reads are excluded — they are free reuse, not newly produced tokens.
  const tokens30d = data.inputTokens30d + data.outputTokens30d + data.cacheCreationTokens30d;

  // Delta: intentionally null. PeriodRollup.totalTokens is input+output only
  // (no cache creation component), so comparing it against the 30d headline
  // — which now includes cacheCreationTokens30d — would be mismatched. Prefer
  // an em-dash over a misleading comparison.
  const tokensDelta: number | null = null;

  // ── Card 2 — Cache Efficiency ────────────────────────────────────────────
  // Headline: lifetime cache-hit ratio using flat MetricSummary fields.
  // PeriodRollup has no per-type token breakdown, so a per-period efficiency
  // cannot be computed — delta is always null (em-dash) for this card.
  const cacheEfficiencyPct = computeCacheEfficiency({
    cacheReadTokens: data.totalCacheReadTokens,
    cacheCreationTokens: data.totalCacheCreationTokens,
    inputTokens: data.totalInputTokens,
  });

  // Efficiency sparkline uses daily series because DailyBucket carries
  // per-type token fields (cacheReadTokens, cacheCreationTokens, inputTokens).
  const efficiencySparkline = computeDailyEfficiencySeries(data.dailySeries);

  // Cache Efficiency delta is intentionally null.
  // Rationale: PeriodRollup contains only totalTokens (input+output combined)
  // with no per-type breakdown, so computing per-period cache efficiency would
  // require fields that do not exist in PeriodRollup. We render an em-dash
  // rather than an approximation that would mislead the user.
  const cacheEfficiencyDelta: number | null = null;

  // ── Card 3 — Sessions ────────────────────────────────────────────────────
  // Headline: lifetime total sessions (MetricSummary flat field).
  // Delta: MTD current vs MTD previous session counts.
  const sessionsDelta = pctDelta(current.sessionCount, previous.sessionCount);

  // ── Card 4 — Avg Session Duration ────────────────────────────────────────
  // Headline: MTD median session duration (medianMinutes from PeriodRollup).
  // Sparkline: weekly median trend for the current month.
  // Delta: MTD current vs MTD previous median duration.
  const dur = current.sessionDuration;
  const prevDur = previous.sessionDuration;
  const durationDelta = pctDelta(dur.medianMinutes, prevDur.medianMinutes);

  return (
    <Section title="Key Metrics" cols={4} gap="md">
      {/* Card 1 — Tokens · 30D */}
      <MetricCard
        label="TOKENS · 30D"
        value={formatTokens(tokens30d)}
        sparklineData={current.dailyTokens}
        deltaPercent={tokensDelta}
        icon={<Cpu size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 2 — Cache Efficiency */}
      {/*
       * Delta is always null here: PeriodRollup has no per-type token fields,
       * so we cannot compute a per-period efficiency ratio. Em-dash is shown.
       */}
      <MetricCard
        label="Cache Efficiency"
        value={formatEfficiency(cacheEfficiencyPct)}
        sparklineData={efficiencySparkline}
        deltaPercent={cacheEfficiencyDelta}
        icon={<Zap size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 3 — Sessions */}
      <MetricCard
        label="Sessions"
        value={formatCount(data.totalSessions)}
        sparklineData={current.dailySessions}
        deltaPercent={sessionsDelta}
        icon={<Activity size={14} aria-hidden="true" className="shrink-0" />}
      />

      {/* Card 4 — Avg Session Duration */}
      <MetricCard
        label="Avg Session Duration"
        value={dur.medianMinutes > 0 ? formatDurationMinutes(dur.medianMinutes) : '—'}
        sparklineData={dur.weeklyMedianTrend}
        deltaPercent={durationDelta}
        icon={<Clock size={14} aria-hidden="true" className="shrink-0" />}
      />
    </Section>
  );
}
