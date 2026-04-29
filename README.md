# tokenomix

Token-economics tooling for Claude Code: real API usage tracking, retro-tracked
spend analysis, savings forecasting, and an HTML dashboard that visualises all
of it.

## Layout

```
~/.claude/tokenomix/
├── README.md                   ← you are here
├── CHANGELOG.md                ← version history
├── config.example.json         ← optional runtime config template
├── bin/
│   ├── claude-usage.py         ← real API usage from ~/.claude/projects/
│   ├── retro-trends.py         ← retro-tracked spend + REC-1..5 forecast
│   └── usage-dashboard.py      ← self-contained HTML dashboard generator
├── tests/
│   └── test_tokenomix.py       ← smoke tests for the three scripts
└── output/                     ← default output dir (HTML/Markdown reports)
    └── usage-dashboard.html    ← regenerable dashboard
```

## Quick start

```bash
# Generate the dashboard (default output: ~/.claude/tokenomix/output/usage-dashboard.html)
python3 ~/.claude/tokenomix/bin/usage-dashboard.py --open

# Just the numbers — all-time API spend
python3 ~/.claude/tokenomix/bin/claude-usage.py totals

# Last 5 days, broken down by day
python3 ~/.claude/tokenomix/bin/claude-usage.py daily --since 5

# Retro-tracked spend rollup (formal orchestration sessions only)
python3 ~/.claude/tokenomix/bin/retro-trends.py rollup --by month

# Forecast: what would REC-1..REC-5 save per pipeline?
python3 ~/.claude/tokenomix/bin/retro-trends.py forecast --pipelines-per-month 20

# Run smoke tests
python3 ~/.claude/tokenomix/tests/test_tokenomix.py
```

## Configuration

Tokenomix assumes only the Claude Code session root exists at
`~/.claude/projects`. Optional local data sources and exclusions are configured
instead of hardcoded.

Configuration precedence:
1. CLI value flags, such as `--projects-dir` and `--exclude-cwd-prefix`
2. Environment value overrides, such as `TOKENOMIX_PROJECTS_DIR`
3. JSON loaded from `--config` or `TOKENOMIX_CONFIG`
4. JSON loaded from `~/.claude/tokenomix/config.json`
5. JSON loaded from `~/.config/tokenomix/config.json`
6. Built-in defaults

Supported config keys:

```json
{
  "claude_home": "~/.claude",
  "projects_dir": "~/.claude/projects",
  "exclude_cwd_prefixes": [],
  "retro_history_paths": []
}
```

Explicit `--config` / `TOKENOMIX_CONFIG` paths must exist; missing config files
are treated as invocation errors instead of silently falling back.

Environment variables:

- `TOKENOMIX_CONFIG`
- `TOKENOMIX_CLAUDE_HOME`
- `TOKENOMIX_PROJECTS_DIR`
- `TOKENOMIX_EXCLUDE_CWD_PREFIXES` (`:`-separated on macOS/Linux)
- `TOKENOMIX_RETRO_HISTORY_PATHS` (`:`-separated on macOS/Linux)
- `TOKENOMIX_PRICING_PROVIDER` (`anthropic_1p`, `aws_bedrock`, or `internal_gateway`)
- `TOKENOMIX_BEDROCK_REGION` (for Bedrock or internal-gateway deployments)
- `TOKENOMIX_BEDROCK_ENDPOINT_SCOPE` (`in_region`, `global_cross_region`, or `geographic_cross_region`)
- `TOKENOMIX_BEDROCK_SERVICE_TIER` (`standard`, `batch`, `provisioned`, `reserved`, or `unknown`)

Common examples:

```bash
# Exclude optional automation sessions by cwd prefix
python3 ~/.claude/tokenomix/bin/claude-usage.py totals \
  --exclude-cwd-prefix ~/automation-sessions

# Add optional retro history sources only where they exist
python3 ~/.claude/tokenomix/bin/retro-trends.py rollup --by month \
  --history-path ~/path/to/retro-history.jsonl

# Keep configured exclusions in the report
python3 ~/.claude/tokenomix/bin/claude-usage.py totals --include-excluded

# Use a shared organization config
python3 ~/.claude/tokenomix/bin/usage-dashboard.py \
  --config ~/.config/tokenomix/config.json
```

## What each script does

### `bin/claude-usage.py` — actual API usage

Recursively reads every `.jsonl` file under `~/.claude/projects/` (including
subagent logs at `<session>/subagents/agent-XXX.jsonl`), extracts each event's
`message.usage` block, applies per-model pricing (Opus / Sonnet / Haiku via
`message.model`), and reports token spend.

