# 0004 — Actionable Dashboard Redesign

Date: 2026-04-28

## Status

Accepted

## Context

User feedback identified three categories of vanity metrics on the Overview
dashboard that provided no actionable lever:

- **Cache Efficiency KPI card** — displayed 96.1% hit rate. Cache behaviour is
  controlled by Claude Code's internal policy, not by the user. A saturated
  signal with no agency attached is noise, not insight.
- **Tool Error Rate aggregate** — displayed `0.0%` when no JSONL tool events
  were present. The degenerate zero state was indistinguishable from genuine
  zero-error operation and therefore untrustworthy.
- **ToolsBreakdownPanel empty state** — rendered a "No tool activity yet."
  placeholder that occupied grid space even when the panel had no content,
  distorting the page layout.

Screenshots shared by the user showed the Key Metrics row and KpiRow2 Tool
Error Rate card in these degenerate states.

The project already exposes `costUsd30d`, `weeklySeries[]`, `dailySeries[]`,
`byTool[]`, `bySubagent[]`, `byProject[]`, and
`monthlyRollup.current.sessionDuration` on the `MetricSummary` contract.
The missing signals — per-turn cost percentiles and prev-30d token and cost
windows — required six new server-computed fields.

A fourth vanity signal was the **Avg Session Duration** card in `KpiRow`.
Median session duration is roughly stable per user across days; it tells the
user nothing about what to change. A P90 duration is a different kind of
signal: sessions running long are outliers that may indicate scope creep,
context bloat, or a runaway agent loop — all actionable. Relocating the
duration signal from `KpiRow` (which is now strictly cost-focused) to the new
`OptimizationSignalsPanel` (workflow-effectiveness signals) also avoids mixing
non-cost signals into the cost row. The mean is still surfaced as a context
line on the P90 card (`P50: N min`) so the user retains a reference for typical
session length.

## Decision

### MetricSummary: six new fields

Add to `packages/shared/src/types.ts` and compute in
`apps/server/src/index-store.ts`:

| Field | Window | Units | Zero state |
|---|---|---|---|
| `turnCostP50_30d` | last 30 days | USD per turn | 0 |
| `turnCostP90_30d` | last 30 days | USD per turn | 0 |
| `turnCostP99_30d` | last 30 days | USD per turn | 0 |
| `inputTokensPrev30d` | days 31–60 | tokens | 0 |
| `outputTokensPrev30d` | days 31–60 | tokens | 0 |
| `costUsd30dPrev` | days 31–60 | USD | 0 |

`costPerOutputTokenPrev30d` is NOT a server field; the frontend derives it
as `costUsd30dPrev / outputTokensPrev30d`.

### KpiRow: four actionable cards

Replace all existing `KpiRow` cards with:

1. **TOKENS · 30D** — `inputTokens30d + outputTokens30d`; delta vs
   `inputTokensPrev30d + outputTokensPrev30d`; sparkline from `dailyTokens[]`.
2. **COST / OUTPUT TOKEN (30D)** — `costUsd30d / outputTokens30d` in
   micro-dollar format; delta vs `costUsd30dPrev / outputTokensPrev30d`;
   sparkline from `dailySeries[]` cost/output-token ratio per day.
3. **TURN P90 COST (30D)** — `formatCurrency(turnCostP90_30d)`; context line
   shows P50 value; no delta (no prev-period percentile).
4. **COST WoW DELTA** — `pctDelta` of the last two complete weeks in
   `weeklySeries[]`; context shows absolute last-week cost; derived entirely
   on the frontend, no new server field required.

The Cache Efficiency and Avg Session Duration cards are removed.

### KpiRow2: conditional worst-tool error slot

Replace the Tool Error Rate aggregate card with a conditional third slot:

- Rendered only when `byTool[]` is non-empty **and** at least one
  `ToolBucket.errorRate > 0`.
- Shows the tool with the highest `errorRate` as the headline (e.g. `Bash: 12.5%`);
  context line shows the total error count for that tool.
- When the condition is false the slot is absent; the Section `cols` prop
  reflows to 2, preserving grid alignment.

### ToolsBreakdownPanel: null render when empty

When `byTool.length === 0`, the panel returns `null` rather than a placeholder
string. The CSS grid in `OverviewPage` auto-reflows around the absent node.

### New section: Optimization Signals

A new `OptimizationSignalsPanel` is inserted between `KpiRow2` and
`AreaChartPanel` in `OverviewPage`. It renders up to three cards from existing
`MetricSummary` fields:

1. **P90 SESSION DURATION** — `monthlyRollup.current.sessionDuration.p90Minutes`;
   always shown; context line shows the P50 value.
2. **SUBAGENT SUCCESS RATE** — weighted by `dispatches` across `bySubagent[]`;
   shown only when `bySubagent.length > 0`.
3. **TOP EXPENSIVE PROJECT** — top entry of `byProject[]` sorted by `costUsd`;
   shown only when `byProject.length > 0`; context line shows share of
   `costUsd30d`.

## Consequences

**For users**

- Every visible card now corresponds to an optimization opportunity the user
  can act on (reduce high-cost turns, shift expensive projects, investigate
  the worst-failing tool).
- Cards that have nothing to show are absent rather than displaying zero or
  a placeholder, removing visual noise.
- The Cost WoW delta gives an at-a-glance trend without requiring the user
  to compare numbers across the weekly table.

**For developers**

- The server contract surface is smaller than the original "with cache" plan:
  six new `MetricSummary` fields instead of the cache-hit-rate and per-project
  cache columns that were scoped out.
- `MetricSummary` carries no cache fields; adding them later would require a
  new ADR because the decision to drop them is deliberate (see "Explicitly not
  done" below).
- The frontend derives `costPerOutputToken` and `costWoWDelta` locally from
  existing fields, keeping the server aggregate function focused on
  pre-aggregated primitives.
- `ingestFileInternal()`, `/api/sessions`, `/api/turns`, `/api/health`, and
  `/api/events` are unchanged. No new routes were added.

**Explicitly not done**

- **Cache surfaces** — cache hit rate is 96%+ saturated; the user has no lever
  to improve it; dropping it is a deliberate product decision, not an
  omission. Tracked in `scope-confirmed.md`.
- **Drill-down modals** — no modal primitive exists; deferred to a future
  session.
- **Tokens-per-tool-call efficiency** — a second-order metric; deferred.
- **Model-mix WoW shift** — deferred.
- **File-touch surfaces** — governed by the ADR 0002 privacy gate; out of
  scope until that policy is revisited.
- **Active-projects-last-7d context** on PROJECTS TOUCHED — would require a
  second `useQuery` call or a new server field, breaking the single-fetch
  architecture; deferred.

## References

- `packages/shared/src/types.ts` — `MetricSummary` interface
- `apps/server/src/index-store.ts` — `aggregate()` implementation
- `apps/web/src/panels/KpiRow.tsx`, `KpiRow2.tsx`, `OptimizationSignalsPanel.tsx`
- ADR 0002 (`docs/adr/0002-tool-event-ingestion-and-files-touched-policy.md`) —
  privacy gate that excludes file-touch surfaces from this redesign
- ADR 0003 (`docs/adr/0003-two-pass-jsonl-ingest.md`) — two-pass ingest that
  populated `byTool[]` correctly, unblocking worst-tool error display
- `.orchestrator/sessions/20260428T130340/context/scope-confirmed.md` —
  canonical scope document and cache-drop rationale
