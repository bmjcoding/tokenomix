/**
 * RescanScheduler — periodic safety-net that complements the chokidar file watcher.
 *
 * Extracted from index-store.ts to keep that module focused on the aggregation engine.
 *
 * Every `intervalMs` milliseconds (default 5 000) it:
 *   1. Collects all *.jsonl paths under PROJECTS_DIR.
 *   2. Stats each path for its mtime.
 *   3. On the very first observation of a path, records the mtime without
 *      re-ingesting — chokidar and IndexStore.initialize() handled initial
 *      ingest; the scheduler must not duplicate that work.
 *   4. For paths already in the cache, calls store.ingestFile() when mtime
 *      has advanced (i.e. new content was written since last tick).
 *   5. Emits a structured log event only when at least one file changed, to
 *      avoid per-tick noise in steady-state.
 *   6. Emits a debug-level 'rescan-tick-noop' event when zero files changed
 *      (gated by TOKENOMIX_DEBUG=1 so it is silent in normal operation).
 *
 * ## Safety-net role
 *
 * With polling as the default watcher mode, this scheduler acts as a
 * last-resort backstop for polling gaps or process-startup races. The 5-second
 * default ensures the user never waits more than ~5 seconds for a missed
 * update even under the worst conditions (polling missed a write AND chokidar
 * was somehow busy). The mtime-based scan is cheap (O(n) stat calls on the
 * small ~/.claude/projects tree).
 *
 * The interval timer is unref()'d so a quiet scheduler does not prevent a
 * clean process exit if the application shuts down normally.
 */

import { stat as statFn } from 'node:fs/promises';
import { collectJsonlFiles, type IndexStore, PROJECTS_DIR } from './index-store.js';
import { logEvent } from './logger.js';

/**
 * Options accepted by RescanScheduler constructor (exported for index.ts
 * and test consumers that need a named type).
 */
export type RescanSchedulerOptions = {
  store: IndexStore;
  intervalMs?: number;
  /** Override the directory scanned by tick(). Defaults to PROJECTS_DIR. Primarily useful for tests. */
  dir?: string;
};

/**
 * Periodic safety-net that complements the chokidar file watcher.
 *
 * Every `intervalMs` milliseconds (default 5 000) it:
 *   1. Collects all *.jsonl paths under PROJECTS_DIR.
 *   2. Stats each path for its mtime.
 *   3. On the very first observation of a path, records the mtime without
 *      re-ingesting — chokidar and IndexStore.initialize() handled initial
 *      ingest; the scheduler must not duplicate that work.
 *   4. For paths already in the cache, calls store.ingestFile() when mtime
 *      has advanced (i.e. new content was written since last tick).
 *   5. Emits a structured log event only when at least one file changed, to
 *      avoid per-tick noise in steady-state.
 *
 * The interval timer is unref()'d so a quiet scheduler does not prevent a
 * clean process exit if the application shuts down normally.
 */
export class RescanScheduler {
  private readonly store: IndexStore;
  private readonly intervalMs: number;
  private readonly dir: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-file last-seen mtime in epoch ms. Populated lazily on first tick. */
  private readonly fileMtimes = new Map<string, number>();
  /** Re-entrancy guard: true while a tick() execution is in progress. */
  private _tickRunning = false;
  /** Epoch ms of the last fully-completed successful tick. 0 before the first successful tick. */
  private _lastRescanTs: number = 0;

  constructor(store: IndexStore, intervalMs: number = 5_000, dir: string = PROJECTS_DIR) {
    this.store = store;
    this.intervalMs = intervalMs;
    this.dir = dir;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // unref() lets the process exit normally even if the interval is still
    // pending — the scheduler is a background safety net, not a foreground task.
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    logEvent('info', 'rescan-scheduler-started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Epoch ms of the last fully-completed successful tick. Returns 0 before the first successful tick. */
  get lastRescanTs(): number {
    return this._lastRescanTs;
  }

  public async tick(): Promise<void> {
    // Re-entrancy guard: if a previous tick is still running (e.g. a large
    // ingestFile call blocked through an interval boundary), skip this tick
    // rather than letting two scans race over the same mtime cache.
    if (this._tickRunning) {
      logEvent('warn', 'rescan-tick-skipped', { reason: 'previous tick still running' });
      return;
    }
    this._tickRunning = true;
    try {
      let files: string[];
      try {
        files = await collectJsonlFiles(this.dir);
      } catch (err) {
        // PROJECTS_DIR removed or permission denied — log and return cleanly.
        // The next scheduled tick will retry.
        logEvent('warn', 'rescan-tick-error', {
          phase: 'collect',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      let changed = 0;

      for (const filePath of files) {
        try {
          const { mtimeMs } = await statFn(filePath);
          const known = this.fileMtimes.get(filePath);

          if (known === undefined) {
            // First observation: seed the cache. Ingest is intentionally skipped
            // because chokidar 'add' and IndexStore.initialize() already handled
            // the initial load. Re-ingesting here would produce duplicate rows.
            this.fileMtimes.set(filePath, mtimeMs);
          } else if (mtimeMs > known) {
            // File was modified since the last tick — ingest the new content.
            this.fileMtimes.set(filePath, mtimeMs);
            await this.store.ingestFile(filePath);
            changed++;
          }
        } catch {
          // File was deleted between the directory scan and the stat call.
          // Silently skip — the next tick will simply not find it in the listing.
        }
      }

      if (changed > 0) {
        logEvent('info', 'rescan-tick', { changed, total: files.length });
      } else {
        logEvent('debug', 'rescan-tick-noop', { total: files.length });
      }

      // Mark the successful completion of this tick so health endpoints can
      // report scheduler liveness. Set once per tick at the end of the
      // successful path; ticks that error out early (rescan-tick-error) do not
      // update this value.
      this._lastRescanTs = Date.now();
    } finally {
      this._tickRunning = false;
    }
  }
}
