# tokenomix

Interactive TypeScript dashboard for AI coding assistant token usage. The
server reads Claude Code JSONL session logs from `~/.claude/projects`, OpenAI
Codex session logs from `~/.codex/sessions`, and local-model telemetry,
normalizes them into one local metrics index, and serves a localhost-only API
consumed by the Vite/React dashboard.

## Layout

```text
~/.claude/tokenomix/
├── apps/
│   ├── server/          # Hono API, JSONL parser, watcher, aggregation tests
│   └── web/             # Vite/React dashboard
├── packages/
│   └── shared/          # shared Zod schemas, types, and pricing logic
├── docs/adr/            # architecture decisions
├── package.json         # pnpm workspace root
└── pnpm-lock.yaml
```

## Requirements

- Node.js 22+
- pnpm 10.33.0

The workspace is pinned with:

```json
"packageManager": "pnpm@10.33.0"
```

Use Corepack if your shell has another pnpm version first on `PATH`:

```bash
corepack pnpm@10.33.0 install
```

## Quick Start

```bash
corepack pnpm@10.33.0 install
corepack pnpm@10.33.0 dev
```

Defaults:

- Web dashboard: `http://127.0.0.1:3000`
- API server: `http://127.0.0.1:3001`
- Data sources:
  - Claude Code: `~/.claude/projects/**/*.jsonl`
  - OpenAI Codex: `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl`
  - Local models: `~/.tokenomix/local-models/**/*.jsonl`

Set `PORT_BASE` to move both ports. The web server uses `PORT_BASE`; the API
server uses `PORT_BASE + 1`.

```bash
PORT_BASE=4100 corepack pnpm@10.33.0 dev
```

## Commands

```bash
corepack pnpm@10.33.0 dev          # server + web with HMR
corepack pnpm@10.33.0 build        # build all packages/apps
corepack pnpm@10.33.0 typecheck    # TypeScript validation
corepack pnpm@10.33.0 lint         # Biome
corepack pnpm@10.33.0 test         # Vitest
corepack pnpm@10.33.0 start        # server only, built output
corepack pnpm@10.33.0 start:full   # server + Vite preview
corepack pnpm@10.33.0 verify:pricing # official Anthropic + OpenAI/Codex pricing checks
```

## Stack

| Layer | Technology |
| --- | --- |
| Package manager | pnpm 10.33.0 |
| Server runtime | Node 22, Hono |
| Web bundler | Vite 8 |
| UI | React 19, TanStack Router, TanStack Query |
| Charting | Apache ECharts 6 |
| Styling | Tailwind CSS 4 |
| Shared contracts | Zod 4 schemas and TypeScript types |
| Lint/format | Biome 2 |
| Tests | Vitest 4 |

## Pricing Data Quality

By default, tokenomix estimates cost from Claude Code JSONL usage using a static
public Anthropic catalog committed in `packages/shared/src/pricing.ts`.

