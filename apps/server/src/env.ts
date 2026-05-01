/**
 * Startup environment variable validation for the tokenomix server.
 *
 * Parses and validates all TOKENOMIX_* variables and PORT_BASE using Zod.
 * Import `serverEnv` from this module to access validated values.
 *
 * Call `validateEnv()` once at server startup before constructing any service
 * that reads process.env. On validation failure it returns a Zod error object;
 * the caller must log it and exit non-zero.
 *
 * Design choices:
 * - z.coerce.number() for numeric fields so string inputs ("3000") coerce cleanly.
 * - z.enum() for constrained string fields so invalid values are caught at startup.
 * - z.preprocess() for flag-style booleans ("1", "true", "yes") to normalise the
 *   heterogeneous patterns already present in the codebase.
 * - Optional fields use .optional() with .default() so serverEnv values always have
 *   a concrete type (no undefined leakage).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared string helpers
// ---------------------------------------------------------------------------

/**
 * Accept the bare flag-strings used for boolean env vars: "1", "true", "yes".
 * Anything else (including unset / empty) is treated as false.
 */
function coerceFlagBool(value: unknown): boolean {
  const s = String(value ?? '')
    .toLowerCase()
    .trim();
  return s === '1' || s === 'true' || s === 'yes';
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const ServerEnvSchema = z.object({
  // ---- Port ----------------------------------------------------------------
  PORT_BASE: z.coerce
    .number()
    .int()
    .min(1)
    .max(65534)
    .default(3000)
    .describe('Base port; server listens on PORT_BASE + 1 (default 3001).'),

  // ---- Pricing provider ----------------------------------------------------
  TOKENOMIX_PRICING_PROVIDER: z
    .enum(['anthropic_1p', 'aws_bedrock', 'internal_gateway'])
    .default('anthropic_1p')
    .describe('Pricing model to use for cost computation.'),

  // ---- Bedrock settings (only relevant when PRICING_PROVIDER = aws_bedrock) -
  TOKENOMIX_BEDROCK_REGION: z
    .string()
    .optional()
    .describe('AWS region for Bedrock pricing calculations (e.g. us-east-1).'),

  TOKENOMIX_BEDROCK_ENDPOINT_SCOPE: z
    .enum(['in_region', 'global_cross_region', 'geographic_cross_region', 'unknown'])
    .default('unknown')
    .describe('Bedrock cross-region endpoint scope for latency-based pricing.'),

  TOKENOMIX_BEDROCK_SERVICE_TIER: z
    .enum(['standard', 'batch', 'provisioned', 'reserved', 'unknown'])
    .default('standard')
    .describe('Bedrock service tier that affects pricing multiplier.'),

  // ---- Debug / observability -----------------------------------------------
  TOKENOMIX_DEBUG: z
    .preprocess(coerceFlagBool, z.boolean())
    .default(false)
    .describe('Set to "1" to enable debug-level log output.'),

  // ---- File watcher --------------------------------------------------------
  TOKENOMIX_WATCHER_FSEVENTS: z
    .preprocess(coerceFlagBool, z.boolean())
    .default(false)
    .describe(
      'Set to "1" to use FSEvents (macOS) instead of polling. Default is polling (more compatible).'
    ),

  // ---- Claude subprocess ---------------------------------------------------
  TOKENOMIX_CLAUDE_COMMAND: z
    .string()
    .optional()
    .describe(
      'Absolute path or plain basename of the Claude executable. ' +
        'Auto-detected from ~/.local/bin/claude or PATH when unset.'
    ),

  TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(60_000)
    .describe('Maximum milliseconds to wait for a Claude subprocess response (default 60000).'),

  TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/, {
      message:
        'Must be a non-negative decimal number without currency symbol (e.g. "0.15" or "1").',
    })
    .default('0.15')
    .describe('Maximum spend budget per Claude chat request in USD (e.g. "0.15").'),

  TOKENOMIX_CLAUDE_CHAT_MODEL: z
    .string()
    .max(100, { message: 'Model identifier must be 100 characters or fewer.' })
    .transform((s) => s.trim() || 'sonnet')
    .default('sonnet')
    .describe(
      'Claude model alias or full model ID to use for chatbot requests (default "sonnet").'
    ),

  // ---- Store size limits ---------------------------------------------------
  TOKENOMIX_MAX_FILE_AUDITS: z.coerce
    .number()
    .int()
    .min(1)
    .default(10_000)
    .describe('Maximum number of file-ingestion audit entries retained in memory (default 10000).'),

  TOKENOMIX_MAX_AGENT_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .default(20_000)
    .describe('Maximum number of agent-ID map entries retained in memory (default 20000).'),

  TOKENOMIX_CLAUDE_CHAT_EFFORT: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe(
      'Effort level hint passed as --effort to the Claude subprocess. Omit to use the model default.'
    ),

  TOKENOMIX_CLAUDE_CHAT_BARE: z
    .preprocess(coerceFlagBool, z.boolean())
    .default(false)
    .describe('Set to "1" to run Claude without the built-in system prompt (bare / raw mode).'),
});

// ---------------------------------------------------------------------------
// Internal inferred type
// ---------------------------------------------------------------------------

type ServerEnv = z.infer<typeof ServerEnvSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Parse and validate the current process.env against the server env schema.
 *
 * Returns `{ success: true, env }` when all required fields are present and
 * all constraints are satisfied.
 *
 * Returns `{ success: false, error }` when validation fails. The caller should
 * log the error and call `process.exit(1)`.
 *
 * Note: TOKENOMIX_CLAUDE_CHAT_EFFORT normalisation (lowercase trim) mirrors the
 * existing normalizeClaudeEffort() in recommendations-chat.ts. Zod processes the
 * raw string value; the existing runtime normalizer remains for call-site reads
 * that do not yet import serverEnv — validation only ensures the value is one of
 * the permitted enum members if it is provided.
 */
export function validateEnv(
  env: NodeJS.ProcessEnv = process.env
): { success: true; env: ServerEnv } | { success: false; error: z.ZodError } {
  // Normalise TOKENOMIX_CLAUDE_CHAT_EFFORT to lowercase before parsing so the
  // enum comparison succeeds regardless of operator casing (e.g. "HIGH" → "high").
  const input: Record<string, string | undefined> = { ...env };
  if (typeof input.TOKENOMIX_CLAUDE_CHAT_EFFORT === 'string') {
    input.TOKENOMIX_CLAUDE_CHAT_EFFORT = input.TOKENOMIX_CLAUDE_CHAT_EFFORT.trim().toLowerCase();
  }

  const result = ServerEnvSchema.safeParse(input);
  if (result.success) {
    return { success: true, env: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validated server environment.
 *
 * This is populated by the first successful call to `validateEnv()` in index.ts.
 * Other modules may import this after startup validation completes.
 *
 * IMPORTANT: this module-level variable is `undefined` until `initServerEnv()`
 * is called. All production code paths that read it run after `main()` has
 * validated the env, so it is safe to non-null assert in those contexts.
 */
let _serverEnv: ServerEnv | undefined;

/** Called once at startup by index.ts after successful validation. */
export function initServerEnv(env: ServerEnv): void {
  _serverEnv = env;
}

/**
 * Returns the validated environment object.
 * Throws if called before `initServerEnv()` (i.e., before startup validation).
 */
export function serverEnv(): ServerEnv {
  if (_serverEnv === undefined) {
    throw new Error('serverEnv() called before initServerEnv(). Call validateEnv() at startup.');
  }
  return _serverEnv;
}
