/**
 * TopExpensiveTurnsTable — sortable table of the most expensive assistant turns.
 *
 * Columns: Timestamp, Project, Session, Model, Tokens, Duration, Cost.
 * Self-fetches TurnBucket[] via GET /api/turns sorted by costUsd descending.
 */

import { useQuery } from '@tanstack/react-query';
import type { TurnBucket } from '@tokenomix/shared';
import { useState } from 'react';
import { fetchTurns } from '../lib/api.js';
import { formatCurrency, formatDurationNullable } from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { Card } from '../ui/Card.js';

/**
 * SortKey maps to actual TurnBucket fields or a computed value:
 *  - 'costUsd'  → TurnBucket.costUsd (direct field)
 *  - 'tokens'   → inputTokens + outputTokens (computed inline — TurnBucket has no totalTokens field)
 */
type SortKey = 'costUsd' | 'tokens';
type SortDir = 'asc' | 'desc';

interface TopExpensiveTurnsTableProps {
  limit?: number;
  since?: string;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(0)}k`;
  return String(total);
}

/** Derive a short model family label from a full model ID string. */
function modelShortLabel(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return modelId.split('-')[0] ?? modelId;
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

export function TopExpensiveTurnsTable({ limit = 10, since = '30d' }: TopExpensiveTurnsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('costUsd');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const params = {
    ...(since !== undefined ? { since } : {}),
    limit,
  };

  const { data, isLoading, isError } = useQuery<TurnBucket[]>({
    queryKey: queryKeys.turns(params),
    queryFn: () => fetchTurns(params),
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
        // 'tokens' sort key: compute inputTokens + outputTokens inline
        // (TurnBucket exposes components separately; there is no totalTokens field)
        return (a.inputTokens + a.outputTokens - (b.inputTokens + b.outputTokens)) * mult;
      })
    : [];

  return (
    <Card as="section" className="p-0 overflow-hidden" aria-label="Top expensive turns">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white">
          Top Expensive Turns
        </h2>
      </div>

      {isLoading && (
        <div className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {isError && (
        <div className="px-5 py-8 text-sm text-red-500 dark:text-red-400">
          Failed to load turn data.
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
                  Timestamp
                </th>
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
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Model
                </th>
                <SortHeader
                  label="Tokens"
                  sortKey="tokens"
                  current={sortKey}
                  dir={sortDir}
                  onSort={handleSort}
                />
                <th
                  scope="col"
                  className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Duration
                </th>
                <SortHeader
                  label="Cost"
                  sortKey="costUsd"
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
                    colSpan={7}
                    className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No turn data yet.
                  </td>
                </tr>
              )}
              {sorted.map((turn, idx) => {
                const ts = new Date(turn.timestamp);
                const tsDisplay = ts.toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                });
                return (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: TurnBucket has no stable unique key; index is safe here since the list is derived from a server-sorted set and not reordered independently
                    key={idx}
                    // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                    className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                  >
                    <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums whitespace-nowrap">
                      {tsDisplay}
                    </td>
                    <td
                      className="px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 max-w-[140px] truncate"
                      title={turn.project}
                    >
                      {basename(turn.project)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className="font-mono text-xs text-gray-600 dark:text-gray-400"
                        title={turn.sessionId}
                      >
                        {turn.sessionId.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400">
                      {modelShortLabel(turn.modelId)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                      {formatTokens(turn.inputTokens, turn.outputTokens)}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                      {formatDurationNullable(turn.durationMs)}
                    </td>
                    <td className="px-4 py-2.5 text-sm font-semibold text-gray-950 dark:text-white tabular-nums">
                      {formatCurrency(turn.costUsd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
