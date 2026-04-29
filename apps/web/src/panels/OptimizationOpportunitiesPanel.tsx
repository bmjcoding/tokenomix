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

  return (
    <Card as="section" className="p-0 overflow-hidden" aria-label="Optimization opportunities">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold text-gray-950 dark:text-white">
            Optimization Opportunities
          </h2>
          <div className="flex items-center gap-2">
            <HelpTooltip label="Explain optimization opportunity scoring">
              Scores are deterministic rule weights from local session data, not LLM inference and
              not probabilities. Higher means the observed signal is cleaner and more directly tied
              to the proposed experiment.
            </HelpTooltip>
            <Badge variant="accent">{formatCurrency(data.costUsd30d)} 30d spend</Badge>
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
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Area
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Recommendation
                </th>
                <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Impact
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
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
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="space-y-1">
                      <Badge variant="default">{categoryLabel(opportunity.category)}</Badge>
                      <p className="max-w-[180px] text-sm font-semibold text-gray-950 dark:text-white">
                        {opportunity.title}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="max-w-3xl text-sm text-gray-800 dark:text-gray-200">
                      {opportunity.recommendation}
                    </p>
                    <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
                      {opportunity.evidence}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-950 dark:text-white whitespace-nowrap">
                    {formatCurrency(opportunity.impactUsd30d)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge variant={opportunity.confidence >= 0.7 ? 'accent' : 'default'}>
                      {confidenceLabel(opportunity.confidence)} rule -{' '}
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
