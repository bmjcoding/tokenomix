/**
 * GET /api/events
 *
 * Server-Sent Events (SSE) endpoint.
 * Pushes { type: 'updated', ts: number } whenever the IndexStore emits 'change'.
 * Sends a heartbeat comment every 30 seconds to keep connections alive.
 *
 * Uses Hono's streamSSE helper.
 *
 * ## Anti-buffering headers
 *
 * Hono's streamSSE already sets Content-Type: text/event-stream and
 * Cache-Control: no-cache. We augment with:
 *   - X-Accel-Buffering: no   — disables nginx/Vite-proxy response buffering
 *   - Content-Encoding: identity — prevents any proxy from applying
 *     compression that would delay chunk flushing
 *
 * These are appended BEFORE streamSSE writes the first byte so they are
 * present in the response header frame.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { IndexStore } from '../index-store.js';
import { logEvent } from '../logger.js';

export function eventsRoute(store: IndexStore): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    // Disable proxy/CDN buffering so SSE frames are flushed immediately.
    // Hono's streamSSE will set Content-Type and Cache-Control; we add the
    // buffering-suppression headers that Hono does not set by default.
    c.header('X-Accel-Buffering', 'no');
    c.header('Content-Encoding', 'identity');

    return streamSSE(c, async (stream) => {
      // Send initial connection confirmation.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected', ts: Date.now() }),
        event: 'message',
      });

      // Listen for store change events.
      const onchange = async (): Promise<void> => {
        try {
          const ts = Date.now();
          logEvent('info', 'sse-emit', { type: 'updated', ts });
          await stream.writeSSE({
            data: JSON.stringify({ type: 'updated', ts }),
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
