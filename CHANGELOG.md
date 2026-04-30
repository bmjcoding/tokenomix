# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.7.1] - 2026-04-30

### Changed

- Spend-over-time field toggle (Cost / Input / Output) now uses the same segmented-pill structure as the period switcher (24HR / 7D / 30D / YTD), unifying the two adjacent controls visually. (`apps/web/src/panels/AreaChartPanel.tsx`, `apps/web/src/panels/PeriodSwitcher.tsx`)
- Both segmented toggles now render `|` divider separators between adjacent inactive segments; the divider adjacent to the active pill is suppressed so the active state remains visually prominent. (`apps/web/src/panels/AreaChartPanel.tsx`, `apps/web/src/panels/PeriodSwitcher.tsx`)

## [3.7.0] - 2026-04-30

### Added

- Recommendation chat now displays an elapsed-seconds counter while waiting for the first response token (e.g., "Thinking… 12s") so the ~30 s Claude Code spawn and first-API-call latency feels accountable instead of frozen. The counter starts when the server emits its `start` SSE event, increments every second, and clears the moment the first delta arrives, the stream completes, the request errors or aborts, or the panel unmounts. Uses `aria-live="polite"` and `tabular-nums` for accessible, layout-stable updates. (`apps/web/src/panels/RecommendationChatPanel.tsx`)

### Fixed

- Ask AI popout now renders correctly in light mode: chat window, message list, markdown prose, and send button all use proper light/dark token pairs instead of hardcoded dark-only values; send button background and text are visible on a white surface.
- Spend-over-time chart: increased `grid.left` so the first x-axis date tick no longer collides with y-axis labels.
- Donut card legend pills (model mix and tools breakdown) are now horizontally centered via `justify-center` on the legend list.
- Removed the redundant "Listed impact $X.XX" summary Badge row that appeared above the Optimization Opportunities table headers.

### Changed

- Period switcher (24HR / 7D / 30D / YTD) is now a single segmented-pill control using design tokens (`bg-primary` / `bg-primary-light`) for the active segment, replacing four separate Button instances.
- Period label renamed from "24Hr" to "24HR" for consistent capitalisation.
- Raised the default chat budget cap (`TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD`) from `0.05` to `0.15` so typical first-turn answers no longer trip the "Claude Code reached the configured chat budget cap" warning. Existing env-var override behaviour is unchanged. (`apps/server/src/routes/recommendations-chat.ts`, `README.md`)

## [3.6.0] - 2026-04-30

### Added

- `FlipNumber` component (`apps/web/src/ui/FlipNumber.tsx`) — wraps `@number-flow/react@0.6.0` to provide animated digit transitions on numeric values. Used by the hero card to flip-count the Current Spend (MTD) currency value and the Tokens · MTD integer display whenever new SSE-driven metrics arrive. Honors `prefers-reduced-motion: reduce` (instant updates instead of animation) via `respectMotionPreference={true}`.
- New runtime dependency: `@number-flow/react@0.6.0` (~10 KB gzipped, exact-pinned per project policy).

## [3.5.0] - 2026-04-30

### Added

- `RescanScheduler` in `apps/server/src/index-store.ts` — periodic 60-second
  mtime-based rescan that re-ingests JSONL files whose modification time has
  advanced since the last tick. Compensates for chokidar FSEvents queue
  overflow observed on long-uptime macOS hosts (worst-case recovery window:
  60 s). Includes a re-entrancy guard and structured error handling so a slow
  ingest cycle cannot produce overlapping ticks or unhandled rejections.
- `TOKENOMIX_WATCHER_POLLING=1` environment variable — when set, the chokidar
  watcher switches to polling mode (1 s interval) instead of native FSEvents.
  Useful on network mounts or virtual machines where FSEvents is unreliable.
- `POST /api/admin/rescan` endpoint — triggers a full mtime-based rescan of
  all JSONL files immediately, without restarting the server. Returns
  `{ ok: true, ts: <epoch-ms> }`. Mounted at `/api/admin` alongside existing
  routes; no authentication beyond the existing `127.0.0.1`-only binding.
- `lastRescanTs` field on `GET /api/health` response — ISO 8601 local-time
  string of the most recent completed scheduler tick, or `null` before the
  first successful tick. Enables operators to verify scheduler liveness
  without tailing logs.
