/**
 * ToolsBreakdownPanel — "Tool Use Breakdown" section with donut chart and legend badges.
 *
 * Self-fetches MetricSummary via queryKeys.metrics({since}).
 * Renders a ToolMixBar donut chart with a badge legend for the top 6 tools by count.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { ToolMixBar } from '../charts/ToolMixBar.js';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { Badge } from '../ui/Badge.js';
import { Card } from '../ui/Card.js';

interface ToolsBreakdownPanelProps {
  since?: string;
}

/** Mirror the donut chart's top-N cap so badge legend stays in sync. */
const MAX_TOOLS = 6;

export function ToolsBreakdownPanel({ since = '30d' }: ToolsBreakdownPanelProps) {
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since }),
    queryFn: () => fetchMetrics({ since }),
  });

  // Build the same top-N + "other" rollup used by the donut chart so badge
  // legend slices match chart slices 1-to-1.
  const badgeItems: Array<{ toolName: string; count: number }> = (() => {
    if (!data?.byTool.length) return [];
    const sorted = [...data.byTool].sort((a, b) => b.count - a.count);
    if (sorted.length <= MAX_TOOLS) return sorted;
    const top = sorted.slice(0, MAX_TOOLS);
    const rest = sorted.slice(MAX_TOOLS);
    const otherCount = rest.reduce((s, t) => s + t.count, 0);
    return [...top, { toolName: 'other', count: otherCount }];
  })();

  const totalCount = badgeItems.reduce((s, t) => s + t.count, 0);

  // Post-fetch empty state: render nothing so the OverviewPage grid reflows.
  if (data && data.byTool.length === 0) return null;

  return (
    <Card as="section" aria-label="Tool use breakdown">
      <h2 className="text-base font-semibold text-gray-950 dark:text-white mb-4">
        Tool Use Breakdown
      </h2>

      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-red-500 dark:text-red-400">Failed to load tool data.</p>
        </div>
      )}

      {data && (
        <>
          <ToolMixBar data={data.byTool} height={240} />
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Tool legend">
            {badgeItems.map((t) => {
              const pct = totalCount > 0 ? ((t.count / totalCount) * 100).toFixed(0) : '0';
              return (
                <Badge
                  key={t.toolName}
                  variant="default"
                  title={`${t.count.toLocaleString()} calls`}
                >
                  {t.toolName} {pct}%
                </Badge>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
