/**
 * Hono API server entry point.
 *
 * Binds to 127.0.0.1 only (local-only tool — no network exposure).
 * PORT = PORT_BASE + 1  (default 3001; validated via env.ts at startup)
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
import { initServerEnv, validateEnv } from './env.js';
import { IndexStore, WATCHED_SOURCE_DIRS } from './index-store.js';
import { logEvent } from './logger.js';
import { RescanScheduler } from './rescan-scheduler.js';
import { adminRoute } from './routes/admin.js';
import { eventsRoute } from './routes/events.js';
import { healthRoute } from './routes/health.js';
import { metricsRoute } from './routes/metrics.js';
import { recommendationsChatRoute } from './routes/recommendations-chat.js';
import { sessionsRoute } from './routes/sessions.js';
import { turnsRoute } from './routes/turns.js';
import { startWatcher } from './watcher.js';

// ---------------------------------------------------------------------------
// Env validation — must run before any module that reads process.env.
// ---------------------------------------------------------------------------
const envResult = validateEnv();
if (!envResult.success) {
  // Format Zod field errors into a readable message before any logger is used.
  const issues = envResult.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  logEvent('error', 'env-validation-failed', {
    message: `Server startup aborted: invalid environment configuration.\n${issues}`,
    issues: envResult.error.issues,
  });
  process.stderr.write(`\nEnv validation errors:\n${issues}\n\n`);
  process.exit(1);
}
initServerEnv(envResult.env);

const PORT = envResult.env.PORT_BASE + 1;

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

  const app = new Hono();

  // Use custom logger instead of hono/logger to avoid logging query-string values.
  app.use('*', httpLogger());

  // Scheduler is constructed now (healthRoute needs the handle) but only
  // started once the initial scan completes — see runStartupScan().
  const scheduler = new RescanScheduler(store);
  // Watcher is created lazily after the initial scan; shutdown() must tolerate
  // it still being undefined if a signal arrives mid-scan.
  let watcher: ReturnType<typeof startWatcher> | undefined;

  // Readiness gate: until the initial index scan completes, data endpoints
  // return 503 so the UI shows a loading state instead of rendering partial
  // numbers. /api/events (SSE) and /api/health stay reachable so the client
  // can detect when the index becomes ready.
  app.use('/api/*', async (c, next) => {
    const pathname = new URL(c.req.url, 'http://localhost').pathname;
    if (
      store.isReady() ||
      pathname.startsWith('/api/events') ||
      pathname.startsWith('/api/health')
    ) {
      await next();
      return;
    }
    return c.json({ error: 'indexing', ready: false }, 503);
  });

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

    // Close the chokidar watcher (may not exist yet if shutdown races startup).
    if (!watcher) {
      process.exit(0);
      return;
    }
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

  // Bind the HTTP port immediately so the Vite dev proxy can connect right
  // away — the (multi-second) JSONL index scan then runs in the background.
  // This eliminates the ECONNREFUSED window during startup.
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
    logEvent('info', 'listening', { port: info.port });
    void runStartupScan(store, () => {
      watcher = startWatcher(store);
      scheduler.start();
    });
  });
}

/**
 * Run the full JSONL index scan in the background after the port is already
 * open. When it completes, start the watcher + scheduler and emit 'change' so
 * connected SSE clients refetch — the dashboard populates with no manual
 * refresh.
 */
async function runStartupScan(store: IndexStore, onReady: () => void): Promise<void> {
  const startedAt = Date.now();
  try {
    await store.initialize();
  } catch (err) {
    logEvent('error', 'startup-scan-failed', { error: String(err) });
    return;
  }

  // Start the watcher + rescan scheduler only now, so neither runs concurrently
  // with the initial scan.
  onReady();

  let fileCount = 0;
  try {
    fileCount = await countJsonlFilesFromDirs(WATCHED_SOURCE_DIRS);
  } catch {
    fileCount = 0;
  }

  // Notify connected SSE clients that the index is ready so panels refetch.
  store.emit('change');

  logEvent('info', 'startup', {
    sourceDirs: WATCHED_SOURCE_DIRS,
    fileCount,
    port: PORT,
    indexedRows: store.indexedRows,
    scanMs: Date.now() - startedAt,
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

async function countJsonlFilesFromDirs(dirs: readonly string[]): Promise<number> {
  const counts = await Promise.all(dirs.map((dir) => countJsonlFiles(dir)));
  return counts.reduce((sum, count) => sum + count, 0);
}

main().catch((err: unknown) => {
  logEvent('error', 'fatal', { error: String(err) });
  process.exit(1);
});
