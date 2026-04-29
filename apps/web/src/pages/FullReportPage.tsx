/**
 * FullReportPage — comprehensive session table at /report.
 *
 * Fetches GET /api/sessions?limit=500 via the existing fetchSessions helper
 * and renders a client-side sortable, paginated, filterable table of all sessions.
 *
 * Columns:
 *   Date (sortable; based on session.firstTs — nulls sort to end)
 *   Project (sortable; case-insensitive localeCompare on session.projectName)
 *   Top Tools (up to 3 ToolBucket chips + "+N more" overflow badge)
 *   Cost (formatted $X.XX)
 *   Input Tokens (locale-grouped)
 *   Output Tokens (locale-grouped)
 *   Events (locale-grouped)
 *
 * Cache Creation and Cache Read tokens are omitted from this view for
 * readability; they remain in SessionSummary and the CSV export.
 *
 * Default sort: date descending (most recent first).
 * Clicking any column header toggles ascending / descending.
 * Pagination: 50 rows per page.
 *
 * Filtering pipeline (applied in order):
 *   1. Date-range filter (prune by firstTs)
 *   2. Search filter (prune by projectName OR sessionId substring)
 *   3. Sort (sortKey + sortDir)
 *   4. Pagination (50/page)
 *
 * Subtitle stats reflect the filtered set (after steps 1–2, pre-sort, pre-page).
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { SessionSummary } from '@tokenomix/shared';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Search,
} from 'lucide-react';
import { useState } from 'react';
import { fetchSessions } from '../lib/api.js';
import { exportSessionsCsv } from '../lib/csvExport.js';
import {
  formatCurrency,
  formatDateRange,
  formatProjectName,
  formatSessionDate,
  formatTokens,
} from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { MetricCard } from '../panels/MetricCard.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { Select } from '../ui/Select.js';
import type { SelectOption } from '../ui/Select.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortKey =
  | 'date'
  | 'project'
  | keyof Pick<SessionSummary, 'costUsd' | 'inputTokens' | 'outputTokens' | 'events'>;

type SortDir = 'asc' | 'desc';

type DateRangePreset = 'all' | '7d' | '30d' | '90d' | 'thisMonth' | 'lastMonth';

// ---------------------------------------------------------------------------
// Date range options (typed for Select primitive)
// ---------------------------------------------------------------------------

const DATE_RANGE_OPTIONS: ReadonlyArray<SelectOption<DateRangePreset>> = [
  { value: 'all', label: 'All time' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
] as const;

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
// Date-range filter helpers
// ---------------------------------------------------------------------------

/**
 * Returns the cutoff [startMs, endMs] inclusive range for a given preset,
 * using the provided `now` as the reference time. Returns null for 'all'.
 */
function getPresetRange(preset: DateRangePreset, now: Date): [number, number] | null {
  if (preset === 'all') return null;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStartMs = todayStart.getTime();

  if (preset === '7d') {
    return [todayStartMs - 6 * 86_400_000, now.getTime()];
  }
  if (preset === '30d') {
    return [todayStartMs - 29 * 86_400_000, now.getTime()];
  }
  if (preset === '90d') {
    return [todayStartMs - 89 * 86_400_000, now.getTime()];
  }
  if (preset === 'thisMonth') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = now.getTime();
    return [start, end];
  }
  if (preset === 'lastMonth') {
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return [lastMonthStart.getTime(), lastMonthEnd.getTime()];
  }
  return null;
}

/**
 * Apply date-range preset filter to sessions.
 * - preset === 'all': include all sessions (including firstTs === null)
 * - any other preset: exclude sessions where firstTs === null; include only
 *   sessions whose firstTs falls within [rangeStart, rangeEnd].
 */
