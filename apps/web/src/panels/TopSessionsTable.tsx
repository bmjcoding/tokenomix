/**
 * TopSessionsTable — sortable table of top sessions by cost.
 *
 * Columns: Project, Session ID, Cost, Tokens (in+out), Events
 * Session IDs shown truncated to 8 chars (full value in title attr).
 * Project paths show basename only.
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricsQuery, SessionSummary } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchSessions } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { Card } from '../ui/Card.js';

type SortKey = 'costUsd' | 'inputTokens' | 'events';
type SortDir = 'asc' | 'desc';

interface TopSessionsTableProps {
  limit?: number;
  since?: string;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function formatUsd(v: number): string {
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(0)}k`;
  return String(total);
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
    <th
      scope="col"
      className="px-4 py-2 text-left"
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
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
      >
        {label}
        {active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
}

export function TopSessionsTable({ limit = 10, since }: TopSessionsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('costUsd');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const query: MetricsQuery & { limit?: number } = {
    ...(since !== undefined ? { since } : {}),
    limit,
  };

  const { data, isLoading, isError } = useQuery<SessionSummary[]>({
    queryKey: queryKeys.sessions(query),
    queryFn: () => fetchSessions(query),
  });

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sorted = data
    ? [...data].sort((a, b) => {
        const mult = sortDir === 'desc' ? -1 : 1;
        if (sortKey === 'costUsd') return (a.costUsd - b.costUsd) * mult;
        if (sortKey === 'inputTokens') return (a.inputTokens - b.inputTokens) * mult;
        return (a.events - b.events) * mult;
      })
    : [];

  return (
    <Card as="section" className="p-0 overflow-hidden" aria-label="Top sessions">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">Top sessions</h2>
      </div>

      {isLoading && (
        <div className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {isError && (
        <div className="px-5 py-8 text-sm text-red-500 dark:text-red-400">
          Failed to load sessions.
        </div>
      )}

      {!isLoading && !isError && (
        <div className="overflow-x-auto scrollbar-hide">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Project
                </th>
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Session
                </th>
                <SortHeader
                  label="Cost"
                  sortKey="costUsd"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Tokens"
                  sortKey="inputTokens"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <SortHeader
                  label="Events"
                  sortKey="events"
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
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No sessions found.
                  </td>
                </tr>
              )}
              {sorted.map((session) => (
                <tr
                  key={session.sessionId}
                  // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                >
                  <td
                    className="px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 max-w-[180px] truncate"
                    title={session.project}
                  >
                    {basename(session.project)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className="font-mono text-xs text-gray-600 dark:text-gray-400"
                      title={session.sessionId}
                    >
                      {session.sessionId.slice(0, 8)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm font-medium text-gray-950 dark:text-white tabular-nums">
                    {formatUsd(session.costUsd)}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {formatTokens(session.inputTokens, session.outputTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                    {session.events}
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
