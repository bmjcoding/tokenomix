/**
 * FullReportPage — comprehensive session table at /report.
 *
 * Fetches GET /api/sessions?limit=500 via the existing fetchSessions helper
 * and renders a client-side sortable, paginated table of all sessions.
 *
 * Columns:
 *   Project (basename with Link to /report/$sessionId; secondary session ID line)
 *   Top Tools (up to 3 ToolBucket chips + "+N more" overflow badge)
 *   Cost (formatted $X.XX)
 *   Input Tokens (locale-grouped)
 *   Output Tokens (locale-grouped)
 *   Cache Creation (locale-grouped)
 *   Cache Read (locale-grouped)
 *   Events (locale-grouped)
 *
 * Default sort: costUsd descending.
 * Clicking any column header toggles ascending / descending.
 * Pagination: 50 rows per page.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { SessionSummary } from '@tokenomix/shared';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download } from 'lucide-react';
import { useState } from 'react';
import { fetchSessions } from '../lib/api.js';
import { exportSessionsCsv } from '../lib/csvExport.js';
import { formatProjectName } from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

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
    <th
      scope="col"
      className={`px-4 py-3 text-left ${className}`}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
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
// Top Tools chip cell
// ---------------------------------------------------------------------------

interface TopToolsCellProps {
  session: SessionSummary;
}

function TopToolsCell({ session }: TopToolsCellProps) {
  const tools = session.topTools ?? [];
  const overflow = session.toolNamesCount > 3 ? session.toolNamesCount - 3 : 0;

  if (tools.length === 0) {
    return <span className="text-gray-400 dark:text-gray-600" aria-label="No tool data">—</span>;
  }

  const tooltipText =
    session.toolNamesCount > 3
      ? `Showing top 3 of ${session.toolNamesCount} tools`
      : undefined;

  return (
    <div
      className="flex flex-wrap gap-1"
      title={tooltipText}
      aria-label={`Top tools: ${tools.map((t) => t.toolName).join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`}
    >
      {tools.map((tool) => (
        <span
          key={tool.toolName}
          className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <span className="max-w-[84px] truncate">{tool.toolName}</span>
          <span className="tabular-nums text-gray-500 dark:text-gray-400">{tool.count}</span>
        </span>
      ))}
      {overflow > 0 && (
        <span className="inline-flex items-center text-xs font-medium rounded-full px-2 py-0.5 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
          +{overflow} more
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows (loading state)
// ---------------------------------------------------------------------------

// 8 columns: Project, Top Tools, Cost, Input, Output, Cache Create, Cache Read, Events
const SKELETON_ROW_KEYS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] as const;
const SKELETON_CELL_KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] as const;

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
// Pagination controls
// ---------------------------------------------------------------------------

interface PaginationProps {
  pageIndex: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}

function PaginationControls({ pageIndex, pageCount, onPrev, onNext }: PaginationProps) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-800 px-4 py-3">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        Page {pageIndex + 1} of {pageCount}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={pageIndex === 0}
          aria-label="Previous page"
          className={[
            'inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
            'text-gray-600 dark:text-gray-400',
            // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
            'hover:bg-gray-100 dark:hover:bg-gray-800',
            // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
            'disabled:pointer-events-none disabled:opacity-40',
          ].join(' ')}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={pageIndex >= pageCount - 1}
          aria-label="Next page"
          className={[
            'inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
            'text-gray-600 dark:text-gray-400',
            // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
            'hover:bg-gray-100 dark:hover:bg-gray-800',
            // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
            'disabled:pointer-events-none disabled:opacity-40',
          ].join(' ')}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function FullReportPage() {
  const [sortKey, setSortKey] = useState<SortKey>('costUsd');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [pageIndex, setPageIndex] = useState<number>(0);

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
    setPageIndex(0);
  }

  const sessions = data ?? [];
  const sorted = isLoading ? [] : sortSessions(sessions, sortKey, sortDir);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSessions = sorted.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);

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
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                    {/* Project — non-sortable; serves as primary identifier */}
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      Project
                    </th>
                    {/* Top Tools — non-sortable */}
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      Top Tools
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
                        colSpan={8}
                        className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-500"
                      >
                        No sessions yet.
                      </td>
                    </tr>
                  )}

                  {!isLoading &&
                    pageSessions.map((session) => (
                      <tr
                        key={session.sessionId}
                        // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                        className="border-t border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                      >
                        {/* Project — basename as Link; session ID as secondary muted mono line */}
                        <td className="px-4 py-3 max-w-[220px]">
                          <Link
                            to="/report/$sessionId"
                            params={{ sessionId: session.sessionId }}
                            title={session.project}
                            className={[
                              'group block',
                              // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                              'rounded-lg focus-visible:ring-offset-1',
                            ].join(' ')}
                          >
                            <span
                              className={[
                                'block text-sm font-semibold text-gray-950 dark:text-white truncate',
                                // design-lint-disable dark-mode-pairs: compound modifier prefix (group-hover:) hides the dark pairing from naive line scan
                                'group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors',
                              ].join(' ')}
                            >
                              {formatProjectName(session.project)}
                            </span>
                            <span className="block font-mono text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {truncateSessionId(session.sessionId)}
                            </span>
                          </Link>
                        </td>

                        {/* Top Tools — chip badges */}
                        <td className="px-4 py-3">
                          <TopToolsCell session={session} />
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

            <PaginationControls
              pageIndex={pageIndex}
              pageCount={pageCount}
              onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
              onNext={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
            />
          </>
        )}
      </Card>
    </div>
  );
}