- `apps/server/src/routes/admin.ts` — new route module exporting the
  `adminRoute` factory consumed by `index.ts`.
- 12 new Vitest tests in `apps/server/src/tests/rescan-scheduler.test.ts`
  covering first-tick cataloguing, unchanged-mtime no-ingest, mtime-advanced
  ingest, `stop()` cancellation, and `lastRescanTs` getter lifecycle.
- `TOKENOMIX_DEBUG=1` environment variable — when set, the structured logger
  emits debug-level entries to stdout; off by default. `RescanScheduler` uses
  it to emit a `rescan-tick-noop` heartbeat each cycle so operators can
  distinguish a healthy idle scheduler from a hung one without adding
  steady-state noise.

### Changed

- `collectJsonlFiles()` in `index-store.ts` is now exported, enabling direct
  use by `RescanScheduler` and by the new test suite.
- `GET /api/health` response shape extended with `lastRescanTs: string | null`.
- `fetchHealth()` type in `apps/web/src/lib/api.ts` updated to include
  `lastRescanTs: string | null`.
- `RescanScheduler` extracted from `apps/server/src/index-store.ts` to its
  own module at `apps/server/src/rescan-scheduler.ts`. The `index-store.ts`
  module now focuses on its core JSONL aggregation responsibility. Public API
  surface unchanged: the `RescanScheduler` class, `RescanSchedulerOptions`
  interface, constructor signature, `start()` / `stop()` / `tick()` methods,
  and `lastRescanTs` getter all retain their existing semantics.
- `logEvent` signature now accepts `'debug'` as a fourth log level alongside
  `'info' | 'warn' | 'error'`. Debug entries are silently dropped unless
  `TOKENOMIX_DEBUG=1` is set.

## [3.4.1] - 2026-04-30

### Fixed

- Donut charts (Model Mix, Tool Use Breakdown) no longer flicker on hover; added `notMerge` to ECharts components.
- Heatmap tooltip now uses canonical white/gray-950 surface tokens instead of the inverted dark-in-light scheme.
- Spend-over-time x-axis date labels no longer clip against the y-axis or chart edge.
- "Ask AI" button and modal now have proper light-mode styling; modal scoped via `.dark` to preserve dark aesthetic, trigger button has paired light/dark classes.
- Dark mode toggle now has sufficient contrast in dark mode (gray-700 surface, explicit icon color).
- Optimization Opportunities table replaced category pill badges with plain uppercase labels for cleaner appearance.
- Page scroll no longer requires double-swipe; removed `html` from the `overflow-x: hidden` selector.
- Donut chart slices no longer fade out on hover; replaced `emphasis.focus:'none'` (ineffective in ECharts 6) with `emphasis.disabled:true` plus a defensive `blur.itemStyle.opacity:1`.
- Spend over time x-axis rightmost date label (e.g. `04-29`) no longer truncates; widened `grid.right` from 12 to 24 and removed `axisLabel.overflow:'truncate'`.
- Optimization Opportunities table rows are now vertically centered; AREA column header and cells are horizontally centered.
- "Listed impact" badge repositioned to a centered row above the IMPACT column (was right-aligned in the panel header next to the title).
- "Rule Score" column header now displays the help tooltip inline (was floating in the panel header).
- Spend over time leftmost x-axis label fully clears the y-axis tick labels (was still bleeding at 24 px).

### Changed

- Recommendation chat trigger button focus ring is now paired across light and dark modes (was dark-only).
- Recommendation chat status dot uses `bg-amber-500` in light mode for better legibility (was amber-300 only).

## [3.4.0] - 2026-04-29

### Added

- Floating dark-mode toggle (`DarkModeToggle`) fixed at the bottom-right of
  the viewport; persists via `localStorage:tokenomix:theme` and is visible
  on all routes.
- Page header on the Overview page with an enlarged "tokenomix" wordmark and
  a "Full Report" call-to-action linking to `/report`.
- `HelpTooltip` accepts an optional `align: 'left' | 'right'` prop so
  popovers near card edges can be right-anchored to avoid viewport clipping.
- `MIN_TOOL_CALLS_FOR_ERROR_RATE` constant (= 10) in `KpiRow2`: the
  worst-tool error-rate KPI now requires at least 10 calls before a tool is
  eligible, preventing single-failure outliers from dominating the card.

### Changed

