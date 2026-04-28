/**
 * Pricing module for @tokenomix/shared.
 *
 * Ported from bin/claude-usage.py (lines 117, 159–208, 218–259, 273–313).
 *
 * CORRECTNESS-CRITICAL: The computeCost() function must reproduce the locked
 * arithmetic values from tests/test_tokenomix.py lines 237–265:
 *
 *   Opus 4.7 event (1k input + 500 output + 100k cache_read) = $0.0675
 *     1000 × $5/Mtok    = $0.005
 *     500  × $25/Mtok   = $0.0125
 *     100k × $0.50/Mtok = $0.05
 *     ─────────────────────────
 *     total             = $0.0675  ✓
 *
 *   Combined sonnet total across three events = $0.10
 *     Event 1 (2k in + 1k out + 50k cache_read):
 *       2000  × $3/Mtok    = $0.006
 *       1000  × $15/Mtok   = $0.015
 *       50000 × $0.30/Mtok = $0.015  →  $0.036
 *     Event 2 (10k top-level cache_creation + 2 web searches):
 *       10000 × $3.75/Mtok = $0.0375
 *       2 × $0.01          = $0.02    →  $0.0575
 *     Event 3 subagent (100 in + 50 out + 5k cache_read):
 *       100   × $3/Mtok    = $0.0003
 *       50    × $15/Mtok   = $0.00075
 *       5000  × $0.30/Mtok = $0.0015  →  $0.00255
 *     Grand total: $0.036 + $0.0575 + $0.00255 = $0.09605
 *     round(0.09605, 2)  = $0.10  ✓
 */

import type { RawUsage } from './types.js';

// ---------------------------------------------------------------------------
// Web search add-on price (claude-usage.py line 117)
//
//   WEB_SEARCH_USD_PER_REQUEST = 10.00 / 1_000 = 0.01
// ---------------------------------------------------------------------------

/** $0.01 per web search request. Additive, not multiplied. */
export const WEB_SEARCH_USD_PER_REQUEST = 10.0 / 1_000;

// ---------------------------------------------------------------------------
// Price table type
// ---------------------------------------------------------------------------

/** USD price per 1M tokens for each pricing dimension. */
export interface PriceTable {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M 5-minute ephemeral cache creation tokens. */
  cache_creation_5m: number;
  /** USD per 1M 1-hour ephemeral cache creation tokens. */
  cache_creation_1h: number;
  /** USD per 1M cache read tokens. */
  cache_read: number;
}

// ---------------------------------------------------------------------------
// MODEL_PRICES (claude-usage.py lines 159–208)
// ---------------------------------------------------------------------------

/**
 * Per-family USD prices per 1M tokens.
 *
 * Six families covering all currently known Claude model generations:
 *   - opus:        Opus 4.5 / 4.6 / 4.7 — modern (cheaper) pricing
 *   - opus_legacy: Opus 3 / 4.0 / 4.1   — ~3x more expensive
 *   - sonnet:      Sonnet 3.7 / 4 / 4.5 / 4.6
 *   - haiku:       Haiku 4.5+
 *   - haiku_3_5:   Haiku 3.5 — slightly cheaper than 4.5
 *   - haiku_3:     Haiku 3   — deepest discount
 */
export const MODEL_PRICES: Record<string, PriceTable> = {
  // Opus 4.5 / 4.6 / 4.7 — modern Opus, current pricing.
  opus: {
    input: 5.0,
    output: 25.0,
    cache_creation_5m: 6.25,
    cache_creation_1h: 10.0,
    cache_read: 0.5,
  },
  // Opus 3 / 4.0 / 4.1 — legacy Opus, 3× more expensive than modern.
  opus_legacy: {
    input: 15.0,
    output: 75.0,
    cache_creation_5m: 18.75,
    cache_creation_1h: 30.0,
    cache_read: 1.5,
  },
  // Sonnet 3.7 / 4 / 4.5 / 4.6 — single rate across all current Sonnets.
  sonnet: {
    input: 3.0,
    output: 15.0,
    cache_creation_5m: 3.75,
    cache_creation_1h: 6.0,
    cache_read: 0.3,
  },
  // Haiku 4.5 — current Haiku.
  haiku: {
    input: 1.0,
    output: 5.0,
    cache_creation_5m: 1.25,
    cache_creation_1h: 2.0,
    cache_read: 0.1,
  },
  // Haiku 3.5 — legacy Haiku, slightly cheaper than 4.5.
  haiku_3_5: {
    input: 0.8,
    output: 4.0,
    cache_creation_5m: 1.0,
    cache_creation_1h: 1.6,
    cache_read: 0.08,
  },
  // Haiku 3 — oldest Haiku, deepest discount.
  haiku_3: {
    input: 0.25,
    output: 1.25,
    cache_creation_5m: 0.3,
    cache_creation_1h: 0.5,
    cache_read: 0.03,
  },
};

