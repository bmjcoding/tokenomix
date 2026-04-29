/**
 * SubagentLeaderboard — sortable table of subagent activity by agent type.
 *
 * Columns: Agent Type, Turns, Total Tokens, Total Cost, Avg Duration, Success Rate.
 * Self-fetches MetricSummary; renders data from MetricSummary.bySubagent.
 * Default sort: Dispatches descending.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary, MetricsQuery } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchMetrics } from '../lib/api.js';
import { formatDuration } from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { Card } from '../ui/Card.js';

type SortKey = 'dispatches' | 'totalTokens' | 'totalCostUsd' | 'avgDurationMs' | 'successRate';
type SortDir = 'asc' | 'desc';

interface SubagentLeaderboardProps {
  since?: string;
}

function formatUsd(v: number): string {
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function formatLargeNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}

function SortHeader({ label, sortKey, current, dir, onSort }: SortHeaderProps) {
  const active = current === sortKey;
  return (
    <th scope="col" className="px-4 py-2 text-left">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={[
          'text-xs font-medium uppercase tracking-wide transition-colors',
          // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-1',
          active
            ? 'text-gray-950 dark:text-white'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
        ].join(' ')}
        aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
      >
        {label}
        {active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
}

export function SubagentLeaderboard({ since }: SubagentLeaderboardProps) {
  const [sortKey, setSortKey] = useState<SortKey>('dispatches');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const query: MetricsQuery = {
    ...(since !== undefined ? { since } : {}),
  };

  const { data, isLoading, isError } = useQuery<MetricSummary>({
    queryKey: queryKeys.metrics(query),
    queryFn: () => fetchMetrics(query),
  });

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = data?.bySubagent
    ? [...data.bySubagent].sort((a, b) => {
        const mult = sortDir === 'desc' ? -1 : 1;
        return (a[sortKey] - b[sortKey]) * mult;
      })
    : [];

  return (
    <Card as="section" className="p-0 overflow-hidden" aria-label="Subagent leaderboard">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">
          Subagent Leaderboard
        </h2>
      </div>

      {isLoading && (
        <div className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {isError && (
        <div className="px-5 py-8 text-sm text-red-500 dark:text-red-400">
          Failed to load subagent data.
        </div>
      )}

      {!isLoading && !isError && (
        <div className="overflow-x-auto scrollbar-hide">
          {/* biome-ignore lint/a11y/useSemanticElements: role=grid on <table> adds interactive grid semantics for sortable data; converting to a native grid element would replace the entire table layout system */}
          <table className="w-full text-sm" role="grid">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Agent Type
                </th>
                <SortHeader
                  label="Turns"
                  sortKey="dispatches"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Total Tokens"
                  sortKey="totalTokens"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Total Cost"
                  sortKey="totalCostUsd"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Avg Duration"
                  sortKey="avgDurationMs"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Success Rate"
                  sortKey="successRate"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No subagent activity yet.
                  </td>
                </tr>
              )}
              {sorted.map((agent) => (
                <tr
                  key={agent.agentType}
                  // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                >
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300">
                    {agent.agentType}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {formatLargeNumber(agent.dispatches)}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {formatLargeNumber(agent.totalTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-950 dark:text-white tabular-nums">
                    {formatUsd(agent.totalCostUsd)}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {agent.avgDurationMs > 0 ? formatDuration(agent.avgDurationMs) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {(agent.successRate * 100).toFixed(1)}%
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