OpenAI Codex rows are estimated from the static OpenAI API pricing catalog and
Codex rate card when the local model ID is recognized. Current coverage includes
`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, and `gpt-5.2`.
Research-preview or unknown OpenAI Codex model IDs remain token-counted but
unpriced, and the pricing audit lists those model IDs explicitly. GPT-5.5 and
GPT-5.4 rows apply OpenAI long-context pricing when captured input exceeds
272,000 tokens.

OpenAI Codex pricing is intentionally disclosed as a standard-speed estimate.
Local Codex JSONL currently does not include a per-turn service-tier marker, so
tokenomix cannot reconstruct Fast mode billing from logs alone. This matters
for `gpt-5.5` and `gpt-5.4`, where OpenAI documents higher Fast mode credit
rates. OpenAI Codex web-search calls are counted as tool/session activity but
are not separately added to Codex cost because the Codex rate card is token-based
and the local logs do not identify API-key vs ChatGPT billing mode for tool-call
fees.

For controlled pilot gates, provider caveats, and local-model adapter examples,
see `docs/pilot-readiness.md`.

Local-model rows are priced as counterfactual Claude Sonnet-equivalent cost in
the primary dashboard cost field. This is not actual spend; local API spend is
`$0` before hardware, power, and operator time. Each local row also carries a
OpenAI Codex/GPT-5.5-equivalent estimate for comparison surfaces.

## Ask AI Provider Mode

The floating Ask AI panel follows the selected provider mode:

- `Claude Code` and `All providers` use the local Claude Code subprocess runner.
- `OpenAI Codex` uses `codex exec --json` through the local Codex CLI.
- `Local Models` hides Ask AI for now; local-model telemetry remains visible in
  the dashboard/report and in all-provider aggregates.

For Amazon Bedrock deployments:

```bash
TOKENOMIX_PRICING_PROVIDER=aws_bedrock
TOKENOMIX_BEDROCK_REGION=us-east-1
TOKENOMIX_BEDROCK_ENDPOINT_SCOPE=geographic_cross_region
corepack pnpm@10.33.0 dev
```

For internal LLM gateway deployments backed by Bedrock:

```bash
TOKENOMIX_PRICING_PROVIDER=internal_gateway
TOKENOMIX_BEDROCK_REGION=us-east-1
corepack pnpm@10.33.0 dev
```

Internal gateway mode is penny-accurate only when JSONL rows include a
gateway-rated cost field. Recognized top-level micro-USD fields include
`costUsdMicros`, `cost_usd_micros`, `gatewayCostUsdMicros`,
`internalCostUsdMicros`, and `chargebackCostUsdMicros`. Recognized USD fields
include `costUsd`, `cost_usd`, `gatewayCostUsd`, `internalCostUsd`, and
`chargebackCostUsd`.

## Recommendation Chat

The Recommendations tab can call a local Claude Code executable to answer
questions about the currently indexed optimization opportunities. tokenomix
treats Claude Code as an opaque local command: gateway URLs, AWS credentials,
and enterprise auth settings stay in Claude Code and are never read or exposed
by the dashboard.

Optional controls:

```bash
TOKENOMIX_CLAUDE_COMMAND=/Users/me/.local/bin/claude
TOKENOMIX_CLAUDE_CHAT_MODEL=sonnet
TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD=0.15
TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS=60000
TOKENOMIX_CLAUDE_CHAT_EFFORT=low
TOKENOMIX_CLAUDE_CHAT_BARE=0
corepack pnpm@10.33.0 dev
```

The chat route runs Claude Code in print mode with tools disabled, a bounded
turn count, and the configured budget cap. Streamed turns use deterministic
retrieval over the existing in-memory usage index: global optimization context
for the initial seed, then targeted project/session/turn context for follow-up
questions. Follow-up streamed turns resume the same server-process Claude Code
session until the server is stopped.

`TOKENOMIX_CLAUDE_CHAT_EFFORT` is optional and accepts Claude Code effort
levels such as `low`, `medium`, or `high`. `TOKENOMIX_CLAUDE_CHAT_BARE=1`
enables Claude Code bare mode for faster startup, but it is disabled by default
because some enterprise Claude Code authentication and settings flows depend on
the normal startup path.

## API Routes

| Route | Description |
| --- | --- |
| `GET /api/metrics?since=7d\|30d\|all&project=...` | Aggregated totals, series, model/project/tool breakdowns |
| `GET /api/recommendations/chat/status` | Local Claude Code availability for recommendation chat |
| `POST /api/recommendations/chat` | Read-only recommendation chat backed by local Claude Code |
| `POST /api/recommendations/chat/stream` | SSE recommendation chat with server-lifetime Claude Code session context |
| `GET /api/sessions?since=...&project=...&limit=...` | Per-session breakdown sorted by cost |
| `GET /api/sessions/active?windowMs=...&limit=...` | Sessions active within a recent time window, sorted by last activity (default window 5 min, max 24 h; default limit 10, max 100) |
| `GET /api/sessions/:id` | Full detail for a single session: header totals, all-tool breakdown, per-turn rows |
| `GET /api/turns?since=...&limit=...&project=...` | Top expensive turns, default 10 and max 50 |
| `GET /api/health` | Readiness and index statistics |
| `GET /api/events` | SSE stream for file-watch updates |

## Dashboard Pages

| Route | Description |
| --- | --- |
| `/` | Overview — spend hero, KPI cards, activity heatmap, model mix |
| `/report` | Full session list with project name, top tools, and pagination |
| `/report/$sessionId` | Per-session detail — Overview / Tools / Turns tabs |

## Active Sessions Rail

A collapsible live-session panel is fixed at the top-right of every page on
`lg` and wider viewports. It calls `GET /api/sessions/active` with a 5-minute
window and a limit of 10, polling via TanStack Query's background refresh. The
window size is controlled by the `ACTIVE_SESSION_WINDOW_MS` constant in
`apps/web/src/lib/activeSessionConstants.ts`.

- **Collapsed**: a pill button showing a pulsing dot and the count of active
  sessions (or a muted label when none are active).
- **Expanded**: a dialog panel listing each active session with project name,
  short session ID, last-active time, per-session cost, turn count, and token
  count — each linking to the session detail page.
- The panel shows an error message when the endpoint is unreachable rather than
  silently falling back to the empty-state label.

## Development Notes

- The server binds to `127.0.0.1` only.
- The startup scan and file watcher index Claude Code, Codex, and local-model
  JSONL sources.
- Usage rows deduplicate by `(requestId, message.id)` when both identifiers are
  present for Claude Code. Codex rows deduplicate by session, timestamp, and
  cumulative token total. Local-model rows deduplicate by session, timestamp,
  model ID, and token totals.
- Daily and weekly buckets use system-local time, matching how users inspect
  coding-assistant activity by day.
- The dashboard intentionally avoids chat-content ingestion. Tool/file-touch
  policy is documented in `docs/adr/0002-tool-event-ingestion-and-files-touched-policy.md`.

## Local Model Tracking

Local models are indexed from `~/.tokenomix/local-models/**/*.jsonl`. Each line
can be:

- a normalized Tokenomix usage record with `timestamp`, `runtime`, `session_id`,
  `cwd`, `model`, `usage.input_tokens`, and `usage.output_tokens`;
- a final Ollama response chunk with `created_at`, `model`,
  `prompt_eval_count`, `eval_count`, and nanosecond duration fields; or
- an LM Studio response with `model`, `stats.input_tokens`,
  `stats.total_output_tokens`, `stats.tokens_per_second`, and
  `stats.time_to_first_token_seconds`.
- an OpenAI-compatible response with numeric `created`, `model`, and
  `usage.prompt_tokens` / `usage.completion_tokens`. Cached-token details are
  read from `usage.prompt_tokens_details.cached_tokens` when present.
- an OpenCode-style `step_finish` JSONL event when the line includes a model ID
  plus `part.tokens.input` and `part.tokens.output`.

Useful normalized fields include `cached_input_tokens`, `duration_ms`,
`time_to_first_token_ms`, `prompt_eval_duration_ms`, `eval_duration_ms`,
`load_duration_ms`, `tokens_per_second`, `tool_uses`, and `tool_errors`.

If the runtime does not emit usage, tokenomix can only estimate usage by running
model-specific tokenizers over prompts and responses. That is possible for
families such as Gemma and Qwen when their tokenizer is available locally, but
it has two tradeoffs: it requires reading prompt/response text, and counts can
drift from the serving runtime when chat templates, system prompts, tool
schemas, image inputs, or speculative decoding differ from the tokenizer pass.
The safer design is to ingest runtime usage logs first and add tokenizer
fallbacks only as an explicit opt-in.

## Watcher Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TOKENOMIX_WATCHER_POLLING` | unset | When set to `1`, switches chokidar from FSEvents (macOS) / inotify (Linux) to `usePolling: true` with a 1-second interval. Useful for network mounts, VMs, or hosts where FSEvents queue overflow has been observed after long uptimes. |

## Admin Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /api/admin/rescan` | Forces an immediate mtime-based rescan of all known JSONL files without restarting the server. Requires `X-Tokenomix-Local-Action: 1` and returns `{ ok: true, ts: <unix-ms> }`. |

The server binds to `127.0.0.1` only. State-changing local endpoints require `X-Tokenomix-Local-Action: 1` so blind cross-site localhost POSTs cannot trigger local actions.

Example:

```bash
curl -X POST -H 'X-Tokenomix-Local-Action: 1' http://localhost:3001/api/admin/rescan
```

The port may differ if `PORT_BASE` is set; the API server always runs on `PORT_BASE + 1`.