**Key behaviours:**
- **Deduplicates** events sharing the same `(requestId, message.id)` —
  Claude Code stores multi-block API responses (e.g., a thinking block + a
  text block from one API call) as separate events with the SAME usage block.
- **Resolves project paths losslessly** by reading the `cwd` field from log
  events instead of attempting to reverse Claude Code's lossy directory-name
  encoding.
- **Distinguishes main-session from subagent events** based on file path.
- **Version-aware per-model pricing** based on Anthropic public pricing.
  Opus 4.5+ ($5/$25 input/output per Mtok) is priced separately from legacy
  Opus 4 / 4.1 ($15/$75) — the rates dropped 3x at the 4.5 release. Sonnet
  3.7 / 4 / 4.5 / 4.6 share $3/$15. Haiku has three tiers: 4.5 ($1/$5),
  3.5 ($0.80/$4), 3 ($0.25/$1.25). Cache-write and cache-read rates scale
  per the published 1.25x / 2x / 0.1x multipliers. Override via CLI flags.
- **Handles both cache-creation schemas** from Claude Code logs. Nested
  `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
  values are preferred; if a legacy or edge log has only nonzero top-level
  `cache_creation_input_tokens`, those tokens are priced as 5-minute cache
  writes instead of being dropped.
- **Includes official pricing modifiers present in usage logs**: web search
  requests (`$10 / 1,000`), Batch API token discount (`0.5x`), fast mode token
  premium (`6x`), and US-only inference token premium (`1.1x`) for current
  eligible model IDs.
- **Discloses pricing quality in the API and dashboard.** The TypeScript
  dashboard returns `pricingAudit`, including provider, static catalog source,
  integer micro-USD totals, fallback-priced rows, Bedrock region/scope metadata,
  gateway-rated row counts, and warnings when values are estimates rather than
  rated internal gateway cost.
- **UTC → local timezone conversion** for daily and weekly buckets. Anthropic
  logs are UTC; the script converts each timestamp to system-local time
  before bucketing, so "Apr 27" in the dashboard means *your* Apr 27, not
  UTC Apr 27.
- **Configurable cwd-prefix exclusions.** Sessions whose resolved `cwd` is
  under any configured `exclude_cwd_prefixes` entry are dropped from totals
  unless `--include-excluded` is passed. This can exclude non-engineering
  automation without hardcoding one user's directory layout. The match is
  anchored on path-segment boundaries.

**Subcommands:**
- `totals [--since DAYS] [--project PATH]` — all-time or windowed totals
- `daily [--since DAYS]` — per-day breakdown
- `weekly [--since DAYS]` — per-ISO-week breakdown
- `by_project [--top N]` — top projects by cost
- `by_session [--top N]` — top sessions by cost
- `by_model` — per-model-family breakdown
- `report [--output FILE]` — comprehensive markdown report

### `bin/retro-trends.py` — retro-tracked spend + forecast

Reads structured retro summaries from configured `retro_history_paths` and
produces:

- All-time / windowed cost rollups
- Per-month and per-subject breakdowns (with `orchestrator`/`orchestration`
  subject normalisation)
- Chronological timeline
- **Forecast** of expected per-pipeline savings under the post-2026-04-27
  follow-up state (REC-1 through REC-5), grounded in observed recurrence
  rates from the prior 10 retros

**Important scope note:** this optional view only sees formal orchestration
sessions that produced a retro file. For the full picture, use
`claude-usage.py`.

**Subcommands:**
- `rollup [--since DATE] [--subject NAME] [--by month|subject|all]`
- `timeline [--since DATE] [--subject NAME]`
- `forecast [--baseline USD] [--pipelines-per-month N] [--override KEY=VAL]`
- `report [--output FILE]`

### `bin/usage-dashboard.py` — self-contained HTML dashboard

Calls the two scripts above, embeds the JSON output in a single HTML file,
and renders Chart.js visualizations. The output is fully self-contained
(opens via `file://`) and does not require a server.

**Design system:**
- OKLCH color space throughout (no hex)
- Single chromatic accent (primary blue, `oklch(0.58 0.12 255)`) + grayscale
- Anti-busy compliant (≤3 non-gray families on screen)
- Platform-density spacing (gap-3, p-5)
- Tabular numerals on all numeric columns
- Doughnut charts have center labels showing dominant slice %
- Each KPI card has a Lucide icon + label + value + context line + mini
  progress bar
