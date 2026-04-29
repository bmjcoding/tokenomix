/**
 * HeatmapPanel — "Activity by day & hour" heatmap panel.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { useMemo } from 'react';
import { HeatmapChart } from '../charts/HeatmapChart.js';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { Card } from '../ui/Card.js';

/** Count of distinct non-zero (dayOfWeek, hour) buckets in the heatmap dataset. */
function countActiveBuckets(data: MetricSummary['heatmapData']): number {
  const seen = new Set<string>();
  for (const point of data) {
    if (point.costUsd > 0) {
      const dayOfWeek = new Date(point.date).getDay();
      seen.add(`${dayOfWeek}-${point.hour}`);
    }
  }
  return seen.size;
}

export function HeatmapPanel() {
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since: 'all' }),
    queryFn: () => fetchMetrics({ since: 'all' }),
  });

  const subtitle = useMemo(() => {
    if (!data?.heatmapData) return null;
    const totalCost = data.heatmapData.reduce((sum, p) => sum + p.costUsd, 0);
    const buckets = countActiveBuckets(data.heatmapData);
    if (totalCost === 0) return null;
    return `$${totalCost.toFixed(2)} across ${buckets} hour-bucket${buckets !== 1 ? 's' : ''}`;
  }, [data]);

  return (
    <Card as="section" aria-label="Activity by day and hour">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">
          Activity by day &amp; hour
        </h2>
        {subtitle !== null && (
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {subtitle}
          </span>
        )}
      </div>
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-red-500 dark:text-red-400">Failed to load heatmap data.</p>
        </div>
      )}
      {data && <HeatmapChart data={data.heatmapData} height={200} />}
    </Card>
  );
}
