/**
 * useServerEvents — subscribes to the /api/events SSE stream.
 *
 * On each `{type:'updated'}` message, invalidates the 'metrics' and 'sessions'
 * TanStack Query cache keys so all panels refresh automatically.
 *
 * Lifecycle: the EventSource is created on mount and closed on unmount.
 * No external dependencies beyond browser EventSource API and TanStack Query.
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

/** Maximum consecutive SSE errors before a warning DOM event is dispatched. */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Custom DOM event name emitted when the SSE connection has failed repeatedly. */
const SSE_DEGRADED_EVENT = 'tokenomix:sse-degraded';

export function useServerEvents(): void {
  const queryClient = useQueryClient();
  const consecutiveErrorsRef = useRef(0);

  useEffect(() => {
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
          void queryClient.invalidateQueries({ queryKey: ['metrics'] });
          void queryClient.invalidateQueries({ queryKey: ['sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['turns'] });
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
  }, [queryClient]);
}