- Each panel has a Lucide icon next to its uppercase label

**Flags:**
- `--output FILE` — override default location
- `--open` — also opens the file in default browser
- runtime config and exclusion flags forwarded to child scripts

## TypeScript dashboard (interactive)

An interactive web dashboard built as a pnpm monorepo alongside the existing
Python tooling. It reads the same `~/.claude/projects/` JSONL data source and
uses a pricing module ported exactly from `bin/claude-usage.py` — cost figures
are identical. The Python scripts remain the canonical CLI and static-HTML
surface; the TypeScript app is the new interactive surface.

See [docs/adr/0001-typescript-dashboard.md](docs/adr/0001-typescript-dashboard.md)
for the architecture decision record.

MCP integration is intentionally scoped as a read-only integration surface, not
as the pricing authority. See
[docs/adr/0005-mcp-integration-boundary.md](docs/adr/0005-mcp-integration-boundary.md).

### Pricing Data Quality

By default the dashboard estimates cost from Claude Code JSONL usage and the
static public Anthropic catalog. For Amazon Bedrock deployments, set:

```bash
TOKENOMIX_PRICING_PROVIDER=aws_bedrock
TOKENOMIX_BEDROCK_REGION=us-east-1
TOKENOMIX_BEDROCK_ENDPOINT_SCOPE=geographic_cross_region
```

For firms routing Claude through an internal LLM Gateway on Bedrock, set:

```bash
TOKENOMIX_PRICING_PROVIDER=internal_gateway
TOKENOMIX_BEDROCK_REGION=us-east-1
```

Internal gateway mode is only penny-accurate when the ingested JSONL rows
include a gateway-rated cost field. Recognized top-level fields are
`costUsdMicros`, `cost_usd_micros`, `gatewayCostUsdMicros`,
`internalCostUsdMicros`, `chargebackCostUsdMicros`, or the corresponding USD
fields `costUsd`, `cost_usd`, `gatewayCostUsd`, `internalCostUsd`,
`chargebackCostUsd`. Rows without one of those fields are marked
`internal_gateway_unrated_estimate` and the dashboard shows a pricing-quality
warning.

Static catalog verification:

```bash
pnpm verify:pricing
```

This verifies the committed Anthropic pricing table against Anthropic's current
public pricing page. It intentionally does not live-mutate application pricing
at runtime.

### Quick start

```bash
pnpm install
pnpm dev       # web on $PORT_BASE (default 3000), server on $PORT_BASE+1 (default 3001)
```

Full-stack production preview:

```bash
pnpm build
pnpm start:full
```

### Stack

| Layer | Technology |
|-------|-----------|
| Server runtime | Node 22, Hono |
| Web bundler | Vite 6 |
| UI | React 18, TanStack Router, TanStack Query |
| Charting | Apache ECharts 5 |
| Styling | Tailwind v4 (CSS-native `@theme` block, primary blue OKLCH palette) |
| Shared | Zod schemas, shared types, pricing module |
| Linter | Biome |
| Tests | Vitest |

### API routes

| Route | Description |
|-------|-------------|
| `GET /api/metrics?since=7d\|30d\|all&project=...` | Flat `MetricSummary` (aggregated totals) |
| `GET /api/sessions?since=...&project=...&limit=...` | `SessionSummary[]` (per-session breakdown) |
| `GET /api/health` | `{ok, projectsDir, isReady, indexedRows, lastUpdated}` — 503 until ready |
| `GET /api/turns?since=...&limit=...&project=...` | `TurnBucket[]` top-N expensive turns, sorted by cost descending (default 10, max 50) |
| `GET /api/events` | SSE stream: `{type:'updated'\|'shutdown', ts:number}` |

### Commands

```bash
pnpm dev          # concurrent server + web with HMR
pnpm build        # build both apps
pnpm typecheck    # full TypeScript validation
pnpm lint         # Biome
pnpm test         # Vitest (pricing/parser unit tests)
pnpm start        # server only (production)
pnpm start:full   # server + Vite preview of built web bundle
```

## Tests

```bash
python3 ~/.claude/tokenomix/tests/test_tokenomix.py
```

Covers:
- Synthetic conversation log → expected token/cost arithmetic
- Dedup correctness (6 raw events → 5 deduped)
- Subagent file detection via `<session>/subagents/`
- Per-model breakdown contains all three families
- retro-trends rollup totals match input
- retro-trends forecast respects overrides
- usage-dashboard generates non-trivial HTML with all chart canvases
