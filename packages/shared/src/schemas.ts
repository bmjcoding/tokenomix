/**
 * Zod schemas for parsing raw Claude Code JSONL records.
 *
 * RawUsageEventSchema validates one line from a .jsonl session file.
 * RawUsageSchema validates the `message.usage` sub-object.
 *
 * Both schemas use .passthrough() for forward compatibility with fields added
 * in future Claude Code versions.
 *
 * Schema union strategy: z.union([AssistantEventSchema, ToolUseEventSchema, ...])
 * with the assistant schema first. All event schemas use z.literal() for their
 * `type` discriminant enabling correct TypeScript union narrowing in the store.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// CacheCreation sub-schema (v2.1.100+)
// ---------------------------------------------------------------------------

export const CacheCreationSchema = z
  .object({
    ephemeral_5m_input_tokens: z.number().int().nonnegative().default(0),
    ephemeral_1h_input_tokens: z.number().int().nonnegative().default(0),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// ServerToolUse sub-schema (v2.1.100+)
// ---------------------------------------------------------------------------

export const ServerToolUseSchema = z
  .object({
    web_search_requests: z.number().int().nonnegative().default(0),
    web_fetch_requests: z.number().int().nonnegative().default(0),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// RawUsageSchema — the message.usage block
// ---------------------------------------------------------------------------

/**
 * Zod schema for the `message.usage` block inside a JSONL assistant record.
 *
 * Optional fields reflect version differences:
 *   - v2.1.86–v2.1.99: only the four core token fields + service_tier + inference_geo
 *   - v2.1.100+: adds server_tool_use, cache_creation, speed, iterations
 *
 * All optional numeric fields default to 0 so downstream code never deals with
 * undefined on the happy path.
 */
export const RawUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
    cache_creation_input_tokens: z.number().int().nonnegative().default(0),
    cache_read_input_tokens: z.number().int().nonnegative().default(0),
    /** Nested TTL-split cache creation (v2.1.100+). */
    cache_creation: CacheCreationSchema.optional(),
    /** Web and fetch request counts (v2.1.100+). */
    server_tool_use: ServerToolUseSchema.optional(),
    /** "standard" | "batch" — affects pricing multiplier. Null on API-error records. */
    service_tier: z.string().nullish(),
    /** "standard" | "fast" — affects pricing multiplier when model supports it. Null on API-error records. */
    speed: z.string().nullish(),
    /** "us" | "not_available" | "" — affects US-only inference multiplier. Null on API-error records. */
    inference_geo: z.string().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Message content sub-schemas
// ---------------------------------------------------------------------------

/**
 * Restricted tool input copied out of `message.content[]` tool_use blocks.
 *
 * PRIVACY INVARIANT: only scalar path-like fields are retained. Command
 * strings, grep patterns, prompts, file contents, and arbitrary tool inputs are
 * stripped here before the parser yields the event.
 */
export const ToolInputPathSchema = z
  .object({
    file_path: z.string().optional(),
    path: z.string().optional(),
    planFilePath: z.string().optional(),
  })
  .strip();

/** Stripped assistant content block for `tool_use` entries. */
export const ToolUseContentSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string().optional(),
    input: ToolInputPathSchema.optional().default({}),
  })
  .strip();

/** Stripped user content block for `tool_result` entries. */
export const ToolResultContentSchema = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().optional(),
    is_error: z.boolean().optional(),
  })
  .strip();

/**
 * Non-tool content is reduced to its block type. This preserves enough shape
 * to count text/thinking/image blocks in future diagnostics without retaining
 * user text, assistant text, screenshots, or tool output.
 */
const RedactedContentBlockSchema = z
  .object({
    type: z.string().optional(),
  })
  .strip();

export const MessageContentSchema = z.union([
  z.string(),
  z.array(z.union([ToolUseContentSchema, ToolResultContentSchema, RedactedContentBlockSchema])),
]);

