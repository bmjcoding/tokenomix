/**
 * Server-side pricing bridge tests.
 *
 * These tests verify locked arithmetic values through the shared module
 * re-exported via apps/server/src/pricing.ts.
 *
 * Locked values:
 *   - Opus 4.7 event (1k input + 500 output + 100k cache_read) = $0.0675
 *   - Combined sonnet total across three events = $0.10 (rounded to 2dp)
 */

import type { TokenRow } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import {
  computeCost,
  computeCostWithFamily,
  costForRow,
  inferBedrockEndpointScope,
  isKnownPricingModelId,
  MODEL_PRICES,
  model_family,
  PRICING_CATALOG_METADATA,
  pricing_status_for_usage,
  resolveCacheTokens,
  WEB_SEARCH_USD_PER_REQUEST,
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

  it('legacy Anthropic model ID order maps claude-3-opus to legacy opus pricing', () => {
    expect(model_family('claude-3-opus-20240229')).toBe('opus_legacy');
    expect(model_family('claude-3-5-haiku-20241022')).toBe('haiku_3_5');
    expect(model_family('claude-3-7-sonnet-20250219')).toBe('sonnet');
    expect(model_family('claude-opus-4-20250514')).toBe('opus_legacy');
    expect(model_family('claude-sonnet-4-20250514')).toBe('sonnet');
  });

  it('Bedrock Anthropic model IDs are normalized before model-family mapping', () => {
    expect(model_family('anthropic.claude-3-7-sonnet-20250219-v1:0')).toBe('sonnet');
    expect(model_family('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet');
    expect(model_family('global.anthropic.claude-opus-4-7-20260420-v1:0')).toBe('opus');
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
      projectName: 'project',
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

describe('pricing audit helpers', () => {
  it('computes micro-USD totals for locked Opus case', () => {
    const breakdown = computeCostWithFamily(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
      },
      'claude-opus-4-7',
      'opus'
    );
    expect(breakdown.totalCostUsdMicros).toBe(67_500);
    expect(breakdown.totalCostUsd).toBe(0.0675);
    expect(breakdown.pricingStatus).toBe('catalog');
  });

  it('flags billable unknown model IDs as Sonnet fallback estimates', () => {
    const usage = { input_tokens: 1000, output_tokens: 0 };
    expect(isKnownPricingModelId('claude-custom-model')).toBe(false);
    expect(pricing_status_for_usage('claude-custom-model', usage)).toBe('fallback_sonnet');

    const breakdown = computeCostWithFamily(usage, 'claude-custom-model', 'sonnet');
    expect(breakdown.totalCostUsdMicros).toBe(3000);
    expect(breakdown.pricingStatus).toBe('fallback_sonnet');
  });

  it('flags nested-only cache writes on unknown model IDs as billable fallback estimates', () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 0,
      },
    };

    expect(pricing_status_for_usage('claude-custom-model', usage)).toBe('fallback_sonnet');

    const breakdown = computeCostWithFamily(usage, 'claude-custom-model', 'sonnet');
    expect(breakdown.totalCostUsdMicros).toBe(3_750_000);
    expect(breakdown.totalCostUsd).toBe(3.75);
    expect(breakdown.pricingStatus).toBe('fallback_sonnet');
  });

  it('exposes versioned static catalog source metadata', () => {
    expect(PRICING_CATALOG_METADATA.sourceUrl).toBe(
      'https://platform.claude.com/docs/en/about-claude/pricing'
    );
    expect(PRICING_CATALOG_METADATA.precision).toBe('micro-usd');
    expect(PRICING_CATALOG_METADATA.pricingProvider).toBe('anthropic_1p');
    expect(PRICING_CATALOG_METADATA.costBasis).toBe(
      'estimated_from_jsonl_usage_static_anthropic_catalog'
    );
  });

  it('marks Bedrock catalog rows separately from Anthropic 1P catalog rows', () => {
    const breakdown = computeCostWithFamily(
      { input_tokens: 1000, output_tokens: 0 },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'sonnet',
      { pricingProvider: 'aws_bedrock' }
    );
    expect(breakdown.totalCostUsdMicros).toBe(3300);
    expect(breakdown.pricingStatus).toBe('bedrock_catalog');
  });

  it('applies Bedrock regional endpoint premium only for in-scope models and endpoint scopes', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };

    const global = computeCostWithFamily(
      usage,
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'sonnet',
      { pricingProvider: 'aws_bedrock', bedrockEndpointScope: 'global_cross_region' }
    );
    const geographic = computeCostWithFamily(
      usage,
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'sonnet',
      { pricingProvider: 'aws_bedrock', bedrockEndpointScope: 'geographic_cross_region' }
    );
    const inRegion = computeCostWithFamily(
      usage,
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'haiku',
      { pricingProvider: 'aws_bedrock', bedrockEndpointScope: 'in_region' }
    );
    const legacy = computeCostWithFamily(
      usage,
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'sonnet',
      { pricingProvider: 'aws_bedrock', bedrockEndpointScope: 'geographic_cross_region' }
    );

    expect(global.totalCostUsdMicros).toBe(3_000_000);
    expect(global.pricingMultiplier).toBe(1);
    expect(geographic.totalCostUsdMicros).toBe(3_300_000);
    expect(geographic.pricingMultiplier).toBe(1.1);
    expect(inRegion.totalCostUsdMicros).toBe(1_100_000);
    expect(inRegion.pricingMultiplier).toBe(1.1);
    expect(legacy.totalCostUsdMicros).toBe(3_000_000);
    expect(legacy.pricingMultiplier).toBe(1);
  });

  it('uses externally rated internal gateway cost when provided', () => {
    const breakdown = computeCostWithFamily(
      { input_tokens: 1000, output_tokens: 1000 },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'sonnet',
      {
        pricingProvider: 'internal_gateway',
        externallyRated: true,
        externalCostUsdMicros: 12_345,
      }
    );
    expect(breakdown.totalCostUsdMicros).toBe(12_345);
    expect(breakdown.totalCostUsd).toBe(0.012345);
    expect(breakdown.inputCostUsdMicros + breakdown.outputCostUsdMicros).toBe(12_345);
    expect(breakdown.inputCostUsdMicros).toBeGreaterThan(0);
    expect(breakdown.outputCostUsdMicros).toBeGreaterThan(0);
    expect(breakdown.pricingStatus).toBe('internal_gateway_rated');
  });

  it('marks internal gateway rows as estimates when no rated cost is provided', () => {
    const breakdown = computeCostWithFamily(
      { input_tokens: 1000, output_tokens: 0 },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'sonnet',
      { pricingProvider: 'internal_gateway' }
    );
    expect(breakdown.totalCostUsdMicros).toBe(3300);
    expect(breakdown.pricingStatus).toBe('internal_gateway_unrated_estimate');
  });

  it('infers Bedrock endpoint scope from Bedrock model ID prefixes', () => {
    expect(inferBedrockEndpointScope('global.anthropic.claude-sonnet-4-5-v1:0')).toBe(
      'global_cross_region'
    );
    expect(inferBedrockEndpointScope('us.anthropic.claude-sonnet-4-5-v1:0')).toBe(
      'geographic_cross_region'
    );
    expect(inferBedrockEndpointScope('anthropic.claude-sonnet-4-5-v1:0')).toBe('in_region');
  });
});

// ---------------------------------------------------------------------------
// resolveCacheTokens branching
//
// Live-data verification verdict (2026-04-28, 2489 JSONL files, 118k+ assistant
// events): resolveCacheTokens() correctly selects nested OR flat cache tokens
// exclusively — never both. The resolved total (413.5M all-time) equals the
// flat field sum and is less than half the naive flat+nested double-sum (827M),
// confirming no double-count. The 177M 30-day cache-creation figure shown on
// the dashboard is GENUINE cache-heavy usage, not an arithmetic artifact.
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

  it('both-zero: nested object present but all fields zero and flat also zero returns 0/0', () => {
    // Edge case: nested cache_creation object exists but every field is 0,
    // AND top-level cache_creation_input_tokens is also 0.
    // Expected: resolveCacheTokens falls into the nested-sum-zero branch,
    // but because topLevel is also 0 the fallback returns 0 for both.
    const { cache5m, cache1h } = resolveCacheTokens({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    });
    expect(cache5m).toBe(0);
    expect(cache1h).toBe(0);
  });
});
