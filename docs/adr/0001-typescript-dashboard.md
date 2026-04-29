# 0001 — Add interactive TypeScript dashboard alongside Python tooling

Date: 2026-04-27

## Status

Accepted

## Context

`bin/usage-dashboard.py` produces a static, self-contained HTML file from the
JSONL data under `~/.claude/projects/`. It is useful but not interactive:
time-range toggles, live updates on file changes, and chart types such as
day-of-week heatmaps are impractical in a static-HTML model.

The requirement was an interactive web dashboard for local AI token usage
visualization. Cost figures must be identical to the Python tooling (the
pricing logic is the correctness-critical source of truth). The app is
single-user, local-only, and must have no external telemetry.

## Decision

Build a pnpm monorepo with three packages:

- `apps/server` — Hono on Node 22: JSONL parser, in-memory aggregation,
  chokidar live-watch, 4 REST/SSE routes. Binds `127.0.0.1` only.
- `apps/web` — Vite 6 + React 18 + TanStack Router/Query + Apache ECharts 5.
  Tailwind v4 with a CSS-native `@theme` block (no config file).
- `packages/shared` — Zod schemas, shared types, pricing module ported
  exactly from `bin/claude-usage.py` with locked-in test values.

Design language: primary blue OKLCH palette matching the existing Python
dashboard (`oklch(0.49 0.16 255)` light / `oklch(0.58 0.12 255)` dark),
monochromatic gray scale.

Apache ECharts was chosen over Recharts because the heatmap requirement
(day-of-week × hour-of-day) has no Recharts primitive.

Tailwind v4 CSS-native `@theme` was chosen over v3 + config because it
removes the build-time config file and keeps design tokens in a single CSS
layer, consistent with the existing dashboard design language.

The server binds `127.0.0.1` and has no authentication because the app is
single-user and never exposed beyond localhost.

## Consequences

**Positive**

- Cost figures are identical to the Python tooling: the pricing module is
  ported exactly and covered by locked-in Vitest assertions.
- Interactive UX: time-range toggles, live SSE updates on file changes,
  heatmap, sortable sessions table.
- Type-safe end-to-end: shared Zod schemas validate the boundary between
  server and client at runtime and compile time.
- Single-command dev experience (`pnpm dev`).

**Negative**

- Project size grew from 4 Python files to roughly 60 TypeScript files plus
  a substantial `node_modules` tree.
- ECharts adds approximately 1057 KB pre-tree-shake (deferred optimization).
- Two parallel implementations to maintain: Python CLI + HTML, and the TS
  dashboard. Mitigation: the pricing module is the only correctness-critical
  shared logic. Both implementations read JSONL directly from
  `~/.claude/projects/` and share no runtime state.

## Alternatives considered

- **Extend `usage-dashboard.py` with htmx**: rejected — not sufficiently
  interactive for real-time updates and heatmap charts; design language
  harder to evolve beyond static CSS.
- **Remove Python tooling and go all-TypeScript**: rejected — the Python CLI
  scripts are proven and useful independently of a browser.
- **Next.js instead of Vite + Hono**: rejected — too heavy for a
  single-user local app with no SSR requirement.

## References

- `bin/claude-usage.py` — cost calculation source of truth
- Session 20260427T133302 implementation retro