// ---------------------------------------------------------------------------
// AssistantEventSchema — assistant turn with usage data (original schema)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single line parsed from a Claude Code session .jsonl file.
 *
 * Only records where `type == "assistant"` and `message.usage` is present
 * are relevant for cost computation — the server/parser filters on those
 * conditions before calling computeCost.
 *
 * The `message.content` array is accepted only through MessageContentSchema,
 * which preserves tool metadata and strips user/tool text payloads.
 *
 * Uses a broad z.string() for `type` so that RawUsageEventParsed (aliased to
 * AssistantEventParsed) remains backward compatible with the existing server
 * code that accesses `event.message?.usage` without narrowing. The union
 * RawUsageEventSchema uses this as its first branch for widest runtime coverage.
 */
export const AssistantEventSchema = z
  .object({
    type: z.string(),
    uuid: z.string().optional(),
    parentUuid: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    version: z.string().optional(),
    gitBranch: z.string().nullable().optional(),
    message: z
      .object({
        model: z.string().optional(),
        id: z.string().optional(),
        type: z.string().optional(),
        role: z.string().optional(),
        stop_reason: z.string().nullable().optional(),
        content: MessageContentSchema.optional(),
        usage: RawUsageSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// ToolUseEventSchema — tool invocation event
// ---------------------------------------------------------------------------

/**
 * Zod schema for a `tool_use` event in the JSONL stream.
 *
 * PRIVACY INVARIANT: Only scalar path-like fields are extracted from the
 * tool input object. No command text, search patterns, file contents, or tool
 * outputs are captured or stored. This is the enforcement point of the
 * project's tool-event ingestion privacy policy (see docs/adr/0002-*).
 *
 * Using z.object(...) with NO .passthrough() on the input sub-object
 * intentionally strips all other input fields during parse. This prevents
 * accidental persistence of command arguments, file contents, search queries,
 * or other potentially sensitive tool parameters.
 */
export const ToolUseEventSchema = z
  .object({
    type: z.literal('tool_use'),
    uuid: z.string().optional(),
    parentUuid: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    /** Tool name as emitted by Claude Code (e.g. "Bash", "Read", "Write", "Edit"). */
    toolName: z.string(),
    /**
     * Restricted tool input: only path-like scalar fields are captured.
     * All other input fields are intentionally stripped at parse time.
     * Do NOT add .passthrough() here: that would allow arbitrary input fields
     * through and violate the privacy invariant.
     */
    input: z.object({
      file_path: z.string().optional(),
      path: z.string().optional(),
      planFilePath: z.string().optional(),
    }),
  })
  // Outer .passthrough() is safe — extra top-level event fields (uuid, parentUuid,
  // gitBranch, etc.) are never persisted. The privacy invariant lives on `input`
  // (no .passthrough() above), which strips all non-path keys at parse time.
  .passthrough();

// ---------------------------------------------------------------------------
// ToolResultEventSchema — tool result / error event
// ---------------------------------------------------------------------------

/**
 * Zod schema for a `tool_result` event in the JSONL stream.
 *
 * The `is_error` flag is the only field of interest beyond the linking IDs.
 * Tool result content (output text, error messages) is intentionally excluded.
 */
export const ToolResultEventSchema = z
  .object({
    type: z.literal('tool_result'),
    uuid: z.string().optional(),
    parentUuid: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    /** Matches the uuid of the preceding tool_use event this result belongs to. */
    tool_use_id: z.string(),
    /**
     * true when the tool invocation produced an error, false or absent on success.
     * Maps to TokenRow.toolErrors accumulation in index-store.
     */
    is_error: z.boolean().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// SystemTurnDurationSchema — system-emitted turn timing event
// ---------------------------------------------------------------------------

/**
 * Zod schema for a `system` event with `subtype: "turn_duration"`.
 *
 * These events are emitted by Claude Code after each assistant turn to record
 * how long the model took to respond. The `durationMs` field is mapped to
 * TokenRow.turnDurationMs in index-store.
 *
 * Schema accepts top-level `durationMs` (i.e., `{ type: "system", subtype:
 * "turn_duration", durationMs: 1234 }`). Verified against the JSONL fixture
 * emitted by Claude Code — this field shape matches production logs. If the
 * actual JSONL ever nests durationMs under a `data` sub-object, this schema
 * will silently no-op (the store will find durationMs undefined and skip the
 * event) until this schema and the corresponding extraction in
 * ingestFileInternal are updated.
 */
export const SystemTurnDurationSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('turn_duration'),
    uuid: z.string().optional(),
    parentUuid: z.string().nullable().optional(),
    requestId: z.string().optional(),
    timestamp: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    /** Turn duration in milliseconds. Must be non-negative. */
    durationMs: z.number().nonnegative(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// SubhourlyBucketSchema — 30-minute sub-hourly bucket (API response shape)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single 30-minute sub-hourly bucket in MetricSummary.subhourlySeries.
 *
 * timestamp is a UTC ISO-8601 string representing the bucket's start at a
 * 30-minute boundary (e.g. '2026-04-30T14:30:00.000Z').
 *
 * cacheCreationTokens covers both 5-minute and 1-hour cache-creation tokens
 * combined, following the same convention as the DailyBucket fields.
 */
export const SubhourlyBucketSchema = z.object({
  timestamp: z.string(),
  costUsd: z.number(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// RawUsageEventSchema — union of all known event types
// ---------------------------------------------------------------------------

/**
 * Union schema accepting all known JSONL event types.
 *
 * All four branches use z.literal() for their `type` discriminant, making this
 * a correctly-typed union. z.discriminatedUnion is NOT used because
 * SystemTurnDurationSchema has both `type: "system"` and `subtype: "turn_duration"`,
 * and future system event subtypes may reuse the "system" type literal — a plain
 * z.union avoids potential ambiguity at the cost of slightly slower validation.
 *
 * Order: exact structured event types first, then the broad assistant/user
 * compatibility schema. The broad schema accepts any string `type`, so it must
 * come last or it would bypass input stripping for top-level tool events.
 *
 * Events with unknown types (human, summary, etc.) will not match any branch
 * and will produce a schema-mismatch log entry in the parser. Those event
 * types carry no data the store needs, so the warning is intentional.
 */
export const RawUsageEventSchema = z.union([
  ToolUseEventSchema,
  ToolResultEventSchema,
  SystemTurnDurationSchema,
  AssistantEventSchema,
]);

// ---------------------------------------------------------------------------
// Inferred TypeScript types from schemas
// ---------------------------------------------------------------------------

export type CacheCreationParsed = z.infer<typeof CacheCreationSchema>;
export type ServerToolUseParsed = z.infer<typeof ServerToolUseSchema>;
export type RawUsageParsed = z.infer<typeof RawUsageSchema>;

/** Inferred type of a validated assistant-event line (original schema). */
export type AssistantEventParsed = z.infer<typeof AssistantEventSchema>;

/** Inferred type of a validated tool_use event line. */
export type ToolUseEventParsed = z.infer<typeof ToolUseEventSchema>;

/** Inferred type of a validated tool_result event line. */
export type ToolResultEventParsed = z.infer<typeof ToolResultEventSchema>;

/** Inferred type of a stripped message.content[] tool_use block. */
export type ToolUseContentParsed = z.infer<typeof ToolUseContentSchema>;

/** Inferred type of a stripped message.content[] tool_result block. */
export type ToolResultContentParsed = z.infer<typeof ToolResultContentSchema>;

/** Inferred type of a validated system/turn_duration event line. */
export type SystemTurnDurationEventParsed = z.infer<typeof SystemTurnDurationSchema>;

/**
 * Parsed type for JSONL events yielded by parseJSONLFile.
 *
 * Aliased to AssistantEventParsed (the original broad schema) for backward
 * compatibility: the existing server code accesses `event.message?.usage`
 * without first narrowing by type, and TypeScript needs the `message` field
 * to be present on this type.
 *
 * At runtime, RawUsageEventSchema is a union that also validates tool_use,
 * tool_result, and system/turn_duration events — those parsed values are
 * structurally compatible with AssistantEventParsed (which uses .passthrough()
 * and z.string() for type). Downstream code in index-store that needs to
 * branch on the new event types should cast via `as unknown as ToolUseEventParsed`
 * after a `event.type === 'tool_use'` type guard.
 *
 * This design preserves zero changes to parser.ts and the existing ingest
 * filter chain while exposing all new event schemas for T-002 and T-003.
 */
export type RawUsageEventParsed = AssistantEventParsed;