- Left sidebar removed; pages handle their own container and padding without
  a shared shell wrapper.
- Activity heatmap hour labels updated to zero-padded 24-hour format
  (00–23); all 7 day rows render as table rows with proper vertical centering.
- Heatmap tooltips no longer duplicate the native browser `title` attribute
  and now flip position to avoid clipping at viewport edges.
- Donut chart hover (Tool Use Breakdown and Model Mix): non-hovered slices
  remain fully opaque; a 1 px accent ring highlights the hovered slice
  instead of dimming the rest.
- Optimization Opportunities table: AREA pill aligned with cell content,
  header pill text changed to "Up to $X potential savings" (sum of the
  Impact column), Impact column centered.
- Activity tab reorganised: heatmap occupies a full-width row; Model Mix and
  Tool Use Breakdown sit in a 2-column grid below it.
- Server-side project-path deduplication tightened with case-insensitive
  normalisation, trailing-slash trimming, and skip rules for non-project
  directories (node_modules, .git, .cache, dist, build, tmp, temp).

### Removed

- Sessions tab from the Overview page tab bar.
- `/sessions` route and `SessionsPage.tsx`.
- `/models` route and `ModelsPage.tsx`.
- Orphaned panel files: `SubagentLeaderboard.tsx`, `TopSessionsTable.tsx`,
  `TopExpensiveTurnsTable.tsx`.
- `--sidebar-width` CSS custom property.

### Fixed

- `HelpTooltip` popover no longer clips at card boundaries when
  `align="right"` is set.
- `HelpTooltip` drop-shadow weight brought within design-lint ceiling.
- `DarkModeToggle` z-index raised to `z-[60]` for headroom above future
  modal layers.
- `HeatmapChart` accessibility: removed redundant `aria-hidden` attribute
  and assigned stable React keys to hour-column elements.

## [3.3.0] - 2026-04-29

### Added

- Date column as column 1 on the Full Session Report (`/report`), formatted
  `MMMM-DD-YYYY` (e.g. `April-29-2026`). Project shifts to column 2.
- `SessionSummary.firstTs` field (`string | null`, ISO 8601 UTC) — populated by
  `computeSessionSummaries()` from the existing `sessionTimes` map; `null` when
  the session was evicted before a timestamp was recorded.
- `formatSessionDate(iso)` helper in `apps/web/src/lib/formatters.ts` — locale-free
  date formatting using hardcoded month names; produces the `MMMM-DD-YYYY` display
  string consumed by the Full Session Report Date column.

- Initial prompt preview (first 500 characters, server-truncated) and JSONL file path
  display on the session detail view; new `SessionDetail.initialPrompt`,
  `initialPromptTruncated`, and `jsonlPath` fields exposed via `GET /api/sessions/:id`.
  The server captures the first user-role message at ingest time and hard-caps it at 500
  characters before serialisation. The JSONL path is metadata only — no endpoint serves
  file contents. Both fields are hidden on the frontend when null. Server already binds
  `127.0.0.1`; no network-exposure change.
- Per-component USD cost breakdown (input / output / cache create / cache read) on the
  session detail view; rendered under each token-count metric card and exposed via
  `SessionDetail.costBreakdown` from `GET /api/sessions/:id`.
- Per-session detail page at `/report/$sessionId` — three-tab view (Overview / Tools /
  Turns) with KPI MetricCards, ToolMixBar donut, per-tool breakdown table, and per-turn
  cost table.
- `GET /api/sessions/:id` endpoint returning a `SessionDetail` JSON object with
  aggregated header fields, full `byTool` array, per-turn rows, and `firstTs`/`lastTs`
  timestamps. The `:id` param is validated against an allowlist regex that rejects path
  separators and NULL bytes.
- `SessionDetail` and `SessionTurnRow` shared types in `packages/shared` (re-exported
  from the barrel).
- `formatProjectName(project)` helper in `apps/web/src/lib/formatters.ts` — extracts
  the basename of a project path for display, handling trailing slashes.
- `escapeFormula(value)` helper in `apps/web/src/lib/csvExport.ts` — prefixes cells
  starting with `=`, `+`, `-`, `@`, or TAB with a single quote to prevent spreadsheet
  formula injection.
- `fetchSessionDetail(sessionId)` API helper and `queryKeys.sessionDetail(sessionId)`
  cache key in `apps/web/src/lib/`.
