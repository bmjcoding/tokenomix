# 0002 — Tool Event Ingestion and Files-Touched Policy

Date: 2026-04-28

## Status

Accepted

## Context

Tokenomix previously filtered out `tool_use` and `tool_result` events at parse
time and excluded `message.content` from the Zod schema. This kept the in-memory
store narrow: one `TokenRow` per assistant turn, cost/token fields only.

Seven new analytics surfaces (Tools breakdown, Subagent leaderboard, Active vs
idle time, Files-touched count, Cost-per-turn, Tool error rate, Top expensive
turns) require data that is only available in those previously-discarded events:

- Per-tool invocation counts and error rates → `tool_use` / `tool_result`
- Turn wall-clock duration → `system/turn_duration`
- Unique file paths read or written per session → `tool_use.input.file_path`

Ingesting these events without a clear privacy policy would be inconsistent with
the local-only, no-telemetry stance established in ADR 0001.

## Decision

1. The Zod schema (`packages/shared/src/schemas.ts`) accepts `tool_use`,
   `tool_result`, and `system/turn_duration` events alongside the existing
   `assistant` + `usage` events.

2. From `tool_use.input`, **only the `file_path` field** (a scalar string) is
   captured. All other input fields — Bash command strings, Grep patterns, Write
   file contents, message body, etc. — are stripped by the schema and are never
   stored or logged.

3. The captured `file_path` is used exclusively for computing
   `totalFilesTouched` (unique-path cardinality over the active window). The
   initial ship **does not display the actual paths** in any dashboard panel.
   A future "top files" panel, if added, must be gated by a config flag that
   defaults to `false`.

4. `message.content` remains excluded from the schema. No chat content of any
   kind — user messages, assistant messages, tool input text — enters the index.

5. All accumulated data (`toolUses`, `toolErrors`, `filesTouched`,
   `turnDurationMs`) is held in RAM only, within the in-memory `IndexStore`. It
   is never written to disk and is lost on server restart.

6. The index store remains bound to `127.0.0.1`. The JSONL files indexed are
   exclusively the user's own Claude Code logs at `~/.claude/projects/`.

## Consequences

**Positive**

- Tools breakdown, subagent leaderboard, active/idle time, files-touched count,
  cost-per-turn, tool error rate, and top expensive turns panels are now
  implementable without additional data collection beyond what is described here.
- The privacy boundary is explicit, auditable, and enforced at the schema layer
  rather than by convention.

**Negative / Risks**

- Index size grows modestly: each `TokenRow` gains up to four optional fields
  (`toolUses`, `toolErrors`, `filesTouched`, `turnDurationMs`). Estimated
  additional RAM: a small fraction of the session token volume, well under 1 MB
  for typical local corpora.
- **File path privacy risk**: `file_path` values are local filesystem paths
  (e.g. `/Users/alice/work/secret-project/config.ts`). They can reveal project
  names, directory structure, and personal path components. Mitigation: the
  dashboard is local-only, serves only the owner's data, and never transmits
  paths off-device. The paths are not displayed in the initial ship.
- Scratch accumulators (`toolAccumulator`, `errorAccumulator`,
  `durationAccumulator`) must be bounded: they are keyed by `requestId` and
  must be purged immediately after the corresponding `TokenRow` is built to
  prevent unbounded growth across large corpora.

## Alternatives considered

- **Hash `file_path` on ingest** — rejected because the only current use is
  cardinality (unique count). Hashing would complicate the code with no
  privacy benefit at this use-case level; if a "top files" panel is later
  added, hashing would need to be revisited anyway.
- **Omit `file_path` entirely; rely on tool invocation count alone** —
  rejected because `totalFilesTouched` (unique paths) is a materially more
  informative metric than raw Read/Write/Edit invocation count. A file touched
  100 times counts once toward the unique total.
- **User opt-in toggle for tool-event ingestion** — deferred rather than
  rejected. The current data is local-only and no more sensitive than the
  session metadata already collected. An opt-out knob is a reasonable future
  addition if the "top files" panel ships.

## References

- `packages/shared/src/schemas.ts` — schema enforcement point; strips all
  `tool_use.input` fields except `file_path`
- `apps/server/src/index-store.ts` — ingest logic; scratch-map lifecycle and
  `TokenRow` merge
- ADR 0001 (`docs/adr/0001-typescript-dashboard.md`) — establishes the
  privacy-first, local-only posture this decision extends
