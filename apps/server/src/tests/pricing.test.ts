/**
 * Server-side pricing bridge tests.
 *
 * These tests verify the locked arithmetic values from tests/test_tokenomix.py
 * lines 237-265, using the shared module re-exported via apps/server/src/pricing.ts.
 *
 * Locked values:
 *   - Opus 4.7 event (1k input + 500 output + 100k cache_read) = $0.0675
 *   - Combined sonnet total across three events = $0.10 (rounded to 2dp)
 */

import type { TokenRow } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import {
  MODEL_PRICES,
  WEB_SEARCH_USD_PER_REQUEST,
  computeCost,
  costForRow,
  model_family,
  resolveCacheTokens,
} from '../pricing.js';

// ---------------------------------------------------------------------------
// Locked value 1: Opus 4.7 event
// $0.005 + $0.0125 + $0.05 = $0.0675
// ---------------------------------------------------------------------------

describe('opus 4.7 locked cost', () => {
  it('1k input + 500 output + 100k cache_read = $0.0675', () => {
    const cost = computeCost(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
      },
      'claude-opus-4-7'
    );
    expect(cost).toBeCloseTo(0.0675, 10);
  });

  it('model_family("claude-opus-4-7") is "opus"', () => {
    expect(model_family('claude-opus-4-7')).toBe('opus');
  });

  it('MODEL_PRICES.opus has correct rates', () => {
    const p = MODEL_PRICES.opus;
    expect(p).toBeDefined();
    expect(p?.input).toBe(5.0);
    expect(p?.output).toBe(25.0);
    expect(p?.cache_read).toBe(0.5);
    expect(p?.cache_creation_5m).toBe(6.25);
    expect(p?.cache_creation_1h).toBe(10.0);
  });
});

// ---------------------------------------------------------------------------
// Locked value 2: Combined sonnet total across 3 events = $0.10
//
// Event 1: 2k input + 1k output + 50k cache_read
//   2000 × $3/Mtok = $0.006
//   1000 × $15/Mtok = $0.015
//   50000 × $0.30/Mtok = $0.015
//   → $0.036
//
// Event 2: 10k top-level cache_creation + 2 web searches
//   10000 × $3.75/Mtok = $0.0375
//   2 × $0.01 = $0.02
//   → $0.0575
//
// Event 3 subagent: 100 input + 50 output + 5k cache_read
//   100 × $3/Mtok = $0.0003
//   50 × $15/Mtok = $0.00075
//   5000 × $0.30/Mtok = $0.0015
//   → $0.00255
//
// Grand total: $0.036 + $0.0575 + $0.00255 = $0.09605
// round(0.09605, 2) = $0.10
// ---------------------------------------------------------------------------

describe('combined sonnet locked cost', () => {
  it('event 1: 2k input + 1k output + 50k cache_read = $0.036', () => {
    const cost = computeCost(
      {
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 0,
      },
      'claude-sonnet-4-6'
    );
    expect(cost).toBeCloseTo(0.036, 10);
  });

  it('event 2: 10k top-level cache_creation + 2 web searches = $0.0575', () => {
    // No nested cache_creation → top-level treated as 5m tokens.
    const cost = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 10_000,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 2 },
      },
      'claude-sonnet-4-6'
    );
    expect(cost).toBeCloseTo(0.0575, 10);
  });

  it('event 3 subagent: 100 input + 50 output + 5k cache_read = $0.00255', () => {
    const cost = computeCost(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 0,
      },
      'claude-sonnet-4-6'
    );
    expect(cost).toBeCloseTo(0.00255, 10);
  });

  it('combined 3-event sonnet total rounds to $0.10', () => {
    const e1 = computeCost(
      { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 50_000 },
      'claude-sonnet-4-6'
    );
    const e2 = computeCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 10_000,
        server_tool_use: { web_search_requests: 2 },
      },
      'claude-sonnet-4-6'
    );
    const e3 = computeCost(
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5_000 },
      'claude-sonnet-4-6'
    );
    const total = e1 + e2 + e3;
    expect(Math.round(total * 100) / 100).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// costForRow helper
// ---------------------------------------------------------------------------

describe('costForRow', () => {
  it('returns pre-computed costUsd from TokenRow', () => {
    const row: TokenRow = {
      date: '2026-04-27',
      hour: 12,
      sessionId: 'test-session',
      project: '/test/project',
      modelId: 'claude-opus-4-7',
      modelFamily: 'opus',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      cacheReadTokens: 100_000,
      webSearchRequests: 0,
      costUsd: 0.0675,
      isSubagent: false,
    };
    expect(costForRow(row)).toBe(0.0675);
  });
});

// ---------------------------------------------------------------------------
// WEB_SEARCH_USD_PER_REQUEST
// ---------------------------------------------------------------------------

describe('WEB_SEARCH_USD_PER_REQUEST', () => {
  it('equals $0.01', () => {
    expect(WEB_SEARCH_USD_PER_REQUEST).toBeCloseTo(0.01, 10);
  });
});

// ---------------------------------------------------------------------------
// resolveCacheTokens branching
// ---------------------------------------------------------------------------

describe('resolveCacheTokens', () => {
  it('nested values used when non-zero', () => {
    const { cache5m, cache1h } = resolveCacheTokens({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 10_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 5_000,
        ephemeral_1h_input_tokens: 3_000,
      },
    });
    expect(cache5m).toBe(5_000);
    expect(cache1h).toBe(3_000);
  });

  it('falls back to top-level when nested sum is zero', () => {
    const { cache5m, cache1h } = resolveCacheTokens({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 10_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    });
    expect(cache5m).toBe(10_000);
    expect(cache1h).toBe(0);
  });

  it('uses top-level as 5m when no nested object', () => {
    const { cache5m, cache1h } = resolveCacheTokens({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 7_500,
    });
    expect(cache5m).toBe(7_500);
    expect(cache1h).toBe(0);
  });
});