// ---------------------------------------------------------------------------
// Version extraction (claude-usage.py lines 218–228)
// ---------------------------------------------------------------------------

/**
 * Regex to extract (major, minor) version from model IDs like:
 *   "claude-opus-4-7"      → (4, 7)
 *   "claude-haiku-4-5"     → (4, 5)
 *   "claude-sonnet-4"      → (4, 0)
 *   "claude-opus-3"        → (3, 0)
 *
 * Uses re.match equivalent (anchored at start) so date suffixes like
 * "claude-opus-4-5-20251101" are handled correctly — only the first two
 * numeric groups are captured.
 */
const MODEL_VERSION_RE = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/;

/**
 * Return the (major, minor) version tuple from a model ID, or (0, 0) if
 * the ID does not match the expected pattern (unknown/synthetic models).
 */
function modelVersion(modelId: string): [number, number] {
  const m = MODEL_VERSION_RE.exec(modelId.toLowerCase());
  if (!m) return [0, 0];
  const major = Number.parseInt(m[1] ?? '0', 10);
  const minor = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
  return [major, minor];
}

// ---------------------------------------------------------------------------
// model_family() (claude-usage.py lines 231–259)
// ---------------------------------------------------------------------------

/**
 * Map a raw model ID (e.g. "claude-opus-4-7") to a pricing family key.
 *
 * Version-aware: Opus 4.5+ uses different pricing than Opus 4 / 4.1, and
 * Haiku has three pricing tiers (3, 3.5, 4.5+). Misclassifying these
 * inflates or deflates cost by up to 3×.
 *
 * Unknown and synthetic model IDs (e.g. "<synthetic>") default to "sonnet"
 * (the most common tier; synthetic events have zero billable tokens in practice).
 */
export function model_family(modelId: string | null | undefined): string {
  if (!modelId) return 'sonnet';
  const m = modelId.toLowerCase();

  if (m.includes('opus')) {
    const [major, minor] = modelVersion(m);
    // Opus 4.5+ → modern "opus" pricing. Earlier Opus → "opus_legacy".
    // (0, 0) means unmatched pattern → default to modern opus pricing.
    if (major > 4 || (major === 4 && minor >= 5) || (major === 0 && minor === 0)) {
      return 'opus';
    }
    return 'opus_legacy';
  }

  if (m.includes('haiku')) {
    const [major, minor] = modelVersion(m);
    // (0, 0) means unmatched → default to current haiku pricing.
    if (major > 4 || (major === 4 && minor >= 0) || (major === 0 && minor === 0)) {
      return 'haiku';
    }
    if (major > 3 || (major === 3 && minor >= 5)) {
      return 'haiku_3_5';
    }
    return 'haiku_3';
  }

  if (m.includes('sonnet')) {
    return 'sonnet';
  }

  // Synthetic events ("<synthetic>") and all unknown IDs price as sonnet.
  return 'sonnet';
}

// ---------------------------------------------------------------------------
// Fast-mode and data-residency guards (claude-usage.py lines 273–291)
// ---------------------------------------------------------------------------

/**
 * Return true when the US-only inference 1.1× multiplier applies.
 *
 * Official pricing applies US-only inference to Opus 4.6, 4.7, and newer
 * models. Treat (major, minor) >= (4, 6) as in-scope.
 */
