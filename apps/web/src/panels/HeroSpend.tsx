/**
 * HeroSpend — hero card displaying Current Spend (MTD).
 *
 * Design decisions:
 * - Pure prop-driven component: receives MetricSummary, no internal useQuery.
 * - Headline: monthlyRollup.current.costUsd formatted as $X,XXX.XX with tabular-nums.
 * - Subtitle: total MTD tokens formatted with locale separators + current month name.
 * - Delta pill: percentage change vs previous month with ArrowUpRight / ArrowDownRight
 *   icons from lucide-react. Shows em-dash when previous.costUsd === 0.
 * - Card surface matches existing conventions: rounded-2xl, border, card surface tokens, p-6.
 * - No shadows per design-authority anti-convergence rule.
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

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

function currentMonthName(): string {
  return new Date().toLocaleString('en-US', { month: 'long' });
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
        aria-label="No prior month to compare"
      >
        &mdash;
      </span>
    );
  }

  const pct = ((currentCost - previousCost) / previousCost) * 100;
  const isPositive = pct >= 0;
  const absPct = Math.abs(pct).toFixed(1);

  // Cost-metric polarity: increase = red (warning), decrease = green (savings).
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium',
        isPositive
          ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950'
          : 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950',
      ].join(' ')}
      aria-label={`${isPositive ? 'Increase' : 'Decrease'} of ${absPct}% vs prior month`}
    >
      {isPositive ? (
        <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
      ) : (
        <ArrowDownRight size={12} aria-hidden="true" className="shrink-0" />
      )}
      <span>{absPct}%</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Data quality tooltip
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
    <span className="absolute right-5 top-5 z-20 inline-flex group/audit">
      <button
        type="button"
        aria-label="Review data quality notes"
        className={[
          'inline-flex h-9 w-9 items-center justify-center rounded-lg',
          'border border-amber-300 dark:border-amber-800',
          'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200',
          'hover:bg-amber-200 dark:hover:bg-amber-900',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500',
          'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      >
        <AlertTriangle size={17} aria-hidden="true" />
      </button>

      <span
        role="tooltip"
        className={[
          'pointer-events-none absolute right-0 top-full z-50 mt-2 w-[min(42rem,calc(100vw-3rem))]',
          'rounded-xl border border-amber-200 dark:border-amber-900',
          'bg-amber-50 dark:bg-amber-950 px-4 py-3 text-left shadow-lg',
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
              {pricingAudit.warnings.map((warning, index) => (
                <span key={`${index}:${warning}`} className="block">
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
              {ingestionAudit.warnings.map((warning, index) => (
                <span key={`${index}:${warning}`} className="block">
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
  const formattedTokens = formatTokenCount(current.totalTokens);
  const monthName = currentMonthName();
  const cacheCost30d =
    data.costComponents30d.cacheCreationCostUsd + data.costComponents30d.cacheReadCostUsd;
  const cacheShare30d = data.costUsd30d > 0 ? (cacheCost30d / data.costUsd30d) * 100 : 0;

  return (
    <Card as="section" aria-label="Current spend month to date" className="relative p-6">
      <DataQualityTooltip pricingAudit={data.pricingAudit} ingestionAudit={data.ingestionAudit} />
      <div className="flex items-center justify-between gap-4">
        {/* Left column — existing content */}
        <div className="flex-1 min-w-0">
          {/* Label */}
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-4">
            Current Spend (MTD)
          </p>

          {/* Hero number */}
          <p className="text-5xl font-bold tracking-tight tabular-nums text-gray-950 dark:text-white mb-3">
            {formattedCost}
          </p>

          {/* Delta pill + subtitle row */}
          <div className="flex items-center gap-3 flex-wrap">
            <DeltaPill currentCost={current.costUsd} previousCost={previous.costUsd} />
            <p className="text-sm text-gray-600 dark:text-gray-400">vs prior month</p>
          </div>

          {/* Token count subtitle */}
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400 inline-flex items-center gap-1.5">
            <Cpu size={14} aria-hidden="true" className="shrink-0" />
            <span className="tabular-nums">{formattedTokens}</span> input/output tokens this month
            &middot; {monthName}
          </p>
        </div>

        {/* Right column — cost-driver callout */}
        <div className="hidden lg:block min-w-[360px] pointer-events-none">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              30D Cost Driver
            </p>
            <p className="mt-2 text-6xl font-bold leading-none tracking-tight tabular-nums text-gray-200 dark:text-gray-800">
              {cacheShare30d.toFixed(0)}%
            </p>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              cache creation/read share
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
