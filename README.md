# tokenomix

Interactive TypeScript dashboard for Claude Code token usage. The server reads
Claude Code JSONL session logs from `~/.claude/projects`, prices usage locally,
and serves a localhost-only API consumed by the Vite/React dashboard.

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
- Data source: `~/.claude/projects/**/*.jsonl`

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
corepack pnpm@10.33.0 verify:pricing
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
TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD=0.05
TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS=60000
TOKENOMIX_CLAUDE_CHAT_EFFORT=low
TOKENOMIX_CLAUDE_CHAT_BARE=0
corepack pnpm@10.33.0 dev
```

The chat route runs Claude Code in print mode with tools disabled, a bounded
turn count, and the configured budget cap. Streamed turns use deterministic
retrieval over the existing in-memory index from `~/.claude/projects`: global
optimization context for the initial seed, then targeted project/session/turn
context for follow-up questions. Follow-up streamed turns resume the same
server-process Claude Code session until the server is stopped.

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

## Development Notes

- The server binds to `127.0.0.1` only.
- The startup scan and file watcher index `~/.claude/projects/**/*.jsonl`.
- Usage rows deduplicate by `(requestId, message.id)` when both identifiers are
  present.
- Daily and weekly buckets use system-local time, matching how users inspect
  Claude Code activity by day.
- The dashboard intentionally avoids chat-content ingestion. Tool/file-touch
  policy is documented in `docs/adr/0002-tool-event-ingestion-and-files-touched-policy.md`.

## Watcher Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TOKENOMIX_WATCHER_POLLING` | unset | When set to `1`, switches chokidar from FSEvents (macOS) / inotify (Linux) to `usePolling: true` with a 1-second interval. Useful for network mounts, VMs, or hosts where FSEvents queue overflow has been observed after long uptimes. |

## Admin Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /api/admin/rescan` | Forces an immediate mtime-based rescan of all known JSONL files without restarting the server. Returns `{ ok: true, ts: <unix-ms> }`. |

The server binds to `127.0.0.1` only; no authentication is required for admin endpoints.

Example:

```bash
curl -X POST http://localhost:3001/api/admin/rescan
```

The port may differ if `PORT_BASE` is set; the API server always runs on `PORT_BASE + 1`.
