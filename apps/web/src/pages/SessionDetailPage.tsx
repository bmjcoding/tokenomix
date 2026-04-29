/**
 * SessionDetailPage — per-session detail view at /report/:sessionId.
 *
 * Fetches GET /api/sessions/:sessionId via fetchSessionDetail and renders:
 *   - Header card: back link, project short name h1, session ID (mono),
 *     full project path, and first/last timestamps.
 *   - KPI MetricCard row: cost, input tokens, output tokens, cache creation,
 *     cache read, events.
 *   - Three-tab Tabs panel:
 *       Overview  — session timing info and key stats
 *       Tools     — ToolMixBar donut + breakdown table
 *       Turns     — per-turn table
 *
 * Design system tokens:
 *   Card surface: bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5
 *   Section title: text-base font-semibold text-gray-950 dark:text-white mb-4
 *   Mono path/id: font-mono text-xs text-gray-500 dark:text-gray-400
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { SessionDetail, SessionTurnRow } from '@tokenomix/shared';
import { ArrowLeft } from 'lucide-react';
import { fetchSessionDetail } from '../lib/api.js';
import { formatCurrency, formatDuration, formatProjectName, formatTokens } from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { MetricCard } from '../panels/MetricCard.js';
import { Card } from '../ui/Card.js';
import type { TabItem } from '../ui/Tabs.js';
import { Tabs } from '../ui/Tabs.js';
import { ToolMixBar } from '../charts/ToolMixBar.js';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Formats a percent (0..1) as "X.X%", or "—" when zero. */
function fmtErrorRate(rate: number): string {
  if (rate === 0) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** Derive total tool uses for a turn row. */
function totalToolUses(toolUses: Record<string, number>): number {
  return Object.values(toolUses).reduce((sum, n) => sum + n, 0);
}

/** Format ISO timestamp as compact local date+time. */
function fmtTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

const SKELETON_WIDTHS = ['w-24', 'w-32', 'w-20', 'w-28', 'w-16', 'w-24'] as const;

function LoadingSkeleton() {
  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl mx-auto">
      {/* Header skeleton */}
      <Card as="section" aria-label="Session detail header loading">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 h-8 w-8 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800" />
          <div className="flex-1 space-y-2">
            <div className="h-7 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            <div className="h-4 w-64 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
            <div className="h-3 w-96 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
          </div>
        </div>
      </Card>

      {/* KPI row skeleton */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        {SKELETON_WIDTHS.map((w, i) => (
          <Card key={i} as="article" aria-label="Loading metric" className="flex flex-col gap-2">
            <div className={`h-3 ${w} animate-pulse rounded bg-gray-200 dark:bg-gray-800`} />
            <div className="h-7 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error / not-found state
// ---------------------------------------------------------------------------

function ErrorState({ message, is404 }: { message: string; is404: boolean }) {
  const heading = is404 ? 'Session not found' : "Couldn't load session — please try again";
  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl mx-auto">
      <Card as="section" aria-label={heading}>
        <div className="flex flex-col items-center py-12 text-center gap-4">
          <p className="text-base font-semibold text-gray-950 dark:text-white">
            {heading}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">{message}</p>
          <Link
            to="/report"
            className={[
              'inline-flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300',
              // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
              'hover:text-gray-950 dark:hover:text-white transition-colors',
            ].join(' ')}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Sessions
          </Link>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab content
// ---------------------------------------------------------------------------

function OverviewTab({ detail }: { detail: SessionDetail }) {
  return (
    <div className="space-y-6 pt-6">
      <Card as="section" aria-label="Session overview">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white mb-4">
          Session Summary
        </h2>

        <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Session ID
            </dt>
            <dd className="mt-0.5 font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
              {detail.sessionId}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Project
            </dt>
            <dd
              className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400 break-all"
              title={detail.project}
            >
              {detail.project}
            </dd>
          </div>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Type
            </dt>
            <dd className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
              {detail.isSubagent ? 'Subagent' : 'Main session'}
            </dd>
          </div>

          {detail.firstTs !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                First Turn
              </dt>
              <dd className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
                {fmtTs(detail.firstTs)}
              </dd>
            </div>
          )}

          {detail.lastTs !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Last Turn
              </dt>
              <dd className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
                {fmtTs(detail.lastTs)}
              </dd>
            </div>
          )}

          {detail.firstTs !== null && detail.lastTs !== null && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Duration
              </dt>
              <dd className="mt-0.5 text-sm text-gray-700 dark:text-gray-300">
                {formatDuration(
                  new Date(detail.lastTs).getTime() - new Date(detail.firstTs).getTime()
                )}
              </dd>
            </div>
          )}
        </dl>

        {detail.firstTs === null && (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            Timestamps are unavailable — this session may have been evicted from the in-memory
            index.
          </p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools tab content
// ---------------------------------------------------------------------------

function ToolsTab({ detail }: { detail: SessionDetail }) {
  if (detail.byTool.length === 0) {
    return (
      <div className="pt-6">
        <Card as="section" aria-label="Tools breakdown empty">
          <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
            No tool usage data available for this session.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-6">
      {/* Donut chart */}
      <Card as="section" aria-label="Tool distribution donut chart">
        <h2 className="text-base font-semibold text-gray-950 dark:text-white mb-4">
          Tool Distribution
        </h2>
        <ToolMixBar data={detail.byTool} height={240} />
      </Card>

      {/* Breakdown table */}
      <Card as="section" className="p-0 overflow-hidden" aria-label="Tools breakdown table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Tool Name
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Count
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Errors
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Error Rate
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.byTool
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((tool) => (
                  <tr
                    key={tool.toolName}
                    // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                    className="border-t border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-gray-950 dark:text-white">
                      {tool.toolName}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {formatTokens(tool.count)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {formatTokens(tool.errorCount)}
                    </td>
                    <td
                      className={[
                        'px-4 py-3 text-right text-sm tabular-nums',
                        tool.errorRate > 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-500 dark:text-gray-500',
                      ].join(' ')}
                    >
                      {fmtErrorRate(tool.errorRate)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turns tab content
// ---------------------------------------------------------------------------

const TURN_SKELETON_KEYS = ['t0', 't1', 't2', 't3', 't4', 't5'] as const;
const TURN_CELL_KEYS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'] as const;

function TurnsTab({ turns }: { turns: SessionTurnRow[] }) {
  if (turns.length === 0) {
    return (
      <div className="pt-6">
        <Card as="section" aria-label="Turns table empty">
          <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
            No turns available for this session.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="pt-6">
      <Card as="section" className="p-0 overflow-hidden" aria-label="Session turns table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 w-12"
                >
                  #
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Model
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Cost
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Input Tokens
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Output Tokens
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Tools Used
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
                >
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn, idx) => {
                const toolCount = totalToolUses(turn.toolUses);
                return (
                  <tr
                    key={turn.timestamp + String(idx)}
                    // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                    className="border-t border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors"
                  >
                    <td className="px-4 py-3 text-right text-xs text-gray-500 dark:text-gray-500 tabular-nums">
                      {idx + 1}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {turn.modelFamily}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-gray-950 dark:text-white">
                      {formatCurrency(turn.costUsd)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {formatTokens(turn.inputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {formatTokens(turn.outputTokens)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {toolCount > 0 ? formatTokens(toolCount) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-600 dark:text-gray-400">
                      {turn.durationMs !== null ? formatDuration(turn.durationMs) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SessionDetailPage() {
  const { sessionId } = useParams({ from: '/_layout/report/$sessionId' });

  const { data: detail, isLoading, isError, error } = useQuery<SessionDetail>({
    queryKey: queryKeys.sessionDetail(sessionId),
    queryFn: () => fetchSessionDetail(sessionId),
    retry: (failureCount, err) => {
      // Do not retry 404s.
      if (err instanceof Error && err.message.includes('404')) return false;
      return failureCount < 2;
    },
  });

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (isError || detail === undefined) {
    const msg =
      error instanceof Error
        ? error.message
        : 'Could not load this session. It may not exist or the server is unavailable.';
    const is404 = error instanceof Error && error.message.includes('404');
    return <ErrorState message={msg} is404={is404} />;
  }

  const projectShortName = formatProjectName(detail.project);

  const tabItems: TabItem[] = [
    {
      key: 'overview',
      label: 'Overview',
      content: <OverviewTab detail={detail} />,
    },
    {
      key: 'tools',
      label: 'Tools',
      content: <ToolsTab detail={detail} />,
    },
    {
      key: 'turns',
      label: 'Turns',
      content: <TurnsTab turns={detail.turns} />,
    },
  ];

  return (
    <div className="space-y-6 py-6 px-4 sm:px-6 lg:px-8 max-w-screen-xl mx-auto">
      {/* ── Header card ── */}
      <Card as="section" aria-label="Session detail header">
        <div className="flex items-start gap-3">
          {/* Back arrow */}
          <Link
            to="/report"
            aria-label="Back to sessions list"
            className={[
              'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-600 dark:text-gray-400',
              // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
              'hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors',
              // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
              'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
            ].join(' ')}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>

          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white truncate">
              {projectShortName}
            </h1>

            {/* Subtitle row */}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Full session ID in mono */}
              <span
                className="font-mono text-xs text-gray-500 dark:text-gray-400 break-all"
                title="Session ID"
              >
                {detail.sessionId}
              </span>
            </div>

            {/* Full project path */}
            <p
              className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400 truncate"
              title={detail.project}
            >
              {detail.project}
            </p>

            {/* Timestamps */}
            {(detail.firstTs !== null || detail.lastTs !== null) && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {detail.firstTs !== null && (
                  <>
                    <span className="text-gray-400 dark:text-gray-500">Started </span>
                    {fmtTs(detail.firstTs)}
                  </>
                )}
                {detail.firstTs !== null && detail.lastTs !== null && (
                  <span className="mx-2 text-gray-300 dark:text-gray-600" aria-hidden="true">
                    &middot;
                  </span>
                )}
                {detail.lastTs !== null && (
                  <>
                    <span className="text-gray-400 dark:text-gray-500">Last turn </span>
                    {fmtTs(detail.lastTs)}
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* ── KPI MetricCard row ── */}
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6"
        role="region"
        aria-label="Session key metrics"
      >
        <MetricCard
          label="Total Cost"
          value={formatCurrency(detail.costUsd)}
          deltaPercent={null}
        />
        <MetricCard
          label="Input Tokens"
          value={formatTokens(detail.inputTokens)}
          deltaPercent={null}
        />
        <MetricCard
          label="Output Tokens"
          value={formatTokens(detail.outputTokens)}
          deltaPercent={null}
        />
        <MetricCard
          label="Cache Create"
          value={formatTokens(detail.cacheCreationTokens)}
          deltaPercent={null}
        />
        <MetricCard
          label="Cache Read"
          value={formatTokens(detail.cacheReadTokens)}
          deltaPercent={null}
        />
        <MetricCard
          label="Events"
          value={formatTokens(detail.events)}
          deltaPercent={null}
        />
      </div>

      {/* ── Tabbed panels ── */}
      <Tabs items={tabItems} ariaLabel="Session detail sections" />
    </div>
  );
}
