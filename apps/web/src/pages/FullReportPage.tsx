/**
 * FullReportPage — comprehensive session table at /report.
 *
 * Fetches GET /api/sessions?limit=500 via the existing fetchSessions helper
 * and renders a client-side sortable table of all sessions.
 *
 * Columns:
 *   Session ID (first 6 + "…" + last 4, monospace)
 *   Project (truncated to ~40 chars)
 *   Subagent (Badge if true)
 *   Cost (formatted $X.XX)
 *   Input Tokens (locale-grouped)
 *   Output Tokens (locale-grouped)
 *   Cache Creation (locale-grouped)
 *   Cache Read (locale-grouped)
 *   Events (locale-grouped)
 *
 * Default sort: costUsd descending.
 * Clicking any column header toggles ascending / descending.
 *
 * Note: SessionSummary in @tokenomix/shared does not carry firstTimestamp or
 * lastTimestamp fields; those columns are omitted accordingly.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { SessionSummary } from '@tokenomix/shared';
import { ArrowLeft, ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useState } from 'react';
import { fetchSessions } from '../lib/api.js';
import { exportSessionsCsv } from '../lib/csvExport.js';
import { queryKeys } from '../lib/query-keys.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey = keyof Pick<
  SessionSummary,
  'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'events'
>;

type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Truncate session ID: first 6 chars + "…" + last 4 chars. */
function truncateSessionId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** Truncate project string to ~40 chars with trailing ellipsis. */
function truncateProject(project: string, maxLen = 40): string {
  if (project.length <= maxLen) return project;
  return `${project.slice(0, maxLen)}…`;
}

/** Format cost as $X.XX (4 decimal places when < $1). */
function formatCost(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

/** Locale-grouped integer. */
function formatNum(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortSessions(sessions: SessionSummary[], key: SortKey, dir: SortDir): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const mult = dir === 'desc' ? -1 : 1;
    return (a[key] - b[key]) * mult;
  });
}

// ---------------------------------------------------------------------------
// Column header (sortable)
// ---------------------------------------------------------------------------

interface SortableHeaderProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}

function SortableHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className = '',
}: SortableHeaderProps) {
  const active = current === sortKey;
  return (
    <th scope="col" className={`px-4 py-3 text-left ${className}`}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={[
          'inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors',
          // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
          'focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
          active
            ? 'text-gray-950 dark:text-white'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
        ].join(' ')}
        aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
      >
        {label}
        {active &&
          (dir === 'desc' ? (
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3 w-3 shrink-0" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows (loading state)
// ---------------------------------------------------------------------------

const SKELETON_ROW_KEYS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] as const;
const SKELETON_CELL_KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const;

function SkeletonRows() {
  return (
    <>
      {SKELETON_ROW_KEYS.map((rk) => (
        <tr key={rk} className="border-t border-gray-200 dark:border-gray-800">
          {SKELETON_CELL_KEYS.map((ck) => (
            <td key={`${rk}-${ck}`} className="px-4 py-3">
              <div className="h-4 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function FullReportPage() {
  const [sortKey, setSortKey] = useState<SortKey>('costUsd');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const query = { limit: 500 } as const;

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

  const sessions = data ?? [];
  const sorted = isLoading ? [] : sortSessions(sessions, sortKey, sortDir);

  const totalCost = sessions.reduce((sum, s) => sum + s.costUsd, 0);

  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl mx-auto">
      {/* ── Page header card ── */}
      <Card as="section" aria-label="Full report header">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Link
              to="/"
              aria-label="Back to overview"
              className={[
                'mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-600 dark:text-gray-400',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                'hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
              ].join(' ')}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Link>

            <div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white">
                Full Session Report
              </h1>
              {!isLoading && !isError && (
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {sessions.length.toLocaleString()} session
                  {sessions.length !== 1 ? 's' : ''} &middot; total cost{' '}
                  <span className="font-medium tabular-nums text-gray-950 dark:text-white">
                    {formatCost(totalCost)}
                  </span>
                </p>
              )}
              {isLoading && (
                <div className="mt-1 h-4 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              )}
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            Icon={Download}
            disabled={sessions.length === 0}
            onClick={() => exportSessionsCsv(sessions)}
            aria-label="Export sessions as CSV"
          >
            Export CSV
          </Button>
        </div>
      </Card>

      {/* ── Sessions table card ── */}
      <Card as="section" className="p-0 overflow-hidden" aria-label="Sessions table">
        {isError && (
          <div className="px-5 py-8 text-sm text-red-600 dark:text-red-400" role="alert">
            Failed to load sessions. Please try refreshing the page.
          </div>
        )}

        {!isError && (
          <div className="overflow-x-auto">
            {/* biome-ignore lint/a11y/useSemanticElements: role=grid on <table> adds interactive grid semantics for sortable data; converting to a native grid element would replace the entire table layout system */}
            <table className="w-full text-sm" role="grid">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                  >
                    Session ID
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                  >
                    Project
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                  >
                    Type
                  </th>
                  <SortableHeader
                    label="Cost"
                    sortKey="costUsd"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Input Tokens"
                    sortKey="inputTokens"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Output Tokens"
                    sortKey="outputTokens"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Cache Create"
                    sortKey="cacheCreationTokens"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Cache Read"
                    sortKey="cacheReadTokens"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Events"
                    sortKey="events"
                    current={sortKey}
                    dir={sortDir}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody>
                {isLoading && <SkeletonRows />}

                {!isLoading && sorted.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-500"
                    >
                      No sessions yet.
                    </td>
                  </tr>
                )}

                {!isLoading &&
                  sorted.map((session) => (
                    <tr
                      key={session.sessionId}
                      // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                      className="border-t border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                    >
                      {/* Session ID — truncated, monospace, full value as title */}
                      <td className="px-4 py-3">
                        <span
                          className="font-mono text-xs text-gray-600 dark:text-gray-400"
                          title={session.sessionId}
                        >
                          {truncateSessionId(session.sessionId)}
                        </span>
                      </td>

                      {/* Project — truncated to 40 chars, full value as title */}
                      <td
                        className="px-4 py-3 max-w-[220px] text-sm text-gray-700 dark:text-gray-300"
                        title={session.project}
                      >
                        {truncateProject(session.project)}
                      </td>

                      {/* Is Subagent — Badge or empty */}
                      <td className="px-4 py-3">
                        {session.isSubagent ? <Badge variant="accent">subagent</Badge> : null}
                      </td>

                      {/* Cost */}
                      <td className="px-4 py-3 text-sm font-medium tabular-nums text-gray-950 dark:text-white">
                        {formatCost(session.costUsd)}
                      </td>

                      {/* Input Tokens */}
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">
                        {formatNum(session.inputTokens)}
                      </td>

                      {/* Output Tokens */}
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">
                        {formatNum(session.outputTokens)}
                      </td>

                      {/* Cache Creation Tokens */}
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">
                        {formatNum(session.cacheCreationTokens)}
                      </td>

                      {/* Cache Read Tokens */}
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">
                        {formatNum(session.cacheReadTokens)}
                      </td>

                      {/* Events */}
                      <td className="px-4 py-3 text-sm tabular-nums text-gray-600 dark:text-gray-400">
                        {formatNum(session.events)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
