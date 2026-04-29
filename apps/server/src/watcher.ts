/**
 * chokidar file watcher for live JSONL updates.
 *
 * Watches ~/.claude/projects/**\/*.jsonl for add and change events.
 * Debounces 300ms before triggering a store rebuild to avoid partial reads
 * when Claude Code is actively writing session logs.
 *
 * awaitWriteFinish (stabilityThreshold: 500ms) provides additional protection
 * against partial reads during active writes.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { type IndexStore, PROJECTS_DIR } from './index-store.js';
import { formatLocalIso } from './time.js';

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

/**
 * Start the chokidar watcher and return the FSWatcher handle so the caller
 * (index.ts) can call `.close()` on graceful shutdown.
 */
export function startWatcher(store: IndexStore): FSWatcher {
  const pattern = `${PROJECTS_DIR}/**/*.jsonl`;

  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true, // startup scan handled by store.initialize()
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleIngest(filePath: string): void {
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(filePath);
      // Log the debounced rebuild before triggering ingest.
      logEvent('info', 'change-debounced', { path: filePath });
      store.ingestFile(filePath).catch(() => {
        // Errors are swallowed inside ingestFile; this catch is belt-and-suspenders.
      });
    }, 300);

    pending.set(filePath, timer);
  }

  watcher.on('add', scheduleIngest);
  watcher.on('change', scheduleIngest);

  // Register error handler so watch-attach failures (inotify limit exhaustion,
  // PROJECTS_DIR missing) are observable rather than silently dropped.
  watcher.on('error', (err: unknown) => {
    logEvent('error', 'watcher-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return watcher;
}