- Server-side duration observability: `session_detail` log event emitted with
  `durationMs` and `found` fields on every `GET /api/sessions/:id` call.
- 20 new tests: 9 server-side cases covering 200/404/400 paths, path-separator and
  NULL-byte guards, `projectName`/`topTools` shape, empty `toolUses`, and sort order;
  11 web cases covering CSV formula-injection regression paths.

- `POST /api/sessions/:id/reveal` endpoint that opens the session's JSONL file in
  the OS file manager (Finder on macOS, Explorer on Windows, file manager on Linux).
  The path is validated against the in-memory session map and passed as a separate
  `spawn` argument — no shell interpolation. New `IndexStore.getJsonlPathForSession()`
  helper; tests cover 204, 404, and 400 paths.
- "Reveal in Finder" button on the session detail page: posts to the new endpoint and
  shows a transient check icon on success, replacing the previous "Copy path" button.

### Changed

- Full Session Report table now uses `table-fixed` layout with explicit `<colgroup>`
  widths — columns no longer reflow when sort changes or row content varies.
- CSV export gains a `Date` column at index 0 (header and per-row tuple length
  increased to 11); existing columns shift right by one position.

- Full Session Report (`/report`) reorganized: Project (basename) is now the primary
  column with session ID shown as secondary text; the Type column was removed; a Top
  Tools chip column shows up to 3 tool badges with a `+N more` overflow count;
  pagination set to 50 sessions per page.
- `SessionSummary` extended with `projectName: string`, `topTools: ToolBucket[]`, and
  `toolNamesCount: number` fields, populated by `computeSessionSummaries()` on the
  server.
- CSV export adds a `ProjectName` column (basename) at index 1, after the full `Project`
  path column. All CSV cells now pass through formula-injection escaping.
- `Tabs` primitive accepts an optional `ariaLabel` prop to override the default
  accessible name, enabling correct labelling when used outside a dashboard context.
- SSE handler (`useServerEvents.ts`) now invalidates the `['session']` cache key
  alongside the existing keys, so the session list refreshes on file-watch events.
- Full Session Report top-tools chip column: `+N more` overflow indicator now always
  renders on a second line (was inconsistently inline) and links directly to the
  session's Tools tab (`/report/$sessionId#tools`).
- Session detail initial-prompt preview: copy button removed; text remains selectable.
  JSONL path action changed from copy-to-clipboard to reveal-in-file-manager.

### Fixed

- CSV formula-injection vulnerability: cells whose first character is a formula trigger
  (`=`, `+`, `-`, `@`, TAB) are now escaped before writing to the CSV stream.

## [3.2.0] - 2026-04-29

### Added

- `apps/web/src/ui/Tabs.tsx` — headless, hash-synced tabbed navigation primitive with
  ARIA `role="tablist"` / `role="tab"` / `role="tabpanel"`, ArrowLeft/Right keyboard
  cycling, `history.replaceState` hash deep-linking, and render-only-when-active strategy
  so off-tab panels do not fire their `useQuery` hooks.
- `apps/server/src/time.ts` — `formatLocalIso()` and `formatLocalHourIso()` helpers
  that produce local-time ISO 8601 strings with UTC offset (e.g.
  `"2026-04-15T14:00:00.000-05:00"`), replacing raw `Date.toISOString()` calls that
  always emitted UTC and produced wrong-day bucketing for non-UTC users.
- `apps/web/src/vite-env.d.ts` — standard Vite client type reference shim.
- OverviewPage rebuilt into 4 navigable tabs: **Overview** (HeroSpend → CostDriversPanel
  → AreaChartPanel → KpiRow), **Recommendations** (OptimizationOpportunitiesPanel →
  OptimizationSignalsPanel → KpiRow2), **Activity** (HeatmapPanel + ModelMixPanel +
  ToolsBreakdownPanel), **Sessions** (TopSessionsTable + SubagentLeaderboard +
  TopExpensiveTurnsTable). Tab state is synced with `window.location.hash` for
  deep-linking; panels only mount when their tab is active.

### Changed

- `HeroSpend` — warning icon inlined (removed external dependency), blue delta pill
  replacing the old neutral pill, **TOKENS · MTD** big-grey block added alongside
  current spend.
- `MetricCard` — empty-signal guard added: the trend pill is omitted when there is no
  real delta signal (avoids rendering a meaningless em-dash pill for every static card).
