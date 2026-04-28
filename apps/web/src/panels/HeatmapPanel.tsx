/**
 * HeatmapPanel — "Activity by day & hour" heatmap panel.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary } from '@tokenomix/shared';
import { HeatmapChart } from '../charts/HeatmapChart.js';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { Card } from '../ui/Card.js';

export function HeatmapPanel() {
  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since: 'all' }),
    queryFn: () => fetchMetrics({ since: 'all' }),
  });

  return (
    <Card as="section" aria-label="Activity by day and hour">
      <h2 className="text-base font-semibold text-gray-950 dark:text-white mb-4">
        Activity by day &amp; hour
      </h2>
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      )}
      {isError && (
        <div className="flex items-center justify-center h-48">
          <p className="text-sm text-red-500">Failed to load heatmap data.</p>
        </div>
      )}
      {data && <HeatmapChart data={data.heatmapData} height={200} />}
    </Card>
  );
}
