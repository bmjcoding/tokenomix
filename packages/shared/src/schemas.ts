/**
 * Zod schemas for parsing raw Claude Code JSONL records.
 *
 * RawUsageEventSchema validates one line from a .jsonl session file.
 * RawUsageSchema validates the `message.usage` sub-object.
 *
 * Both schemas use .passthrough() so that forward-compatible fields added in
 * future Claude Code versions do not cause parse failures.
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
    /** "standard" | "batch" — affects pricing multiplier. */
    service_tier: z.string().optional(),
    /** "standard" | "fast" — affects pricing multiplier when model supports it. */
    speed: z.string().optional(),
    /** "us" | "not_available" | "" — affects US-only inference multiplier. */
    inference_geo: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// RawUsageEventSchema — one JSONL line
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single line parsed from a Claude Code session .jsonl file.
 *
 * Only records where `type == "assistant"` and `message.usage` is present
 * are relevant for cost computation — the server/parser filters on those
 * conditions before calling computeCost.
 *
 * The `message.content` array is intentionally excluded from this schema
 * (and must not be stored) since it can contain user data.
 */
export const RawUsageEventSchema = z
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
        usage: RawUsageSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Inferred TypeScript types from schemas
// ---------------------------------------------------------------------------

export type CacheCreationParsed = z.infer<typeof CacheCreationSchema>;
export type ServerToolUseParsed = z.infer<typeof ServerToolUseSchema>;
export type RawUsageParsed = z.infer<typeof RawUsageSchema>;
export type RawUsageEventParsed = z.infer<typeof RawUsageEventSchema>;
