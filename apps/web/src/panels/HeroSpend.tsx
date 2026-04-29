/**
 * HeroSpend — hero card displaying Current Spend (MTD).
 *
 * Design decisions:
 * - Pure prop-driven component: receives MetricSummary, no internal useQuery.
 * - Headline: monthlyRollup.current.costUsd formatted as $X,XXX.XX with tabular-nums.
 * - Delta pill: percentage change vs previous month with ArrowUpRight / ArrowDownRight
 *   icons from lucide-react. Shows em-dash when previous.costUsd === 0.
 * - Card surface matches existing conventions: rounded-2xl, border, card surface tokens, p-6.
 * - No shadows per design-authority anti-convergence rule.
 * - DataQualityTooltip: inline next to headline (h-6 w-6 button, AlertTriangle size=13)
 *   rather than absolute-positioned corner so it never overlaps right-column content.
 * - Layout: 2-column grid (lg+). Left: primary $ metric + 30D cost driver satellite below
 *   hairline. Right: TOKENS · MTD full digit count, filling the entire right half.
 * - MTD token count uses full locale-grouped digits (no abbreviation) in the right column.
 * - 30D COST DRIVER in left column as a satellite metric (text-4xl, below hairline).
 * - TOKENS · 30D removed from hero — it remains visible in KpiRow on the Overview tab.
 */

import type {
  IngestionAuditSummary,
  MetricSummary,
  PricingAuditSummary,
  PricingProvider,
} from '@tokenomix/shared';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Cpu,
  Database,
  FileSearch,
} from 'lucide-react';
import { Card } from '../ui/Card.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCostUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatInt(value: number): string {
  return value.toLocaleString('en-US');
}

function providerLabel(provider: PricingProvider): string {
  switch (provider) {
    case 'anthropic_1p':
      return 'Anthropic 1P';
    case 'aws_bedrock':
      return 'AWS Bedrock';
    case 'internal_gateway':
      return 'Internal Gateway';
  }
}

function costBasisText(audit: PricingAuditSummary): string {
  switch (audit.catalog.costBasis) {
    case 'rated_internal_gateway_cost':
      return 'Cost totals are sourced from internal gateway-rated cost fields.';
    case 'estimated_from_jsonl_usage_without_gateway_rated_cost':
      return 'Internal gateway mode is enabled, but at least one row is still locally estimated because a rated gateway cost field was not present.';
    case 'estimated_from_jsonl_usage_static_bedrock_catalog':
      return 'Cost totals are estimated from AWS Bedrock public pricing and Claude Code usage logs.';
    case 'estimated_from_jsonl_usage_static_anthropic_catalog':
      return 'Cost totals are estimated from Anthropic public pricing and Claude Code usage logs.';
  }
}

// ---------------------------------------------------------------------------
// Delta pill
// ---------------------------------------------------------------------------

interface DeltaPillProps {
  currentCost: number;
  previousCost: number;
}

function DeltaPill({ currentCost, previousCost }: DeltaPillProps) {
  // Show em-dash when there is no previous period to compare against.
  if (previousCost === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-medium text-gray-500 dark:text-gray-400"
        title="No prior month to compare"
      >
        <span aria-hidden="true">&mdash;</span>
        <span className="sr-only">No prior month to compare</span>
      </span>
    );
  }

  const pct = ((currentCost - previousCost) / previousCost) * 100;
  const isPositive = pct >= 0;
  const absPct = Math.abs(pct).toFixed(1);

  // Neutral/informational blue — both directions use the same tone so heavy usage
  // does not visually read as a penalty (red) or a saving (green).
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950"
      title={`${absPct}% vs prior month`}
    >
      <span className="sr-only">
        {isPositive ? 'Up' : 'Down'} {absPct}% vs prior month
      </span>
      {isPositive ? (
        <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
      ) : (
        <ArrowDownRight size={12} aria-hidden="true" className="shrink-0" />
      )}
      <span aria-hidden="true">{absPct}%</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Data quality tooltip — inline variant
// Sits inline next to the hero headline rather than absolute-positioned in the
// card corner. This prevents any overlap with right-column content.
// ---------------------------------------------------------------------------

interface DataQualityTooltipProps {
  pricingAudit: PricingAuditSummary;
  ingestionAudit: IngestionAuditSummary;
}

