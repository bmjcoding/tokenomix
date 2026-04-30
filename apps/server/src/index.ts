/**
 * Hono API server entry point.
 *
 * Binds to 127.0.0.1 only (local-only tool — no network exposure).
 * PORT = Number(process.env.PORT_BASE ?? 3000) + 1  (default 3001)
 *
 * Startup sequence:
 *   1. Create IndexStore and run full JSONL scan.
 *   2. Register routes.
 *   3. Start chokidar watcher for live updates.
 *   4. Serve.
 */

import * as fs from 'node:fs';
import { serve } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { IndexStore, PROJECTS_DIR } from './index-store.js';
import { RescanScheduler } from './rescan-scheduler.js';
import { adminRoute } from './routes/admin.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { metricsRoute } from './routes/metrics.js';
import { recommendationsChatRoute } from './routes/recommendations-chat.js';
import { sessionsRoute } from './routes/sessions.js';
import { turnsRoute } from './routes/turns.js';
import { formatLocalIso } from './time.js';
import { startWatcher } from './watcher.js';

const PORT = Number(process.env.PORT_BASE ?? 3000) + 1;

/** Service name tag applied to all structured log entries. */
const SERVICE = 'tokenomix-server';

// ---------------------------------------------------------------------------
// Structured logger — emits NDJSON with required observability fields.
// Fields: level, service, timestamp, event, ...extra
// ---------------------------------------------------------------------------
function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const entry = JSON.stringify({
    level,
    service: SERVICE,
    timestamp: formatLocalIso(),
    event,
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${entry}\n`);
  } else {
    process.stdout.write(`${entry}\n`);
  }
}

// ---------------------------------------------------------------------------
// Custom HTTP logger middleware — strips query-string values to avoid logging
// user filesystem paths (the `project` param contains ~/.claude/... paths).
// Only logs: method, path (no query string), status, latency ms.
// ---------------------------------------------------------------------------
function httpLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    // Use URL pathname only — strip query string entirely.
    const pathname = new URL(c.req.url, 'http://localhost').pathname;
    logEvent('info', 'http', {
      method: c.req.method,
      path: pathname,
      status: c.res.status,
      ms,
    });
  };
}

async function main(): Promise<void> {
  const store = new IndexStore();

  // Full JSONL scan on startup.
  await store.initialize();

  // Collect file count for the startup log.
  let fileCount = 0;
  try {
    fileCount = await countJsonlFiles(PROJECTS_DIR);
  } catch {
    fileCount = 0;
  }

  const app = new Hono();

  // Use custom logger instead of hono/logger to avoid logging query-string values.
  app.use('*', httpLogger());

  // Start file watcher and rescan scheduler; both handles needed by shutdown().
  const watcher = startWatcher(store);
  const scheduler = new RescanScheduler(store, 60_000);
  scheduler.start();

  app.route('/api/metrics', metricsRoute(store));
  app.route('/api/sessions', sessionsRoute(store));
  app.route('/api/health', healthRoute(store, scheduler));
  app.route('/api/events', eventsRoute(store));
  app.route('/api/turns', turnsRoute(store));
  app.route('/api/recommendations/chat', recommendationsChatRoute(store));
  app.route('/api/admin', adminRoute(scheduler));

  // ---------------------------------------------------------------------------
  // Graceful shutdown: close watcher, drain SSE streams, force-exit at 5s.
  // ---------------------------------------------------------------------------
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logEvent('info', 'shutdown', { signal });

    // Emit a final SSE event so connected clients close their EventSource.
    store.emit('shutdown');

    // Force-exit after 5 seconds in case cleanup hangs.
    const forceTimer = setTimeout(() => {
      logEvent('warn', 'shutdown-timeout', {});
      process.exit(1);
    }, 5_000);
    // Allow the timer to be garbage-collected without blocking the event loop.
    if (forceTimer.unref) forceTimer.unref();

    // Stop the rescan scheduler before closing the watcher.
    scheduler.stop();

    // Close the chokidar watcher.
    watcher
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(0);
      });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
    // Structured startup log with all relevant context.
    logEvent('info', 'startup', {
      projectsDir: PROJECTS_DIR,
      fileCount,
      port: info.port,
      indexedRows: store.indexedRows,
    });
  });
}

/**
 * Count JSONL files under a directory for the startup log.
 * Returns 0 on any error (directory missing, permissions, etc.).
 */
async function countJsonlFiles(dir: string): Promise<number> {
  let count = 0;
  async function walk(current: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        count++;
      }
    }
  }
  await walk(dir);
  return count;
}

main().catch((err: unknown) => {
  logEvent('error', 'fatal', { error: String(err) });
  process.exit(1);
});