- `OptimizationOpportunitiesPanel` — `<colgroup>` fixed-width columns, alignment
  corrections, label simplification, and tooltip anchor standardisation.
- `HeatmapPanel` + `HeatmapChart` — single-hue colour ramp replacing the old
  multi-colour scale; larger axis labels; custom tooltip; total-turns subtitle added to
  the panel header.
- `ModelMixBar` + `ToolMixBar` — donut hover bug fixed: chart now uses `scale: false`
  and drops `notMerge` to prevent the stale-highlight issue on hover.
- `TurnBucket.timestamp` is now a local ISO 8601 string with UTC offset (doc-only
  change to the type comment; consumers that previously relied on the UTC `Z` suffix
  should use the new offset-aware value).
- Comment cleanup in `packages/shared/src/types.ts` (section header wording).
- Export order in `packages/shared/src/index.ts` and `apps/server/src/pricing.ts`
  normalised to alphabetical within each group (no functional change).

### Removed

- `bin/claude-usage.py`, `bin/retro-trends.py`, `bin/tokenomix_config.py`,
  `bin/usage-dashboard.py` — legacy Python CLI tooling retired. The TypeScript
  monorepo (introduced in v1.2.0) is the sole supported interface.
- `tests/test_tokenomix.py` — Python test suite removed alongside the tooling.
- `config.example.json` — Python-era runtime config template removed; TypeScript
  server config is documented in `README.md`.
- `output/.gitkeep` — empty output directory placeholder removed.

## [3.1.0] - 2026-04-28

### Added

- OptimizationSignalsPanel — new "Optimization Signals" section on the Overview page showing P90
  session duration (with P50 context), subagent success rate (when subagents present), and top
  expensive project by 30-day spend share (when project data present).
- Turn-cost percentiles on `MetricSummary`: `turnCostP50_30d`, `turnCostP90_30d`,
  `turnCostP99_30d` — precomputed server-side from per-turn cost values in the 30-day window.
- Previous-30-day windowed fields on `MetricSummary`: `inputTokensPrev30d`,
  `outputTokensPrev30d`, `costUsd30dPrev` — enables token and cost delta cards on the frontend.
- Vitest smoke tests for KpiRow, KpiRow2, and OptimizationSignalsPanel (empty-state and
  populated-state fixtures).

### Changed

- KpiRow now shows four actionable optimization cards: **TOKENS · 30D** (with prev-30d delta),
  **Cost / Output Token** (30D, cost efficiency per output token with delta), **Turn P90 Cost**
  (30D, with P50 context line), and **Cost WoW Delta** (last-vs-prior full week from
  `weeklySeries[]`).
- KpiRow2 Tool Error card now shows the worst-offender tool name and error rate when any tool
  has errors (`byTool` non-empty with `errorRate > 0`); the slot is hidden entirely otherwise,
  reflowing the row to 2 columns.
- ToolsBreakdownPanel renders nothing (removes itself from grid flow) when no tool data exists,
  instead of showing a "No tool activity yet." placeholder.

### Removed

- Cache Efficiency KPI card from KpiRow (cache hit rate is saturated at ~96% with no user
  lever; replaced by actionable cost and token-delta cards).
- Sessions and Avg Session Duration KPI cards from KpiRow (replaced by the new actionable
  cards above).
- Tool Error Rate aggregate (30D) card from KpiRow2 (replaced by the conditional worst-tool
  error display that hides when irrelevant).

## [3.0.1] - 2026-04-28

### Fixed

- TOKENS · 30D KPI now uses input + output only (matches HeroSpend MTD semantics).
  Cache-creation tokens are billing-overhead, not conversational tokens, and including
  them made the 30D figure ~10x larger than MTD.

## [3.0.0] - 2026-04-28

### Added

- `MetricSummary.cacheCreationTokens30d` — sum of cache-creation tokens
  (5 m + 1 h tiers) in the absolute 30-day window, using the same
  project-filtered source set as `inputTokens30d` / `outputTokens30d`.
- `MetricSummary.cacheReadTokens30d` — sum of cache-read tokens in the
  same 30-day window.
- `MetricSummary.totalProjectsTouched` — count of distinct project
  basenames (derived from `path.basename(cwd)`) across all rows; collapses
  the same project accessed from different mount points to one entry.