function DataQualityTooltip({ pricingAudit, ingestionAudit }: DataQualityTooltipProps) {
  const hasPricingWarnings = pricingAudit.warnings.length > 0;
  const hasIngestionWarnings = ingestionAudit.warnings.length > 0;
  if (!hasPricingWarnings && !hasIngestionWarnings) return null;

  return (
    <span className="relative inline-flex group/audit self-start mt-2 ml-2">
      <button
        type="button"
        aria-label="Review data quality notes"
        className={[
          'inline-flex h-6 w-6 items-center justify-center rounded-lg',
          'border border-amber-300 dark:border-amber-800',
          'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-200',
          // design-lint-disable dark-mode-pairs
          'hover:bg-amber-200 dark:hover:bg-amber-900',
          // design-lint-disable dark-mode-pairs
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:focus-visible:ring-amber-600',
          'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      >
        <AlertTriangle size={13} aria-hidden="true" />
      </button>

      {/*
        Tooltip anchors below-left of the inline icon. left-0 keeps it pinned to
        the left edge of the button; top-full + mt-1 drops it just below. The
        max-width formula ensures it never exceeds the viewport regardless of
        where in the card the button sits.
      */}
      <span
        role="tooltip"
        className={[
          'pointer-events-none absolute left-0 top-full z-50 mt-1 w-[min(42rem,calc(100vw-3rem))]',
          'rounded-xl border border-amber-200 dark:border-amber-900',
          'bg-amber-50 dark:bg-amber-950 px-4 py-3 text-left',
          'text-sm text-amber-950 dark:text-amber-100',
          'opacity-0 transition-opacity duration-150',
          'group-hover/audit:opacity-100 group-focus-within/audit:opacity-100',
        ].join(' ')}
      >
        <span className="block font-semibold">Data Quality Notes</span>

        <span className="mt-3 block">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Database size={13} aria-hidden="true" />
            Pricing
          </span>
          <span className="mt-1 block text-amber-800 dark:text-amber-200">
            {providerLabel(pricingAudit.provider)} · {costBasisText(pricingAudit)}
          </span>
          {hasPricingWarnings && (
            <span className="mt-1 block space-y-1">
              {pricingAudit.warnings.map((warning) => (
                <span key={warning} className="block">
                  {warning}
                </span>
              ))}
            </span>
          )}
        </span>

        <span className="mt-3 block border-t border-amber-200 pt-3 dark:border-amber-900">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <FileSearch size={13} aria-hidden="true" />
            Ingestion
          </span>
          <span className="mt-1 block text-amber-800 dark:text-amber-200">
            Indexed {formatInt(ingestionAudit.rowsIndexed)} rows from{' '}
            {formatInt(ingestionAudit.filesAttempted)} of{' '}
            {formatInt(ingestionAudit.filesDiscovered)} discovered JSONL files.
          </span>
          {hasIngestionWarnings && (
            <span className="mt-1 block space-y-1">
              {ingestionAudit.warnings.map((warning) => (
                <span key={warning} className="block">
                  {warning}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// HeroSpend
// ---------------------------------------------------------------------------

interface HeroSpendProps {
  data: MetricSummary;
}

export function HeroSpend({ data }: HeroSpendProps) {
  const current = data.monthlyRollup.current;
  const previous = data.monthlyRollup.previous;

  const formattedCost = formatCostUsd(current.costUsd);
  const cacheCost30d =
    data.costComponents30d.cacheCreationCostUsd + data.costComponents30d.cacheReadCostUsd;
  const cacheShare30d = data.costUsd30d > 0 ? (cacheCost30d / data.costUsd30d) * 100 : 0;

  // Full locale-grouped MTD token count — no abbreviation (e.g. "28,478,431").
  const formattedTokensMtdFull = current.totalTokens.toLocaleString('en-US');

  return (
    <Card as="section" aria-label="Current spend month to date" className="p-6">
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-8">

        {/* ── Left column: primary $ metric + satellite cost driver ── */}
        <div className="min-w-0">
          {/* Label */}
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-4">
            Current Spend (MTD)
          </p>

          {/* Hero number + inline warning icon */}
          <div className="flex items-start gap-0 mb-3">
            <p className="text-5xl font-bold tracking-tight tabular-nums text-gray-950 dark:text-white">
              {formattedCost}
            </p>
            <DataQualityTooltip
              pricingAudit={data.pricingAudit}
              ingestionAudit={data.ingestionAudit}
            />
          </div>

          {/* Delta pill + subtitle row */}
          <div className="flex items-center gap-3 flex-wrap">
            <DeltaPill currentCost={current.costUsd} previousCost={previous.costUsd} />
            <p className="text-sm text-gray-600 dark:text-gray-400">vs prior month</p>
          </div>

          {/* Hairline separator — primary metric above, satellite metric below */}
          <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-800">
            {/* 30D Cost Driver — satellite treatment (text-4xl, not dominant) */}
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              30D Cost Driver
            </p>
            <p
              aria-hidden="true"
              className="mt-1 text-4xl font-bold leading-none tracking-tight tabular-nums text-gray-200 dark:text-gray-800"
            >
              {cacheShare30d.toFixed(0)}%
            </p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              cache creation/read share
            </p>
          </div>
        </div>

        {/* ── Right column: TOKENS · MTD, full digit count, fills entire right half ── */}
        <div className="pointer-events-none flex flex-col items-center justify-center h-full min-h-[200px]">
          <div className="text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Tokens · MTD
            </p>
            <div className="mt-2 flex items-baseline justify-center gap-2">
              <Cpu
                size={48}
                aria-hidden="true"
                className="text-gray-300 dark:text-gray-700 shrink-0 self-center"
              />
              <p
                aria-hidden="true"
                className="text-6xl sm:text-7xl lg:text-8xl font-bold leading-none tracking-tight tabular-nums text-gray-200 dark:text-gray-800"
              >
                {formattedTokensMtdFull}
              </p>
            </div>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              input + output, this month
            </p>
          </div>
        </div>

      </div>
    </Card>
  );
}
