/**
 * OptimizationOpportunitiesPanel — ranked experiment candidates.
 *
 * The recommendations are deliberately phrased as experiments because lowering
 * spend without outcome validation is not token efficiency.
 */

import type { MetricSummary, OptimizationOpportunity } from '@tokenomix/shared';
import { AlertTriangle } from 'lucide-react';
import { formatCurrency } from '../lib/formatters.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';
import { HelpTooltip } from '../ui/HelpTooltip.js';

interface OptimizationOpportunitiesPanelProps {
  data: MetricSummary;
}

function categoryLabel(category: OptimizationOpportunity['category']): string {
  switch (category) {
    case 'context':
      return 'Context';
    case 'model':
      return 'Model';
    case 'tooling':
      return 'Tooling';
    case 'workflow':
      return 'Workflow';
    case 'project':
      return 'Project';
  }
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.7) return 'High';
  if (confidence >= 0.55) return 'Med';
  return 'Low';
}

export function OptimizationOpportunitiesPanel({ data }: OptimizationOpportunitiesPanelProps) {
  const opportunities = data.optimizationOpportunities;

  // Non-additive scan metric: candidates can overlap, so this is not booked savings.
  const listedImpact = opportunities.reduce((s, o) => s + o.impactUsd30d, 0);

  return (
    <Card as="section" className="p-0 overflow-hidden" aria-label="Optimization opportunities">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="text-base font-semibold text-gray-950 dark:text-white">
            Optimization Opportunities
          </h2>
          <div className="flex items-center gap-2">
            {/* Only show the impact badge when there is a non-zero total to report. */}
            {listedImpact > 0 && (
              <Badge variant="accent">Listed impact {formatCurrency(listedImpact)}</Badge>
            )}
            <HelpTooltip label="Explain optimization opportunity scoring" align="right">
              Scores are deterministic rule weights from local session data, not LLM inference and
              not probabilities. Higher means the observed signal is cleaner and more directly tied
              to the proposed experiment. Listed impact is non-additive because candidates can
              overlap.
            </HelpTooltip>
          </div>
        </div>
      </div>

      {opportunities.length === 0 ? (
        <div className="flex items-center gap-2 px-5 py-6 text-sm text-gray-500 dark:text-gray-400">
          <AlertTriangle size={16} aria-hidden="true" className="shrink-0" />
          No material optimization candidates in the current window.
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar-hide">
          <table className="w-full text-sm">
            {/* Explicit column proportions prevent the AREA cell from overflowing
                into adjacent columns on constrained viewport widths. */}
            <colgroup>
              <col style={{ width: '15%' }} />
              <col style={{ width: '55%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Area
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Recommendation
                </th>
                <th className="px-4 py-2.5 text-center text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Impact
                </th>
                {/* Right-aligned to match the Rule Score column for visual symmetry. */}
                <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Rule Score
                </th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opportunity) => (
                <tr
                  key={opportunity.id}
                  className="border-b border-gray-100 dark:border-gray-800 align-top"
                >
                  {/* AREA cell: uppercase label — title moved to Recommendation column. */}
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {categoryLabel(opportunity.category)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {/* Title sits above the recommendation text within the same cell. */}
                    <p className="text-sm font-semibold text-gray-950 dark:text-white break-words whitespace-normal">
                      {opportunity.title}
                    </p>
                    <p className="mt-1 max-w-3xl text-sm text-gray-800 dark:text-gray-200">
                      {opportunity.recommendation}
                    </p>
                    <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
                      {opportunity.evidence}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-center font-semibold tabular-nums text-gray-950 dark:text-white whitespace-nowrap">
                    {formatCurrency(opportunity.impactUsd30d)}
                  </td>
                  {/* Right-aligned cell to match Rule Score header. */}
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <Badge variant={opportunity.confidence >= 0.7 ? 'accent' : 'default'}>
                      {confidenceLabel(opportunity.confidence)} -{' '}
                      {(opportunity.confidence * 100).toFixed(0)}%
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