- `TokenRow.projectName` — human-readable project name computed at ingest
  time via `path.basename(cwd.replace(/\/+$/, ''))`.
- `apps/server/src/logger.ts` — shared structured-logging module consumed
  by both `parser.ts` and `index-store.ts`; routes `warn`/`error` to
  stderr and `info` to stdout (POSIX convention).
- `apps/server/scripts/verify-cache-tokens.ts` — one-off diagnostic script
  that scans live JSONL files and confirms cache-token aggregation produces
  no double-count. Not shipped to production; run manually with
  `npx tsx apps/server/scripts/verify-cache-tokens.ts`.
- ADR 0003 documenting the two-pass JSONL ingest architectural decision.

### Changed

- `ingestFileInternal()` now uses two sequential readline passes over the
  same file: pass 1 collects all `tool_use`, `tool_result`, and
  `system/turn_duration` events into `requestId`-keyed accumulators; pass 2
  builds `TokenRow` entries and merges from those accumulators. Tool events
  that appear after the assistant event in the JSONL stream are now correctly
  merged (fixes the empty Tool Use Breakdown panel).
- `KpiRow` TOKENS card now displays the 30-day token total
  (`inputTokens30d + outputTokens30d + cacheCreationTokens30d`), labelled
  **TOKENS · 30D**. Cache reads are excluded (free reuse). The lifetime total
  is no longer shown as the headline figure. Delta percent is omitted because
  no structurally equivalent prior-period baseline is available.
- `KpiRow2` reflowed from 4 cards to 3 (**PROJECTS TOUCHED** ·
  **AVG COST / TURN** · **TOOL ERROR RATE**); grid changed from
  `cols={4}` to `cols={3}`.
- `KpiRow2` card formerly labelled "Files Touched" is now **PROJECTS
  TOUCHED** and reads `totalProjectsTouched` (basename-deduped count)
  instead of `totalFilesTouched`.
- `filesTouched` deduplication in pass 2 is now Set-based (`Set<string>`)
  instead of `Array.includes()`, giving O(1) membership tests per file path.
- `collectJsonlFiles()` in both `index-store.ts` and
  `verify-cache-tokens.ts` now skips symbolic links before the
  `isDirectory` check to prevent circular-traversal loops.
- `pctDelta` helper extracted from `KpiRow.tsx` and `KpiRow2.tsx` into the
  shared `apps/web/src/lib/formatters.ts` module.
- `RawUsage.service_tier`, `.speed`, and `.inference_geo` are now typed
  as `string | null` in `types.ts` and use `z.string().nullish()` in
  `schemas.ts` to handle API-error JSONL records where these fields are
  absent or null.

### Removed

- `MetricSummary.activeMs30d` and `MetricSummary.idleMs30d` — the Active
  Time KPI card showed a persistent zero due to incomplete data and has
  been removed. **Breaking change for external consumers of
  `GET /api/metrics`** — these fields are absent from the response object.
  `TokenRow.turnDurationMs` is retained; `getTurns()` and the subagent
  leaderboard continue to use it via `TurnBucket.durationMs` and
  `SubagentBucket.avgDurationMs`.
- Active Time `MetricCard` removed from `KpiRow2.tsx`.

## [2.0.0] - 2026-04-28

### Added

- Tools breakdown panel — per-tool call counts and error rates over the active window
- Subagent leaderboard — agent type, dispatches, tokens, average duration, success rate
- Active vs idle time KPI on Activity / Insights row (second KPI row)
- Files-touched count KPI (unique file paths read/written, paths never displayed)
- Cost-per-turn KPI with 30-day rolling delta
- Tool error rate KPI (tool_result.is_error percentage)
- Top-10 expensive turns table (`GET /api/turns`)
- ADR 0002 documenting the tool-event ingestion privacy policy

### Changed

- Schema now accepts `tool_use`, `tool_result`, and `system/turn_duration` events
- `MetricSummary` extended with `byTool`, `bySubagent`, `activeMs30d`, `idleMs30d`,
  `totalFilesTouched`, `avgCostPerTurn30d`, `avgCostPerTurnPrev30d`, `toolErrorRate30d`

### Removed

- `MetricSummary` fields `activeMsLifetime` and `idleMsLifetime` (superseded by the
  30-day windowed `activeMs30d` / `idleMs30d` fields)

## [1.2.0] - 2026-04-27

### Added

