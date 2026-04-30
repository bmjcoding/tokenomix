/**
 * chokidar file watcher for live JSONL updates.
 *
 * Watches ~/.claude/projects/**\/*.jsonl for add and change events.
 * Debounces 300ms before triggering a store rebuild to avoid partial reads
 * when Claude Code is actively writing session logs.
 *
 * awaitWriteFinish (stabilityThreshold: 250ms) provides additional protection
 * against partial reads during active writes.
 *
 * ## Polling vs FSEvents
 *
 * Polling is the DEFAULT on macOS because chokidar's FSEvents backend is
 * known to silently drop events after long process uptimes or when the watched
 * directory tree is modified by another process (e.g. Claude Code). Polling at
 * 1 000 ms adds negligible CPU overhead on the small ~/.claude/projects tree
 * and guarantees every write is detected within ~1 250 ms (1 s poll + 250 ms
 * stabilityThreshold).
 *
 * Set TOKENOMIX_WATCHER_FSEVENTS=1 to opt back in to FSEvents (not recommended
 * on macOS hosts that have been running for more than a few hours).
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { type IndexStore, PROJECTS_DIR } from './index-store.js';
import { logEvent } from './logger.js';

/**
 * Start the chokidar watcher and return the FSWatcher handle so the caller
 * (index.ts) can call `.close()` on graceful shutdown.
 */
export function startWatcher(store: IndexStore): FSWatcher {
  const pattern = `${PROJECTS_DIR}/**/*.jsonl`;

  // Polling is on by default; set TOKENOMIX_WATCHER_FSEVENTS=1 to use FSEvents instead.
  const usePolling = process.env.TOKENOMIX_WATCHER_FSEVENTS !== '1';

  logEvent('info', 'watcher-init', { usePolling, pattern });

  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true, // startup scan handled by store.initialize()
    persistent: true,
    // interval only takes effect when usePolling is true.
    usePolling,
    interval: 1_000,
    awaitWriteFinish: {
      // Lowered from 500 → 250 ms: reduces per-turn latency while still
      // guarding against in-progress writes. Polling interval is 100 ms so
      // the effective stability window is 250–350 ms.
      stabilityThreshold: 250,
      pollInterval: 100,
    },
  });

  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleIngest(eventName: string, filePath: string): void {
    // Log BEFORE the debounce so the raw FS event is always observable.
    logEvent('info', 'watcher-fs-event', { eventName, path: filePath });

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

  watcher.on('add', (filePath: string) => scheduleIngest('add', filePath));
  watcher.on('change', (filePath: string) => scheduleIngest('change', filePath));

  // Register error handler so watch-attach failures (inotify limit exhaustion,
  // PROJECTS_DIR missing) are observable rather than silently dropped.
  watcher.on('error', (err: unknown) => {
    logEvent('error', 'watcher-error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return watcher;
}
