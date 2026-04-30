/**
 * useServerEvents — subscribes to the /api/events SSE stream.
 *
 * On each `{type:'updated'}` message, invalidates the 'metrics', 'sessions',
 * 'turns', and 'session' TanStack Query cache keys so all panels refresh
 * automatically.
 *
 * ## Refresh modes
 *
 * The hook reads `refreshMode` from `useRefreshMode()` and branches:
 *
 * - **realtime** (default): opens an `EventSource('/api/events')`, invalidates
 *   all four query keys on each `{type:'updated'}` message, and tracks
 *   consecutive errors — dispatching `SSE_DEGRADED_EVENT` on the document once
 *   `MAX_CONSECUTIVE_ERRORS` is reached. The EventSource is closed on unmount
 *   or when the mode changes.
 *
 * - **minute**: does NOT open an EventSource. Instead, a `setInterval` fires
 *   every 60 000 ms and invalidates all four query keys unconditionally. The
 *   error counter and `SSE_DEGRADED_EVENT` logic are inactive in this branch.
 *   The interval is cleared on unmount or when the mode changes.
 *
 * Mode switches (realtime → minute or minute → realtime) are handled cleanly
 * by including `refreshMode` in the `useEffect` dependency array — React tears
 * down the previous effect (closing the EventSource or clearing the interval)
 * before starting the new one.
 *
 * ## Heartbeat note
 * The server emits a keepalive using `event: heartbeat` (not `event: message`).
 * The browser's EventSource API fires `onmessage` only for events whose type
 * field is "message" or absent. Heartbeat events therefore bypass `onmessage`
 * entirely and never reach the handler below — this is intentional. Heartbeats
 * keep the HTTP connection alive but should not trigger cache invalidation.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useRefreshMode } from '../providers/RefreshModeProvider.js';

/** Maximum consecutive SSE errors before a warning DOM event is dispatched. */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Custom DOM event name emitted when the SSE connection has failed repeatedly. */
const SSE_DEGRADED_EVENT = 'tokenomix:sse-degraded';

/** Shared helper — invalidates all four query keys used across dashboard panels. */
function invalidateAll(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  void queryClient.invalidateQueries({ queryKey: ['turns'] });
  void queryClient.invalidateQueries({ queryKey: ['session'] });
}

export function useServerEvents(): void {
  const queryClient = useQueryClient();
  const { refreshMode } = useRefreshMode();
  const consecutiveErrorsRef = useRef(0);

  useEffect(() => {
    if (refreshMode === 'minute') {
      // Minute-polling branch: no EventSource, no error counter.
      // Reset the consecutive error ref so the realtime branch starts clean
      // if the user later switches back.
      consecutiveErrorsRef.current = 0;

      const intervalId = setInterval(() => {
        invalidateAll(queryClient);
      }, 60_000);

      return () => {
        clearInterval(intervalId);
      };
    }

    // Realtime branch: EventSource-driven updates.
    const source = new EventSource('/api/events');

    source.onmessage = (event: MessageEvent) => {
      // Successful message resets the error counter.
      consecutiveErrorsRef.current = 0;

      try {
        const data = JSON.parse(String(event.data)) as unknown;
        if (
          data !== null &&
          typeof data === 'object' &&
          'type' in data &&
          (data as Record<string, unknown>).type === 'updated'
        ) {
          invalidateAll(queryClient);
        }
      } catch {
        // Malformed JSON — ignore silently
      }
    };

    source.onerror = () => {
      consecutiveErrorsRef.current += 1;

      if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
        // Dispatch a DOM event so the UI can optionally display a banner.
        // The event bubbles up from document so any listener can catch it.
        document.dispatchEvent(
          new CustomEvent(SSE_DEGRADED_EVENT, {
            detail: { consecutiveErrors: consecutiveErrorsRef.current },
          })
        );
      }
      // EventSource auto-reconnects after an error — no manual retry needed.
    };

    return () => {
      source.close();
    };
  }, [queryClient, refreshMode]);
}
