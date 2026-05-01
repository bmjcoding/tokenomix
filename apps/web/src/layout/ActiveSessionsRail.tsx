/**
 * ActiveSessionsRail — collapsible live-session panel anchored at top-right.
 *
 * Collapsed state: a pill button showing a pulsing dot and session count (or
 * muted "No live sessions" when count is zero). Expanded state: a rounded-xl
 * dialog panel listing up to 10 active sessions.
 *
 * "Active" means the session's computed lastTs (firstTs + durationMs) falls
 * within ACTIVE_SESSION_WINDOW_MS (5 minutes) of the current time.
 *
 * Dismissal:
 *   - Click outside the panel root (pointerdown on document, capture phase)
 *   - Press Escape
 *   - Click the X button inside the panel header
 *
 * Focus management:
 *   - Opening moves focus to the first interactive element inside the panel.
 *   - Closing returns focus to the pill button.
 *
 * Hidden on screens below lg breakpoint (hidden lg:block wrapper).
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { SessionSummary } from '@tokenomix/shared';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ACTIVE_SESSION_WINDOW_MS } from '../lib/activeSessionConstants.js';
import { fetchActiveSessions } from '../lib/api.js';
import {
  formatCurrency,
  formatProjectName,
  formatTimeSince,
  formatTokens,
} from '../lib/formatters.js';
import { queryKeys } from '../lib/query-keys.js';
import { useMotionPreference } from '../providers/MotionPreferenceProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derives the lastTs epoch ms for a session. Returns null when fields absent. */
function computeLastTs(session: SessionSummary): number | null {
  if (session.firstTs === null || session.durationMs === null) return null;
  return new Date(session.firstTs).getTime() + session.durationMs;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ActiveSessionsRail() {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const panelRef = useRef<HTMLElement>(null);
  const pillButtonRef = useRef<HTMLButtonElement>(null);

  const { motionPreference } = useMotionPreference();

  const { data, isLoading, isError } = useQuery<SessionSummary[]>({
    queryKey: queryKeys.activeSessions({ windowMs: ACTIVE_SESSION_WINDOW_MS, limit: 10 }),
    queryFn: () => fetchActiveSessions({ windowMs: ACTIVE_SESSION_WINDOW_MS, limit: 10 }),
  });

  // Tick now every 30 seconds to keep time-since labels current
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Collapse on Escape
  useEffect(() => {
    if (!expanded) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExpanded(false);
        requestAnimationFrame(() => pillButtonRef.current?.focus());
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  // Collapse on click outside
  useEffect(() => {
    if (!expanded) return;

    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setExpanded(false);
        requestAnimationFrame(() => pillButtonRef.current?.focus());
      }
    }

    // Use capture so we see the event before any child handler
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [expanded]);

  // Focus management: open → first interactive element inside panel
  useEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current;
    if (!panel) return;

    const id = requestAnimationFrame(() => {
      const first = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  function collapse() {
    setExpanded(false);
    requestAnimationFrame(() => pillButtonRef.current?.focus());
  }

  // Sessions are already filtered and sorted by the server.
  const activeSessions = data ?? [];
  const count = activeSessions.length;

  // Pulse dot class
  const dotClass =
    count > 0
      ? motionPreference !== 'reduced'
        ? 'h-2 w-2 rounded-full bg-primary animate-pulse'
        : 'h-2 w-2 rounded-full bg-primary'
      : 'h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600';

  // Pill label text (dot is rendered as a separate span)
  let pillText: string;
  if (isLoading && !data) {
    pillText = 'Live · …';
  } else if (isError) {
    pillText = 'Live · !';
  } else if (count === 0) {
    pillText = 'No live sessions';
  } else {
    pillText = `Live · ${count}`;
  }

  return (
    <div className="hidden lg:block fixed top-20 right-6 z-50">
      {expanded ? (
        <section
          ref={panelRef}
          aria-label="Active sessions"
          className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white/90 p-3 backdrop-blur-sm max-h-[70vh] overflow-y-auto max-w-[320px] min-w-[280px] dark:border-gray-700 dark:bg-gray-900/90"
        >
          {/* Panel header */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
              Active sessions
            </span>
            <button
              type="button"
              aria-label="Close active sessions"
              onClick={collapse}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:ring-white dark:focus-visible:ring-white"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {/* Session list */}
          {isError ? (
            <p className="py-4 text-center text-xs text-red-500 dark:text-red-400">
              Could not load active sessions.
            </p>
          ) : activeSessions.length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-500 dark:text-gray-400">
              No active sessions in the last 5 minutes.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {activeSessions.map((s) => {
                const lastTs = computeLastTs(s);
                const timeSince = lastTs !== null ? formatTimeSince(now, lastTs) : '—';
                const displayName = formatProjectName(s.project);
                const cost = formatCurrency(s.costUsd);
                const id7 = s.sessionId.slice(0, 8).toLowerCase();
                const turnLabel = s.events === 1 ? '1 turn' : `${s.events} turns`;
                const tokenCount = s.inputTokens + s.outputTokens;
                const formattedTokens = formatTokens(tokenCount);
                const ariaLabel = `Open session ${id7}, project ${displayName}, ${cost} spend, last active ${timeSince} ago, ${formattedTokens} input + output tokens`;

                return (
                  <li key={s.sessionId}>
                    <Link
                      to="/report/$sessionId"
                      params={{ sessionId: s.sessionId }}
                      aria-label={ariaLabel}
                      className="block rounded-xl border border-gray-200 bg-gray-50 p-3 transition-colors hover:bg-gray-100 dark:border-gray-800 dark:bg-gray-900 dark:hover:bg-gray-800"
                    >
                      {/* Top row: project name + cost */}
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-sm text-gray-950 dark:text-white">
                          {displayName}
                        </span>
                        <span className="shrink-0 tabular-nums text-sm text-gray-950 dark:text-white">
                          {cost}
                        </span>
                      </div>
                      {/* Mid row: short session id + time-since */}
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                          {id7}&hellip;
                        </span>
                        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                          {timeSince}
                        </span>
                      </div>
                      {/* Bottom row: turn count + token count */}
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {turnLabel}
                        </span>
                        <span className="shrink-0 tabular-nums text-xs text-gray-500 dark:text-gray-400">
                          {formattedTokens} tok
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
        <button
          ref={pillButtonRef}
          type="button"
          aria-label="Active sessions"
          aria-expanded={expanded}
          onClick={() => setExpanded(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 text-sm text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 dark:ring-white dark:focus-visible:ring-white"
        >
          <span className={dotClass} aria-hidden="true" />
          <span>{pillText}</span>
        </button>
      )}
    </div>
  );
}
