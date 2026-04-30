# 0005 — Periodic mtime-based rescan as FSEvents safety-net

Date: 2026-04-30

## Status

Accepted

## Context

The chokidar file watcher uses native FSEvents on macOS. Under sustained
uptime (observed at 24+ hours), the OS-level FSEvents queue can overflow
silently. When that happens, chokidar stops delivering change notifications
to `IndexStore`, new JSONL lines go undetected, and the dashboard's daily
metrics series stalls without any error signal.

A pure polling fallback (`TOKENOMIX_WATCHER_POLLING=1`) is opt-in and
addresses the symptom for users who know to set it, but it does not help
the default case where the overflow occurs only after many hours and the
operator has not yet observed a stall.

The project already reads every JSONL file at startup via
`collectJsonlFiles()`, and `IndexStore.ingestFile()` is idempotent for
unchanged content. A periodic stat-and-compare loop therefore adds
bounded recovery with low implementation cost and no risk of data
duplication.

## Decision

Add a `RescanScheduler` class co-located in `apps/server/src/index-store.ts`.
The scheduler maintains a per-file mtime cache and, on each 60-second tick,
stats every JSONL file, compares mtimes, and calls `ingestFile()` only for
files whose mtime has advanced. The first tick populates the cache without
ingesting, so chokidar remains the primary delivery mechanism and the
scheduler acts only as a safety net.

The class is co-located in `index-store.ts` rather than extracted to a
dedicated module because it requires direct access to the (non-circular)
`collectJsonlFiles` export within the same module. Extraction to a dedicated
module is a planned follow-up tracked as CLAUD-002.

A re-entrancy guard (`_tickRunning`) prevents a slow ingest cycle from
producing overlapping ticks. The interval timer is `unref()`-ed so it does
not block graceful shutdown. `scheduler.stop()` is called before
`watcher.close()` in the shutdown sequence.

An operator-facing `POST /api/admin/rescan` endpoint exposes `tick()` for
zero-restart manual rescans, and `GET /api/health` surfaces `lastRescanTs`
so operators can verify scheduler liveness without tailing logs.

## Consequences

**Easier:**

- Dashboard metrics recover within 60 seconds of an FSEvents overflow,
  without operator intervention or server restart.
- Operators can confirm the scheduler is running by inspecting
  `GET /api/health` rather than grepping logs.
- The `POST /api/admin/rescan` endpoint provides a deterministic manual
  trigger for support and debugging workflows.

**Harder / deferred:**

- The 3070-line `index-store.ts` module grows further until CLAUD-002
  (extraction to a dedicated module) is addressed.
- Zero-change ticks produce no log output, making 24-hour scheduler silence
  indistinguishable from a hung scheduler without external monitoring
  (tracked as SRE-heartbeat; a debug-level heartbeat log is a planned
  follow-up).
- `POST /api/admin/rescan` has no CSRF token or shared-secret header.
  Accepted as-is given the `127.0.0.1`-only binding and idempotent
  operation, but a shared-secret header would add defence-in-depth.

## References

- `apps/server/src/index-store.ts` — `RescanScheduler` class and exported
  `collectJsonlFiles()`
- `apps/server/src/routes/admin.ts` — `POST /api/admin/rescan` route module
- `apps/server/src/routes/health.ts` — `lastRescanTs` field in health response
- `apps/server/src/tests/rescan-scheduler.test.ts` — scheduler unit tests
- ADR 0003 (`docs/adr/0003-two-pass-jsonl-ingest.md`) — ingest architecture
  that `RescanScheduler` builds on
