# 0006 — Pre-rollout two-pass audit

Date: 2026-04-30

## Status

Accepted

## Context

Before widening tokenomix to a small team of internal users, a two-pass audit
was conducted on the `apps/server`, `apps/web`, and `packages/shared`
workspaces. The goal was to close every known correctness bug, performance
regression, and security gap without touching the full `index-store.ts`
extraction (CLAUD-002), CI/CD setup, or Docker packaging, which were deferred
as out of scope for a single-user local tool at this scale.

**Pass 1** addressed dead-code removal, startup reliability (env-var
validation), bounded memory growth, SSE accuracy, accessibility regressions,
ECharts bundle size, chatbot multi-turn memory, reveal endpoint error
propagation, and logging consolidation.

**Pass 2** deepened correctness: chatbot subprocess cost-inflation, pricing-audit
row-set alignment, context-cache savings accuracy, `sessionTimes` cap behaviour
under active workloads, and frontend data-precision unification. It also added
an `ErrorBoundary` component, a Cancel button on streaming responses, and UX
polish for empty/error panel states.

Several architectural decisions made during the audit had non-obvious tradeoffs
that would be hard to reconstruct from diff history alone. This ADR records
those decisions.

## Decision

### 1. Chatbot subprocess cwd isolation

The Claude Code subprocess spawned for recommendation chat now runs in
`os.tmpdir()/tokenomix-chat-<pid>` with `mode: 0o700` rather than inheriting
`process.cwd()`. The root cause was that Claude Code, when run from the
tokenomix server's working directory, created session JSONL files under
`~/.claude/projects/`, which the watcher then ingested and counted as user
spend. The fix is to give each server process a hermetic temporary working
directory that falls outside the watched path. The directory is created once
at server start and reused for all chat turns in that process lifetime.

Alternative considered: filter tokenomix-originated sessions in the watcher's
path filter using a known prefix. Rejected because the prefix approach requires
knowing the full resolved path at filter time and would silently fail if the
server's working directory changed.

### 2. IndexStore eviction strategies

Five `Map` structures in `IndexStore` require bounded growth and each uses a
different eviction strategy appropriate to its access semantics:

- `sessionTimes` and `sessionInitialPrompts` evict by `firstTs` ascending so
  the oldest sessions are dropped first, preserving recently-active sessions
  during eviction pressure. `sessionIndex` is cascade-evicted when its
  corresponding `sessionTimes` entry is dropped.
- `fileIngestionAudits`, `requestedModelByAgentId`, and
  `subagentFilePathsByAgentId` use insertion-order eviction because no
  timestamp is available at insertion time and re-observation re-creates the
  entry at negligible cost.

A shared eviction abstraction was considered but rejected for Pass 1: the two
strategies differ enough that a single helper would require a strategy argument,
and the call sites are already clearly commented. Full refactoring is deferred
to the CLAUD-002 `index-store.ts` extraction.

`MAX_SESSION_TIMES` was raised from 50 000 to 200 000. The previous cap was
causing eviction of sessions still within the active-window query window on
heavy workloads, producing empty results from `GET /api/sessions/active`.
Active-window eviction skipping is added as a guard: sessions whose `lastTs`
falls within the last 24 hours are not candidates for eviction, regardless of
whether the map has reached its cap.

### 3. Currency precision unification via formatCurrency

Three separate display paths were formatting cost values independently:
`AreaChart` (used `toFixed(2)`), `FullReportPage` (had an inline `formatCost`
closure), and the rest of the dashboard (used `formatCurrency` from
`lib/formatters.ts`). Sub-cent values such as `$0.0032` were silently truncated
to `$0.00` in the chart tooltip and the report, making the UI contradict itself.

The decision to route all three paths through `formatCurrency` was prioritised
over a looser "fix the chart" approach because inconsistent precision across
panels is a correctness issue for the audit's stated goal (data trustworthiness).
`formatCurrency` already handles sub-cent display and is the single place to
update if the precision policy changes.

### 4. ErrorBoundary placement

`ErrorBoundary` wraps the router root in `main.tsx` so any unhandled render
exception in any panel shows a recovery UI instead of a blank screen. A
per-panel boundary was considered but rejected: per-panel wrapping adds
boilerplate at every future panel definition site and the recovery action
(page reload) is the same in both cases. A single top-level boundary provides
the resilience guarantee with minimal ongoing maintenance cost.

### 5. Zod env-var validation at startup

`apps/server/src/env.ts` validates all 13 `TOKENOMIX_*` and `PORT_BASE` env
vars at server startup using a Zod schema. On failure, the server logs a
structured error and exits with code 1. Direct `process.env` reads have been
migrated to `serverEnv()` calls in the routes and watcher; `logger.ts` retains
a direct read to avoid a circular import that would occur if `logger.ts`
imported from `env.ts`.

Complete migration of every remaining `process.env` read (notably within
`index-store.ts` itself) is a Pass 2 deferred item, not because it is unsafe
but because the blast radius of that change warranted a separate review cycle.

### 6. ECharts tree-shaking via lib/core

All four ECharts chart components now pass a pre-configured `echarts` instance
via the `echarts` prop to `EChartsReactCore`, imported from
`echarts-for-react/lib/core`. The alternative — using the default
`echarts-for-react` export — silently pulls the full ECharts bundle regardless
of which chart types are actually used. The pre-configured instance in
`apps/web/src/lib/echarts.ts` registers exactly the components the project
uses: `LineChart`, `BarChart`, `PieChart`, `GridComponent`, `TooltipComponent`,
`LegendComponent`, `TitleComponent`, and `CanvasRenderer`.

## Consequences

**Easier after this audit:**

- Misconfigured deployments fail fast with a clear error at startup rather than
  silently misbehaving at runtime.
- The recommendation chatbot accumulates context across turns and can be
  cancelled mid-stream; its cost no longer self-inflates the dashboard figures.
- Currency values are consistently displayed at sub-cent precision across all
  panels and the full report.
- `getSessionDetail()` scales to large session sets without a full store scan.
- Panel render errors show a recovery UI rather than a blank screen.

**Still deferred (confirmed out of scope for single-user local rollout):**

- Full `index-store.ts` god-module extraction (CLAUD-002, tracked in ADR 0005).
- CI/CD pipeline, Docker packaging, Prometheus metrics, and request-ID
  correlation tracing.
- Biome `noUnusedVariables` escalation from warning to error.
- Lockfile pinning enforcement in CI.
- DST one-hour edge case in daily bucket alignment (accepted; documented
  inline in `index-store.ts`).

## References

- `apps/server/src/env.ts` — Zod env-var schema
- `apps/server/src/index-store.ts` — eviction strategies and session-keyed index
- `apps/server/src/routes/recommendations-chat.ts` — subprocess cwd isolation
- `apps/web/src/components/ErrorBoundary.tsx` — top-level error boundary
- `apps/web/src/lib/echarts.ts` — pre-configured ECharts instance
- `apps/web/src/lib/formatters.ts` — `formatCurrency` shared helper
- ADR 0005 (`docs/adr/0005-periodic-mtime-rescan-as-fsevents-safety-net.md`) —
  watcher safety-net that the ingest no-op guard complements