- pnpm monorepo (`apps/server`, `apps/web`, `packages/shared`) providing an
  interactive TypeScript dashboard alongside the existing Python CLI tooling.
- Hono API server (Node 22) with routes `/api/metrics`, `/api/sessions`,
  `/api/health`, and `/api/events` (SSE live-update stream). Binds
  `127.0.0.1` only; no auth, no telemetry.
- React 18 + Vite 6 web dashboard with sidebar navigation, KPI row with
  sparklines, smooth gradient area chart (7d/30d/all toggle), day-of-week ×
  hour-of-day activity heatmap, top-sessions table, and model-mix stacked
  bar. Three pages: Overview, Sessions, Models.
- Tailwind v4 with CSS-native `@theme` block: primary blue OKLCH accent
  (`oklch(0.49 0.16 255)` light / `oklch(0.58 0.12 255)` dark), achromatic
  gray scale, dark mode toggle persisted to `localStorage:tokenomix:theme`.
- Apache ECharts 5 for all chart primitives (area, heatmap, stacked bar).
- TypeScript end-to-end: shared Zod schemas, types, and pricing module in
  `packages/shared`. Pricing module ported exactly from `bin/claude-usage.py`
  (locked-in test values: opus event $0.0675, combined sonnet $0.10).
- chokidar live-watch on the JSONL corpus; file changes push an SSE
  `updated` event that triggers TanStack Query cache invalidation.
- Vitest unit tests for the pricing module and JSONL parser.
- Single-command development (`pnpm dev`) and full-stack run
  (`pnpm start:full`). Web port defaults to `$PORT_BASE` (3000), server to
  `$PORT_BASE+1` (3001).
- Runtime configuration through `--config`, `TOKENOMIX_CONFIG`,
  `~/.claude/tokenomix/config.json`, and `~/.config/tokenomix/config.json`.
  Claude session discovery still defaults to `~/.claude/projects`, but
  `projects_dir`, `exclude_cwd_prefixes`, and `retro_history_paths` are now
  configurable for organization rollout. Explicit config paths now fail fast
  when missing.
- Generic `--exclude-cwd-prefix` / `--include-excluded` support across
  `claude-usage.py` and `usage-dashboard.py`. The old local alias remains
  accepted but is hidden from help output.
- `config.example.json` as the documented template for shared or per-user
  rollout configuration.
- ADR `docs/adr/0001-typescript-dashboard.md` documenting the Hono + Vite +
  React + ECharts architectural decision.

### Fixed

- Cache-creation accounting now falls back to top-level
  `usage.cache_creation_input_tokens` when the nested
  `usage.cache_creation.ephemeral_*_input_tokens` split is absent or zeroed.
  Auditing real Claude Code logs found six deduped events with nonzero
  top-level cache creation and zero nested TTL fields; those were previously
  undercounted by about $0.08 on the current local dataset.
- Official non-token and multiplier pricing represented in Claude Code usage
  blocks is now included: web search requests at $10 / 1,000 searches, batch
  token pricing at 0.5x, fast mode token pricing at 6x for currently supported
  Opus 4.6 usage, and US-only inference token pricing at 1.1x for current
  eligible model IDs.
- `report --projects-dir` now propagates the configured projects directory to
  the by-project, by-session, and by-model subsections instead of only the
  totals/daily/weekly sections.
- The dashboard footer now points at `~/.claude/tokenomix/bin/usage-dashboard.py`
  instead of the old pre-migration `~/.claude/scripts/usage-dashboard.py` path.

## [1.1.0] - 2026-04-27

### Fixed

- **CRITICAL: Opus 4.5/4.6/4.7 pricing was 3x too high.** The `MODEL_PRICES["opus"]`
  table used Opus 4 / 4.1 rates ($15/$75 input/output) instead of the current
  Opus 4.5+ rates ($5/$25). Across all token types — input, output, both
  cache-creation tiers, and cache-read — every Opus 4.5+ event was being
  billed at three times the actual API cost. For a heavy Opus user this
  inflated all-time totals by roughly 2x and single-day spikes by up to 3x.
  Verified against `https://platform.claude.com/docs/en/about-claude/pricing`
  on 2026-04-27.
