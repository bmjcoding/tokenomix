/**
 * ModelMixPanel — "Model mix" section with donut chart and legend badges.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { ModelMixBar } from '../charts/ModelMixBar.js';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';

interface ModelMixPanelProps {
  since?: string;
}

/** Mirror the donut chart's top-N cap so badge legend stays in sync. */
const MAX_MODELS = 6;

export function ModelMixPanel({ since = 'all' }: ModelMixPanelProps) {
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since }),
    queryFn: () => fetchMetrics({ since }),
  });

  // Build the same top-N + "other" rollup used by the donut chart so badge
  // legend slices match chart slices 1-to-1.
  const badgeItems: Array<{ modelFamily: string; costUsd: number }> = (() => {
    if (!data?.byModel.length) return [];
    const sorted = [...data.byModel].sort((a, b) => b.costUsd - a.costUsd);
    if (sorted.length <= MAX_MODELS) return sorted;
    const top = sorted.slice(0, MAX_MODELS);
    const rest = sorted.slice(MAX_MODELS);
    const otherCost = rest.reduce((s, m) => s + m.costUsd, 0);
    return [...top, { modelFamily: 'other', costUsd: otherCost }];
  })();

  const totalCost = badgeItems.reduce((s, m) => s + m.costUsd, 0);

  return (
    <Card as="section" aria-label="Model mix">
      <h2 className="text-base font-semibold text-gray-950 dark:text-white mb-4">Model mix</h2>

      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-red-500 dark:text-red-400">Failed to load model data.</p>
        </div>
      )}

      {data && (
        <>
          <ModelMixBar data={data.byModel} height={240} />
          {badgeItems.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Model legend">
              {badgeItems.map((m) => {
                const pct = totalCost > 0 ? ((m.costUsd / totalCost) * 100).toFixed(0) : '0';
                return (
                  <li key={m.modelFamily}>
                    <Badge variant="default" title={`$${m.costUsd.toFixed(3)}`}>
                      {m.modelFamily} {pct}%
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
