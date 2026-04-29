/**
 * ModelsPage — model mix panel with 30d/all toggle and per-model breakdown table.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary, SinceOption } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchMetrics } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { ModelMixPanel } from '../panels/ModelMixPanel.js';
import { Button } from '../ui/Button.js';

function formatUsd(v: number): string {
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function ModelsPage() {
  const [since, setSince] = useState<SinceOption>('30d');

  const sinceOptions: Array<{ value: SinceOption; label: string }> = [
    { value: '30d', label: '30d' },
    { value: 'all', label: 'All time' },
  ];

  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics({ since }),
    queryFn: () => fetchMetrics({ since }),
  });

  const sortedModels = data ? [...data.byModel].sort((a, b) => b.costUsd - a.costUsd) : [];

  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white">Models</h1>
        {/* biome-ignore lint/a11y/useSemanticElements: role=group with aria-label is the canonical toolbar buttongroup pattern; <fieldset> would impose default browser visual styling */}
        <div className="flex items-center gap-1" role="group" aria-label="Time period">
          {sinceOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={since === opt.value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setSince(opt.value)}
              aria-pressed={since === opt.value}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      <ModelMixPanel since={since} />

      {/* Per-model breakdown table */}
      <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-base font-semibold text-gray-950 dark:text-white">
            Per-model breakdown
          </h2>
        </div>

        {isLoading && (
          <div className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
        )}
        {isError && (
          <div className="px-5 py-8 text-sm text-red-500 dark:text-red-400">
            Failed to load model data.
          </div>
        )}

        {!isLoading && !isError && (
          <div className="overflow-x-auto scrollbar-hide">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800">
                  {(['Model', 'Cost', 'Input', 'Output', 'Cache', 'Events'] as const).map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedModels.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                    >
                      No model data found.
                    </td>
                  </tr>
                )}
                {sortedModels.map((m) => (
                  <tr
                    key={m.modelFamily}
                    className="border-b border-gray-100 dark:border-gray-800 bg-transparent dark:bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-950 dark:text-white">
                      {m.modelFamily}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-700 dark:text-gray-300">
                      {formatUsd(m.costUsd)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600 dark:text-gray-400">
                      {fmtK(m.inputTokens)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600 dark:text-gray-400">
                      {fmtK(m.outputTokens)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600 dark:text-gray-400">
                      {fmtK(m.cacheCreationTokens + m.cacheReadTokens)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-gray-600 dark:text-gray-400">
                      {m.events}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
