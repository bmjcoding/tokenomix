# 0001 — Use an interactive TypeScript dashboard

Date: 2026-04-27
Updated: 2026-04-29

## Status

Accepted

## Context

Tokenomix needs a local, single-user dashboard for Claude Code token usage. The
dashboard must read JSONL data from `~/.claude/projects`, price usage locally,
show live updates as files change, and avoid external telemetry.

The first implementation included Python CLI scripts and a generated static
HTML report. That surface has been retired. The maintained implementation is now
the TypeScript dashboard and Hono API.

## Decision

Maintain tokenomix as a pnpm monorepo with three packages:

- `apps/server` — Hono on Node 22: JSONL parser, in-memory aggregation,
  chokidar live-watch, REST/SSE routes, and startup readiness checks. Binds to
  `127.0.0.1` only.
- `apps/web` — Vite 8 + React 19 + TanStack Router/Query + Apache ECharts 6.
  Tailwind CSS 4 provides styling through the CSS-native theme layer.
- `packages/shared` — Zod 4 schemas, shared TypeScript types, and the pricing
  module used by both server code and tests.

Apache ECharts is used for chart types that need richer primitives, including
day-of-week by hour heatmaps. Vite + Hono remains lighter than a full-stack SSR
framework for this localhost-only tool.

## Consequences

**Positive**

- Single maintained implementation surface.
- Interactive UX: time-range toggles, live SSE updates on file changes,
  heatmaps, sortable sessions, and top expensive turns.
- Type-safe end-to-end contracts through shared Zod schemas and TypeScript
  types.
- Single-command development through the pnpm workspace.

**Negative**

- The project depends on a Node/pnpm toolchain instead of the standard Python
  runtime.
- Static `file://` dashboard generation is no longer supported.
- The server currently has a fixed data source of `~/.claude/projects`.

## Alternatives Considered

- **Keep the Python/static HTML implementation**: rejected because it duplicated
  pricing, parsing, and dashboard behavior without supporting the interactive
  workflows now expected from the app.
- **Next.js instead of Vite + Hono**: rejected as heavier than needed for a
  local-only app with no SSR requirement.
- **Recharts instead of ECharts**: rejected because the heatmap requirement has
  better first-class support in ECharts.