function applyDateFilter(
  sessions: SessionSummary[],
  preset: DateRangePreset,
  now: Date
): SessionSummary[] {
  const range = getPresetRange(preset, now);
  if (range === null) return sessions; // 'all' — include everything
  const [rangeStart, rangeEnd] = range;
  return sessions.filter((s) => {
    if (s.firstTs === null) return false; // exclude null timestamps in non-'all' presets
    const ts = new Date(s.firstTs).getTime();
    if (isNaN(ts)) return false;
    return ts >= rangeStart && ts <= rangeEnd;
  });
}

/**
 * Apply search filter: case-insensitive substring match against
 * session.projectName OR session.sessionId. Empty query passes all.
 */
function applySearchFilter(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (q === '') return sessions;
  return sessions.filter(
    (s) =>
      (s.projectName ?? '').toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortSessions(sessions: SessionSummary[], key: SortKey, dir: SortDir): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const mult = dir === 'desc' ? -1 : 1;

    if (key === 'date') {
      // Nulls always sort to the end regardless of direction.
      const aTs = a.firstTs ?? '';
      const bTs = b.firstTs ?? '';
      if (aTs === '' && bTs === '') return 0;
      if (aTs === '') return 1;
      if (bTs === '') return -1;
      // ISO 8601 strings are lexicographically chronological.
      return aTs < bTs ? -1 * mult : aTs > bTs ? 1 * mult : 0;
    }

    if (key === 'project') {
      const aName = a.projectName ?? '';
      const bName = b.projectName ?? '';
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' }) * mult;
    }

    // Numeric columns — key is a keyof SessionSummary with number values.
    return ((a[key] as number) - (b[key] as number)) * mult;
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
  align?: 'left' | 'right' | 'center';
  className?: string;
}

function SortableHeader({
  label,
  sortKey,
  current,
  dir,
  onSort,
  align = 'left',
  className = '',
}: SortableHeaderProps) {
  const active = current === sortKey;
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      scope="col"
      className={`px-4 py-3 ${alignClass} ${className}`}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={[
          'inline-flex items-center justify-center gap-1 whitespace-nowrap text-xs font-medium uppercase tracking-wide transition-colors',
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
  const overflow = (session.toolNamesCount ?? 0) > 3 ? (session.toolNamesCount ?? 0) - 3 : 0;

  if (tools.length === 0) {
    return (
      <span className="text-gray-400 dark:text-gray-600" aria-label="No tool data">
        —
      </span>
    );
  }

  return (
    <div
      className="flex flex-col gap-1.5 items-start"
      aria-label={`Top tools: ${tools.map((t) => t.toolName).join(', ')}${overflow > 0 ? ` and ${overflow} more` : ''}`}
    >
      {/* Row 1: top-3 chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tools.map((tool) => (
          <span
            key={tool.toolName}
            className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200"
          >
            <span className="max-w-[84px] truncate">{tool.toolName}</span>
            <span className="tabular-nums text-gray-500 dark:text-gray-400">{tool.count}</span>
          </span>
        ))}
      </div>
      {/* Row 2: +N more — always on its own line when overflow > 0 */}
      {overflow > 0 ? (
        <Link
          to="/report/$sessionId"
          params={{ sessionId: session.sessionId }}
          hash="tools"
          className={[
            'text-xs font-medium text-gray-500 dark:text-gray-400 transition-colors',
            // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
            'hover:text-gray-700 dark:hover:text-gray-200',
          ].join(' ')}
          aria-label={`View ${overflow} more tools for this session`}
        >
          +{overflow} more
        </Link>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows (loading state)
// ---------------------------------------------------------------------------

// 7 columns: Date, Project, Top Tools, Cost, Input Tokens, Output Tokens, Events
const SKELETON_ROW_KEYS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] as const;
// First 3 cells are left-aligned (Date, Project, Top Tools); trailing 4 are center-aligned (numeric).
const SKELETON_CELL_KEYS: { key: string; align: 'left' | 'center' }[] = [
  { key: 'c0', align: 'left' },
  { key: 'c1', align: 'left' },
  { key: 'c2', align: 'left' },
  { key: 'c3', align: 'center' },
  { key: 'c4', align: 'center' },
  { key: 'c5', align: 'center' },
  { key: 'c6', align: 'center' },
];

function SkeletonRows() {
  return (
    <>
      {SKELETON_ROW_KEYS.map((rk) => (
        <tr key={rk} className="border-t border-gray-200 dark:border-gray-800">
          {SKELETON_CELL_KEYS.map(({ key: ck, align }) => (
            <td
              key={`${rk}-${ck}`}
              className={`px-4 py-3${align === 'center' ? ' text-center' : ''}`}
            >
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
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [pageIndex, setPageIndex] = useState<number>(0);
  const [datePreset, setDatePreset] = useState<DateRangePreset>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

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

  function handleDatePresetChange(preset: DateRangePreset) {
    setDatePreset(preset);
    setPageIndex(0);
  }

  function handleSearchChange(q: string) {
    setSearchQuery(q);
    setPageIndex(0);
  }

  const sessions = data ?? [];

  // ---------------------------------------------------------------------------
  // Filtering pipeline (applied before sort and pagination)
  // ---------------------------------------------------------------------------

  // Step 1: Date-range filter
  const now = new Date();
  const dateFiltered = isLoading ? [] : applyDateFilter(sessions, datePreset, now);

  // Step 2: Search filter
  const filtered = isLoading ? [] : applySearchFilter(dateFiltered, searchQuery);

  // KPI stats reflect the filtered set (pre-sort, pre-page)
  const filteredCount = filtered.length;
  const filteredTotalCost = filtered.reduce((sum, s) => sum + s.costUsd, 0);
  const filteredTotalTokens = filtered.reduce(
    (sum, s) => sum + s.inputTokens + s.outputTokens,
    0
  );
  const filteredAvgCost = filteredCount > 0 ? filteredTotalCost / filteredCount : 0;

  // Date range covered by the filtered set (from firstTs values)
  const filteredTimestamps = filtered
    .map((s) => s.firstTs)
    .filter((ts): ts is string => ts !== null && !isNaN(new Date(ts).getTime()))
    .map((ts) => new Date(ts).getTime());
  const filteredMinTs =
    filteredTimestamps.length > 0
      ? new Date(Math.min(...filteredTimestamps)).toISOString()
      : null;
  const filteredMaxTs =
    filteredTimestamps.length > 0
      ? new Date(Math.max(...filteredTimestamps)).toISOString()
      : null;
  const dateRangeLabel = formatDateRange(filteredMinTs, filteredMaxTs);

  // Step 3: Sort
  const sorted = isLoading ? [] : sortSessions(filtered, sortKey, sortDir);

  // Step 4: Pagination
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSessions = sorted.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);

  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl mx-auto">
      {/* ── Page header card ── */}
      <Card as="section" aria-label="Full report header">
        {/* ROW 1: back arrow + title | Export CSV button */}
        <div className="flex items-center justify-between gap-4">
          {/* Left: back arrow + h1 */}
          <div className="flex items-center gap-3">
            <Link
              to="/"
              aria-label="Back to overview"
              className={[
                'inline-flex h-8 w-8 items-center justify-center rounded-lg',
                'text-gray-600 dark:text-gray-400',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                'hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
              ].join(' ')}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
            <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white">
              Full Session Report
            </h1>
          </div>

          {/* Right: Export CSV — primary pill button using Button primitive */}
          <Button
            variant="primary"
            Icon={Download}
            className="rounded-full px-5 py-2.5"
            disabled={sessions.length === 0}
            onClick={() => exportSessionsCsv(filtered)}
            aria-label="Export filtered sessions as CSV"
          >
            Export CSV
          </Button>
        </div>

        {/* ROW 2: KPI grid — 4 MetricCards, no deltas */}
        {!isLoading && !isError && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            <MetricCard
              label="Sessions"
              value={filteredCount.toLocaleString()}
              deltaPercent={null}
            />
            <MetricCard
              label="Total Cost"
              value={formatCurrency(filteredTotalCost)}
              deltaPercent={null}
            />
            <MetricCard
              label="Total Tokens"
              value={formatTokens(filteredTotalTokens)}
              deltaPercent={null}
            />
            <MetricCard
              label="Avg / Session"
              value={filteredCount > 0 ? formatCurrency(filteredAvgCost) : '—'}
              deltaPercent={null}
            />
          </div>
        )}

        {/* Loading skeleton for KPI grid */}
        {isLoading && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
            {(['k0', 'k1', 'k2', 'k3'] as const).map((k) => (
              <div
                key={k}
                className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5"
              >
                <div className="h-3 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-800 mb-3" />
                <div className="h-7 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
              </div>
            ))}
          </div>
        )}

        {/* ROW 3: date range covered — subtle, only when filtered set is non-empty */}
        {!isLoading && !isError && filteredCount > 0 && dateRangeLabel !== '' && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">{dateRangeLabel}</p>
        )}

        {/* ROW 4: filter row */}
        <div className="flex flex-wrap items-center gap-3 mt-4">
          {/* Date range — custom Select primitive (not native <select>) */}
          <Select<DateRangePreset>
            value={datePreset}
            options={DATE_RANGE_OPTIONS}
            onChange={handleDatePresetChange}
            ariaLabel="Date range filter"
            widthClass="w-40"
          />

          {/* Search input */}
          <div className="relative flex-1 min-w-[200px]">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search projects or session IDs…"
              aria-label="Search sessions"
              className={[
                'w-full rounded-lg border border-gray-200 dark:border-gray-800',
                'bg-gray-50 dark:bg-gray-900',
                'pl-10 pr-3 py-2',
                'text-sm text-gray-900 dark:text-gray-100',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (placeholder:) hides the dark pairing from naive line scan
                'placeholder:text-gray-400 dark:placeholder:text-gray-500',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
                'transition-colors',
              ].join(' ')}
            />
          </div>
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
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-32" />
                  <col className="w-44" />
                  <col className="w-72" />
                  <col className="w-32" />
                  <col className="w-36" />
                  <col className="w-36" />
                  <col className="w-24" />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                    <SortableHeader
                      label="Date"
                      sortKey="date"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="Project"
                      sortKey="project"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    {/* Top Tools — non-sortable */}
                    <th
                      scope="col"
                      className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                      Top Tools
                    </th>
                    <SortableHeader
                      label="Cost"
                      sortKey="costUsd"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="center"
                    />
                    <SortableHeader
                      label="Input Tokens"
                      sortKey="inputTokens"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="center"
                    />
                    <SortableHeader
                      label="Output Tokens"
                      sortKey="outputTokens"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="center"
                    />
                    <SortableHeader
                      label="Events"
                      sortKey="events"
                      current={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="center"
                    />
                  </tr>
                </thead>
                <tbody>
                  {isLoading && <SkeletonRows />}

                  {!isLoading && sorted.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-500"
                      >
                        {sessions.length === 0 ? 'No sessions yet.' : 'No sessions match the current filters.'}
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
                        {/* Date */}
                        <td className="px-4 py-3 text-sm tabular-nums text-gray-700 dark:text-gray-300">
                          {formatSessionDate(session.firstTs)}
                        </td>

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
                        <td className="px-4 py-3 text-center text-sm font-medium tabular-nums text-gray-950 dark:text-white">
                          {formatCost(session.costUsd)}
                        </td>

                        {/* Input Tokens */}
                        <td className="px-4 py-3 text-center text-sm tabular-nums text-gray-600 dark:text-gray-400">
                          {formatNum(session.inputTokens)}
                        </td>

                        {/* Output Tokens */}
                        <td className="px-4 py-3 text-center text-sm tabular-nums text-gray-600 dark:text-gray-400">
                          {formatNum(session.outputTokens)}
                        </td>

                        {/* Events */}
                        <td className="px-4 py-3 text-center text-sm tabular-nums text-gray-600 dark:text-gray-400">
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
