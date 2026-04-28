# 0003 — Two-Pass JSONL Ingest for Tool-Event Ordering

Date: 2026-04-28

## Status

Accepted

## Context

The single-pass ingest in `ingestFileInternal()` processed each JSONL line as
it was read and immediately built a `TokenRow` when it encountered an `assistant`
event. Tool analytics (`toolUses`, `toolErrors`, `filesTouched`) were merged
inline from the preceding lines.

Claude Code does not guarantee that `tool_use` and `tool_result` events appear
before their corresponding `assistant` event in the JSONL stream. In practice,
tool events frequently appear after the assistant event in newer session files,
causing the inline merge to miss them. The result was an empty Tool Use Breakdown
panel despite populated session data.

Two constraints shaped the solution:

1. **Memory bound** — session files can grow to hundreds of MB. Buffering all
   lines in an array to enable random access would trade bounded file-descriptor
   usage for unbounded heap growth, which is the wrong trade-off for a local
   in-process server.
2. **Simplicity** — a two-file or streaming-rewind approach adds complexity
   without benefit; the file is already on local disk and reopening it is cheap.

## Decision

Replace single-pass ingest with two sequential readline passes over the same
file path:

- **Pass 1** streams the file and accumulates all `tool_use`, `tool_result`,
  and `system/turn_duration` events into `requestId`-keyed in-memory maps
  (`toolAccumulator`, `errorAccumulator`, `durationAccumulator`). The pass
  completes (the `for await` loop exhausts) before pass 2 begins.
- **Pass 2** streams the same file again. For each `assistant` event, a
  `TokenRow` is built and then merged with the fully-populated accumulators
  from pass 1 via `requestId` lookup.

Pass 1 accumulators are scoped to `ingestFileInternal()` and are discarded
when the function returns.

## Consequences

**Easier**

- Tool events arriving in any order relative to the assistant event are
  correctly merged; the ordering constraint is eliminated.
- The accumulators are O(distinct requestIds with tool events) in peak memory,
  not O(all lines in the file). For typical session files this is a small
  constant number of active request IDs.
- The dedup key (`requestId:messageId`) continues to prevent double-counting
  when the file-watcher re-ingests a file after a new line is appended.

**Harder / Risks**

- The file is opened twice per ingest call, increasing fd pressure slightly.
  The existing batch-parallel startup scan (50 files per batch) already caps
  concurrent fd usage; this adds one sequential fd pair per file.
- A known race window exists between pass 1 and pass 2: if Claude Code appends
  a line while the two passes are executing, pass 2 may see a line that pass 1
  did not. The file-watcher self-heals this on the next change event. A comment
  in `ingestFileInternal()` documents this explicitly.
- The `requestId`-keyed accumulator assigns the same tool data to all assistant
  events sharing a `requestId` but having different `messageId` values. Claude
  Code does not emit multiple assistant events per `requestId` in practice;
  this invariant is undocumented in the JSONL format but holds across all
  observed live data.

## Alternatives considered

**Single-pass with deferred row construction** — buffer all `assistant` events
encountered before pass 1 completes, then merge tool data after the file is
fully read. Rejected because it requires O(assistant events) heap storage and
adds complexity without improving the ordering problem.

**In-memory line array** — read all lines into a `string[]` and process twice
over the array. Rejected for the same memory reason as deferred row
construction; this approach converts the problem from disk I/O to heap
allocation without any gain.

**Sort events by timestamp before processing** — parse all events, sort by
`timestamp`, then do a single-pass merge. Rejected because it requires
O(all events) memory and introduces timestamp-ordering assumptions that the
JSONL format does not guarantee.

## References

- `apps/server/src/index-store.ts` — `ingestFileInternal()` implementation
- ADR 0002 (`docs/adr/0002-tool-event-ingestion-and-files-touched-policy.md`) —
  tool-event privacy policy that governs what data the passes may capture
