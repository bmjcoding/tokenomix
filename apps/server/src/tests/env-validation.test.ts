/**
 * Smoke tests for the Zod-based startup environment validation (env.ts).
 *
 * Tests cover four scenarios:
 *   1. Valid env — all required constraints met → success with parsed values.
 *   2. Missing required field — PORT_BASE is optional (has a default), but
 *      TOKENOMIX_PRICING_PROVIDER enum rejects unknown strings. Tested as:
 *      a coerced numeric field with an unparseable value forces a failure path.
 *      We test an empty string for TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS (required
 *      positive integer after coerce — empty string coerces to NaN which fails
 *      the .int().min(1) constraint).
 *   3. Invalid enum — TOKENOMIX_PRICING_PROVIDER must be one of the three
 *      known values; an arbitrary string is rejected with a failure result.
 *   4. Negative timeout — TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS must be ≥ 1;
 *      a negative value is rejected.
 *
 * Note: validateEnv() accepts an optional env record argument so tests can
 * inject isolated env objects without mutating process.env.
 */

import { describe, expect, it } from 'vitest';
import { validateEnv } from '../env.js';

// ---------------------------------------------------------------------------
// Helper: extract field errors as a plain Record to avoid Zod v4 inferred-key
// TypeScript strictness issues (fieldErrors keys are inferred from the schema
// shape and may not be directly index-accessible in the narrowed type).
// ---------------------------------------------------------------------------

function fieldErrors(result: ReturnType<typeof validateEnv>): Record<string, string[] | undefined> {
  if (result.success) return {};
  return result.error.flatten().fieldErrors as Record<string, string[] | undefined>;
}

// ---------------------------------------------------------------------------
// Minimal valid env — only the fields that have no default need to be provided.
// All TOKENOMIX_* fields except TOKENOMIX_BEDROCK_REGION and
// TOKENOMIX_CLAUDE_COMMAND have defaults, so an empty record is enough to
// produce a successful parse with default values.
// ---------------------------------------------------------------------------

const MINIMAL_VALID_ENV: NodeJS.ProcessEnv = {};

// ---------------------------------------------------------------------------
// Test 1 — Valid env passes
// ---------------------------------------------------------------------------

describe('validateEnv — valid environment', () => {
  it('succeeds with an empty env object (all fields have defaults)', () => {
    const result = validateEnv(MINIMAL_VALID_ENV);

    expect(result.success).toBe(true);
    if (!result.success) return; // type narrowing

    // Verify a sample of default values are applied correctly.
    expect(result.env.PORT_BASE).toBe(3000);
    expect(result.env.TOKENOMIX_PRICING_PROVIDER).toBe('anthropic_1p');
    expect(result.env.TOKENOMIX_BEDROCK_ENDPOINT_SCOPE).toBe('unknown');
    expect(result.env.TOKENOMIX_BEDROCK_SERVICE_TIER).toBe('standard');
    expect(result.env.TOKENOMIX_DEBUG).toBe(false);
    expect(result.env.TOKENOMIX_WATCHER_FSEVENTS).toBe(false);
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBe(60_000);
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_BARE).toBe(false);
  });

  it('succeeds with explicit valid values for every field', () => {
    const env: NodeJS.ProcessEnv = {
      PORT_BASE: '4000',
      TOKENOMIX_PRICING_PROVIDER: 'aws_bedrock',
      TOKENOMIX_BEDROCK_REGION: 'us-west-2',
      TOKENOMIX_BEDROCK_ENDPOINT_SCOPE: 'in_region',
      TOKENOMIX_BEDROCK_SERVICE_TIER: 'batch',
      TOKENOMIX_DEBUG: '1',
      TOKENOMIX_WATCHER_FSEVENTS: 'true',
      TOKENOMIX_CLAUDE_COMMAND: '/usr/local/bin/claude',
      TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: '30000',
      TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: '0.25',
      TOKENOMIX_CLAUDE_CHAT_MODEL: 'claude-opus-4-5',
      TOKENOMIX_CLAUDE_CHAT_EFFORT: 'high',
      TOKENOMIX_CLAUDE_CHAT_BARE: 'yes',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.env.PORT_BASE).toBe(4000);
    expect(result.env.TOKENOMIX_PRICING_PROVIDER).toBe('aws_bedrock');
    expect(result.env.TOKENOMIX_BEDROCK_REGION).toBe('us-west-2');
    expect(result.env.TOKENOMIX_BEDROCK_ENDPOINT_SCOPE).toBe('in_region');
    expect(result.env.TOKENOMIX_BEDROCK_SERVICE_TIER).toBe('batch');
    expect(result.env.TOKENOMIX_DEBUG).toBe(true);
    expect(result.env.TOKENOMIX_WATCHER_FSEVENTS).toBe(true);
    expect(result.env.TOKENOMIX_CLAUDE_COMMAND).toBe('/usr/local/bin/claude');
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBe(30_000);
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD).toBe('0.25');
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_MODEL).toBe('claude-opus-4-5');
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_EFFORT).toBe('high');
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_BARE).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Missing / unparseable required field
// ---------------------------------------------------------------------------