function dataResidencyApplies(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const [major, minor] = modelVersion(modelId);
  // (major, minor) >= (4, 6)
  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Return true when the fast-mode 6× multiplier applies.
 *
 * Official pricing currently lists fast mode only for Claude Opus 4.6.
 */
function fastModeApplies(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const m = modelId.toLowerCase();
  if (!m.includes('opus')) return false;
  const [major, minor] = modelVersion(m);
  return major === 4 && minor === 6;
}

// ---------------------------------------------------------------------------
// pricing_multiplier_for_usage() (claude-usage.py lines 293–313)
// ---------------------------------------------------------------------------

/**
 * Return multiplicative token-pricing modifiers for one usage block.
 *
 * Multipliers stack:
 *   - batch service tier:   × 0.5
 *   - fast speed (opus-4-6 only): × 6.0
 *   - US-only inference (>= 4.6): × 1.1
 *
 * Web search charges are additive, not included here.
 */
export function pricing_multiplier_for_usage(
  modelId: string | null | undefined,
  usage: Pick<RawUsage, 'service_tier' | 'speed' | 'inference_geo'>
): number {
  let multiplier = 1.0;

  const serviceTier = String(usage.service_tier ?? '').toLowerCase();
  if (serviceTier === 'batch') {
    multiplier *= 0.5;
  }

  const speed = String(usage.speed ?? '').toLowerCase();
  if (speed === 'fast' && fastModeApplies(modelId)) {
    multiplier *= 6.0;
  }

  const inferenceGeo = String(usage.inference_geo ?? '')
    .toLowerCase()
    .replace(/-/g, '_');
  if (
    (inferenceGeo === 'us' ||
      inferenceGeo === 'usa' ||
      inferenceGeo === 'us_only' ||
      inferenceGeo === 'united_states') &&
    dataResidencyApplies(modelId)
  ) {
    multiplier *= 1.1;
  }

  return multiplier;
}

// ---------------------------------------------------------------------------
// Cache-token branching (claude-usage.py lines 422–439)
// ---------------------------------------------------------------------------

/**
 * Resolve 5m and 1h cache creation token counts from a usage block.
 *
 * Branching rules (mirroring ModelSlice.add in Python):
 *   1. If usage.cache_creation is a dict and either nested field is non-zero:
 *      use the nested values as-is.
 *   2. If usage.cache_creation is a dict but BOTH nested fields are zero AND
 *      top-level cache_creation_input_tokens is non-zero:
 *      treat the top-level value as 5m tokens (older Claude Code schema).
 *   3. If usage.cache_creation is absent or not a dict:
 *      use top-level cache_creation_input_tokens as 5m tokens, 1h = 0.
 */
export function resolveCacheTokens(usage: RawUsage): {
  cache5m: number;
  cache1h: number;
} {
  const topLevel = (usage.cache_creation_input_tokens ?? 0) || 0;
  const cc = usage.cache_creation;

  if (cc !== undefined && typeof cc === 'object') {
    const c5 = (cc.ephemeral_5m_input_tokens ?? 0) || 0;
    const c1h = (cc.ephemeral_1h_input_tokens ?? 0) || 0;
    if (topLevel !== 0 && c5 + c1h === 0) {
      // Fallback: older/edge schema — treat top-level as 5m tokens.
      return { cache5m: topLevel, cache1h: 0 };
    }
    return { cache5m: c5, cache1h: c1h };
  }

  // No nested cache_creation dict → top-level is 5m, 1h = 0.
  return { cache5m: topLevel, cache1h: 0 };
}

// ---------------------------------------------------------------------------
// computeCost() — primary cost entry point
// ---------------------------------------------------------------------------

/**
 * Compute the USD cost for a single usage record.
 *
 * Formula (mirroring ModelSlice.add in claude-usage.py lines 451–462):
 *
 *   token_cost = (
 *     input    × prices.input             / 1_000_000
 *   + output   × prices.output            / 1_000_000
 *   + cache5m  × prices.cache_creation_5m / 1_000_000
 *   + cache1h  × prices.cache_creation_1h / 1_000_000
 *   + cacheRead × prices.cache_read       / 1_000_000
 *   )
 *
 *   total = token_cost × multiplier + web_search_requests × WEB_SEARCH_USD_PER_REQUEST
 *
 * The multiplier applies uniformly to all token types. Web search is additive.
 *
 * @param usage  - The raw usage object from the JSONL record.
 * @param modelId - The model ID string (e.g. "claude-opus-4-7").
 * @returns USD cost as a floating-point number.
 */
export function computeCost(usage: RawUsage, modelId: string | null | undefined): number {
  const family = model_family(modelId);
  const prices = MODEL_PRICES[family] ?? MODEL_PRICES.sonnet;
  if (!prices) return 0;

  const inputTokens = (usage.input_tokens ?? 0) || 0;
  const outputTokens = (usage.output_tokens ?? 0) || 0;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) || 0;

  const { cache5m, cache1h } = resolveCacheTokens(usage);

  const tokenCost =
    (inputTokens * prices.input) / 1_000_000 +
    (outputTokens * prices.output) / 1_000_000 +
    (cache5m * prices.cache_creation_5m) / 1_000_000 +
    (cache1h * prices.cache_creation_1h) / 1_000_000 +
    (cacheRead * prices.cache_read) / 1_000_000;

  const multiplier = pricing_multiplier_for_usage(modelId, usage);

  // Web search requests: additive, not multiplied.
  const serverToolUse = usage.server_tool_use;
  const webSearchRequests =
    serverToolUse !== undefined && typeof serverToolUse === 'object'
      ? (serverToolUse.web_search_requests ?? 0) || 0
      : 0;

  return tokenCost * multiplier + webSearchRequests * WEB_SEARCH_USD_PER_REQUEST;
}
