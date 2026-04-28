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

import type { MetricSummary } from '@tokenomix/shared';
import { ArrowDownRight, ArrowUpRight, Cpu } from 'lucide-react';
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
  const fullTokenCount = current.totalTokens.toLocaleString('en-US');
  const monthName = currentMonthName();

  return (
    <Card as="section" aria-label="Current spend month to date" className="p-6 overflow-hidden">
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
            <span className="tabular-nums">{formattedTokens}</span> tokens this month &middot;{' '}
            {monthName}
          </p>
        </div>

        {/* Right column — decorative oversized token count */}
        <div className="hidden lg:flex items-center overflow-hidden pointer-events-none">
          <div className="flex items-center gap-4 text-gray-100 dark:text-gray-800">
            <Cpu className="shrink-0 select-none" size={104} strokeWidth={1.5} aria-hidden="true" />
            <p
              className="text-[8rem] font-bold leading-none tracking-tight select-none tabular-nums whitespace-nowrap"
              aria-hidden="true"
            >
              {fullTokenCount}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
