/**
 * GET /api/events
 *
 * Server-Sent Events (SSE) endpoint.
 * Pushes { type: 'updated', ts: number } whenever the IndexStore emits 'change'.
 * Sends a heartbeat comment every 30 seconds to keep connections alive.
 *
 * Uses Hono's streamSSE helper.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { IndexStore } from '../index-store.js';

export function eventsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return streamSSE(c, async (stream) => {
      // Send initial connection confirmation.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected', ts: Date.now() }),
        event: 'message',
      });

      // Listen for store change events.
      const onchange = async (): Promise<void> => {
        try {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'updated', ts: Date.now() }),
            event: 'message',
          });
        } catch {
          // Client disconnected.
        }
      };

      store.on('change', onchange);

      // Heartbeat every 30 seconds.
      const heartbeatInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: '',
            event: 'heartbeat',
          });
        } catch {
          // Client disconnected.
        }
      }, 30_000);

      // Cleanup when the connection closes.
      stream.onAbort(() => {
        store.off('change', onchange);
        clearInterval(heartbeatInterval);
      });

      // Keep the stream open indefinitely.
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
    });
  });

  return app;
}