- **Daily buckets were shifted by the user's UTC offset.** `parse_iso` stripped
  the trailing `Z` from Anthropic-emitted UTC timestamps and parsed the result
  as a naive datetime, which downstream code then bucketed by `strftime`. For
  any non-UTC user, events between local midnight and UTC midnight were
  attributed to the wrong calendar day. `parse_iso` now parses `Z` as explicit
  UTC, converts to system-local time, and returns a naive local datetime.
  Totals are unchanged; daily / weekly breakdowns now reflect the user's
  wall-clock day.

### Added

- Version-aware pricing for Opus (modern 4.5+ vs legacy 4 / 4.1 / 3) and
  Haiku (4.5 vs 3.5 vs 3). Each tier has its own entry in `MODEL_PRICES`
  with rates verified against the current Anthropic pricing page.
- `_model_version()` helper that extracts a `(major, minor)` tuple from a
  model id like `claude-opus-4-7` → `(4, 7)`. Used by `model_family()` to
  route an event to the correct pricing tier.
- Test coverage for version-aware family detection across all current and
  legacy Claude IDs (15 cases) and for the `parse_iso` timezone fix
  (UTC → local conversion, naive passthrough, error handling).

## [1.0.0] - 2026-04-27

### Added

- Initial project layout at `~/.claude/tokenomix/` with `bin/`, `tests/`,
  and `output/` subdirectories.
- `bin/claude-usage.py` — real API usage tracker that reads `.claude/projects/**/*.jsonl`
  recursively (including subagent logs), deduplicates by `(requestId, message.id)`,
  resolves project paths losslessly via the `cwd` field, and prices per-event
  using the `message.model` value (Opus / Sonnet / Haiku).
- `bin/retro-trends.py` — retro-tracked spend rollups, timeline, and per-pipeline
  savings forecast for REC-1 through REC-5. Normalises `orchestrator`/`orchestration`
  subjects via the `SUBJECT_ALIASES` map.
- `bin/usage-dashboard.py` — self-contained HTML dashboard with Chart.js
  visualisations. Pulls data from the two sibling scripts and embeds JSON
  inline so the file opens via `file://` without a server. Design system uses
  OKLCH tokens, a primary blue accent, monochromatic discipline, platform-density
  spacing, and Lucide icons on every card and panel header.
- `tests/test_tokenomix.py` — smoke tests for all three scripts: synthetic
  conversation log generation, dedup verification, subagent inclusion,
  per-model pricing arithmetic, retro-trends rollup/forecast/report,
  dashboard HTML structure.

### Migrated from `~/.claude/scripts/`

The three scripts and their tests previously lived at:

- `~/.claude/scripts/claude-usage.py` → `~/.claude/tokenomix/bin/claude-usage.py`
- `~/.claude/scripts/retro-trends.py` → `~/.claude/tokenomix/bin/retro-trends.py`
- `~/.claude/scripts/usage-dashboard.py` → `~/.claude/tokenomix/bin/usage-dashboard.py`
- 3 tokenomix test functions previously in `~/.claude/scripts/tests/test_scripts.py`
  → `~/.claude/tokenomix/tests/test_tokenomix.py`

Internal cross-references updated:
- `usage-dashboard.py` now resolves sibling scripts via
  `Path(__file__).resolve().parent` instead of a hardcoded `~/.claude/scripts/`.
- `DEFAULT_OUTPUT` now points to `output/usage-dashboard.html` within the
  project, instead of a session-specific retro directory.

[Unreleased]: https://github.com/bmjcoding/tokenomix/compare/v3.7.1...HEAD
[3.7.1]: https://github.com/bmjcoding/tokenomix/compare/v3.7.0...v3.7.1
[3.7.0]: https://github.com/bmjcoding/tokenomix/compare/v3.6.0...v3.7.0
[3.6.0]: https://github.com/bmjcoding/tokenomix/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/bmjcoding/tokenomix/compare/v3.4.1...v3.5.0
[3.4.1]: https://github.com/bmjcoding/tokenomix/compare/v3.4.0...v3.4.1
[3.4.0]: https://github.com/bmjcoding/tokenomix/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/bmjcoding/tokenomix/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/bmjcoding/tokenomix/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/bmjcoding/tokenomix/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/bmjcoding/tokenomix/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/bmjcoding/tokenomix/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/bmjcoding/tokenomix/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/bmjcoding/tokenomix/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/bmjcoding/tokenomix/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/bmjcoding/tokenomix/tree/v1.0.0