describe('validateEnv — missing or unparseable required field', () => {
  it('fails when TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS is an empty string (coerces to NaN)', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: '',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    // ZodError must mention the failing field.
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBeDefined();
  });

  it('fails when PORT_BASE is an alphabetic string (cannot coerce to number)', () => {
    const env: NodeJS.ProcessEnv = {
      PORT_BASE: 'not-a-port',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).PORT_BASE).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Invalid enum value
// ---------------------------------------------------------------------------

describe('validateEnv — invalid enum value', () => {
  it('fails when TOKENOMIX_PRICING_PROVIDER is not one of the allowed values', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_PRICING_PROVIDER: 'openai',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_PRICING_PROVIDER).toBeDefined();
  });

  it('fails when TOKENOMIX_BEDROCK_ENDPOINT_SCOPE is an unknown value', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_BEDROCK_ENDPOINT_SCOPE: 'intergalactic',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_BEDROCK_ENDPOINT_SCOPE).toBeDefined();
  });

  it('fails when TOKENOMIX_CLAUDE_CHAT_EFFORT is not a known effort level', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_CLAUDE_CHAT_EFFORT: 'turbo',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_EFFORT).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Negative / non-positive numeric timeout
// ---------------------------------------------------------------------------

describe('validateEnv — negative or non-positive numeric timeout', () => {
  it('fails when TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS is negative', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: '-1',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBeDefined();
  });

  it('fails when TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS is zero (minimum is 1)', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: '0',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBeDefined();
  });

  it('fails when PORT_BASE is negative', () => {
    const env: NodeJS.ProcessEnv = {
      PORT_BASE: '-100',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).PORT_BASE).toBeDefined();
  });

  it('fails when PORT_BASE is a float (non-integer)', () => {
    const env: NodeJS.ProcessEnv = {
      PORT_BASE: '3000.5',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(false);
    expect(fieldErrors(result).PORT_BASE).toBeDefined();
  });

  it('succeeds when TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS is exactly 1 (minimum boundary)', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS: '1',
    };

    const result = validateEnv(env);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.env.TOKENOMIX_CLAUDE_CHAT_TIMEOUT_MS).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD regex validation
// ---------------------------------------------------------------------------

describe('validateEnv — TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD format', () => {
  it('succeeds with a plain integer budget string (e.g. "1")', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: '1' };
    const result = validateEnv(env);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD).toBe('1');
  });

  it('succeeds with a decimal budget string (e.g. "0.15")', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: '0.15' };
    const result = validateEnv(env);
    expect(result.success).toBe(true);
  });

  it('fails when budget includes a currency symbol (e.g. "$0.15")', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: '$0.15' };
    const result = validateEnv(env);
    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD).toBeDefined();
  });

  it('fails when budget is an empty string', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: '' };
    const result = validateEnv(env);
    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD).toBeDefined();
  });

  it('fails when budget is a non-numeric string (e.g. "max")', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD: 'max' };
    const result = validateEnv(env);
    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_CLAUDE_CHAT_MAX_BUDGET_USD).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — TOKENOMIX_MAX_FILE_AUDITS and TOKENOMIX_MAX_AGENT_ENTRIES
// ---------------------------------------------------------------------------

describe('validateEnv — store size limit env vars', () => {
  it('applies default values for TOKENOMIX_MAX_FILE_AUDITS and TOKENOMIX_MAX_AGENT_ENTRIES', () => {
    const result = validateEnv(MINIMAL_VALID_ENV);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.TOKENOMIX_MAX_FILE_AUDITS).toBe(10_000);
    expect(result.env.TOKENOMIX_MAX_AGENT_ENTRIES).toBe(20_000);
  });

  it('accepts explicit positive integer values', () => {
    const env: NodeJS.ProcessEnv = {
      TOKENOMIX_MAX_FILE_AUDITS: '5000',
      TOKENOMIX_MAX_AGENT_ENTRIES: '15000',
    };
    const result = validateEnv(env);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.env.TOKENOMIX_MAX_FILE_AUDITS).toBe(5_000);
    expect(result.env.TOKENOMIX_MAX_AGENT_ENTRIES).toBe(15_000);
  });

  it('fails when TOKENOMIX_MAX_FILE_AUDITS is zero', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_MAX_FILE_AUDITS: '0' };
    const result = validateEnv(env);
    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_MAX_FILE_AUDITS).toBeDefined();
  });

  it('fails when TOKENOMIX_MAX_AGENT_ENTRIES is negative', () => {
    const env: NodeJS.ProcessEnv = { TOKENOMIX_MAX_AGENT_ENTRIES: '-1' };
    const result = validateEnv(env);
    expect(result.success).toBe(false);
    expect(fieldErrors(result).TOKENOMIX_MAX_AGENT_ENTRIES).toBeDefined();
  });
});
