/**
 * Pricing module for @tokenomix/shared.
 *
 * CORRECTNESS-CRITICAL: The computeCost() function must reproduce the locked
 * arithmetic values covered by apps/server/src/tests/pricing.test.ts:
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

import type {
  BedrockEndpointScope,
  PricingCatalogMetadata,
  PricingProvider,
  PricingStatus,
  RawUsage,
} from './types.js';

export const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_MTOK = 1_000_000;

export const ANTHROPIC_1P_PRICING_CATALOG_METADATA: PricingCatalogMetadata = {
  catalogVersion: 'anthropic-platform-pricing-2026-04-29',
  billingCurrency: 'USD',
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  sourceLastChecked: '2026-04-29',
  precision: 'micro-usd',
  pricingProvider: 'anthropic_1p',
  costBasis: 'estimated_from_jsonl_usage_static_anthropic_catalog',
};

export const AWS_BEDROCK_PRICING_CATALOG_METADATA: PricingCatalogMetadata = {
  catalogVersion: 'aws-bedrock-pricing-2026-04-29',
  billingCurrency: 'USD',
  sourceUrl: 'https://aws.amazon.com/bedrock/pricing/',
  sourceLastChecked: '2026-04-29',
  precision: 'micro-usd',
  pricingProvider: 'aws_bedrock',
  costBasis: 'estimated_from_jsonl_usage_static_bedrock_catalog',
};

export const PRICING_CATALOG_METADATA = ANTHROPIC_1P_PRICING_CATALOG_METADATA;

// ---------------------------------------------------------------------------
// Web search add-on price
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
// MODEL_PRICES
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

type ModelKind = 'opus' | 'sonnet' | 'haiku';

interface ParsedModelId {
  kind: ModelKind | null;
  major: number;
  minor: number;
  known: boolean;
}

// ---------------------------------------------------------------------------
// Version extraction
// ---------------------------------------------------------------------------

/**
 * Regex to extract (major, minor) version from model IDs like:
 *   "claude-opus-4-7"      → (4, 7)
 *   "claude-haiku-4-5"     → (4, 5)
 *   "claude-sonnet-4"      → (4, 0)
 *   "claude-opus-3"        → (3, 0)
 *
 * Allows provider prefixes such as "us.anthropic." while still treating date
 * suffixes like "claude-sonnet-4-20250514" as release dates, not minor versions.
 */
const MODERN_MODEL_RE = /\bclaude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/;
const LEGACY_MODEL_RE = /\bclaude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/;
const MODEL_ALIAS_VERSIONS: Record<ModelKind, [number, number]> = {
  opus: [4, 5],
  sonnet: [4, 6],
  haiku: [4, 5],
};

function parseModelMinor(rawMinor: string | undefined): number {
  if (rawMinor === undefined) return 0;
  // Date suffixes such as claude-sonnet-4-20250514 are not minor versions.
  if (rawMinor.length > 2) return 0;
  return Number.parseInt(rawMinor, 10);
}

/**
 * Return the (major, minor) version tuple from a model ID, or (0, 0) if
 * the ID does not match the expected pattern (unknown/synthetic models).
 */
function parseModelId(modelId: string | null | undefined): ParsedModelId {
  if (!modelId) return { kind: null, major: 0, minor: 0, known: false };
  const id = modelId.trim().toLowerCase();

  if (id === 'opus' || id === 'sonnet' || id === 'haiku') {
    const [major, minor] = MODEL_ALIAS_VERSIONS[id];
    return { kind: id, major, minor, known: true };
  }

  const modern = MODERN_MODEL_RE.exec(id);
  if (modern) {
    return {
      kind: (modern[1] ?? null) as ModelKind | null,
      major: Number.parseInt(modern[2] ?? '0', 10),
      minor: parseModelMinor(modern[3]),
      known: true,
    };
  }

  const legacy = LEGACY_MODEL_RE.exec(id);
  if (legacy) {
    return {
      kind: (legacy[3] ?? null) as ModelKind | null,
      major: Number.parseInt(legacy[1] ?? '0', 10),
      minor: parseModelMinor(legacy[2]),
      known: true,
    };
  }

  return { kind: null, major: 0, minor: 0, known: false };
}

function modelVersion(modelId: string | null | undefined): [number, number] {
  const parsed = parseModelId(modelId);
  return [parsed.major, parsed.minor];
}

export function isKnownPricingModelId(modelId: string | null | undefined): boolean {
  return parseModelId(modelId).known;
}

export function inferBedrockEndpointScope(
  modelId: string | null | undefined
): BedrockEndpointScope {
  if (!modelId) return 'unknown';
  const id = modelId.toLowerCase();
  if (id.startsWith('global.')) return 'global_cross_region';
  if (/^(us|eu|au|apac|ap|me|sa)\./.test(id)) return 'geographic_cross_region';
  if (id.startsWith('anthropic.')) return 'in_region';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// model_family()
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
  const parsed = parseModelId(modelId);

  if (parsed.kind === 'opus') {
    const { major, minor } = parsed;
    // Opus 4.5+ → modern "opus" pricing. Earlier Opus → "opus_legacy".
    if (major > 4 || (major === 4 && minor >= 5)) {
      return 'opus';
    }
    return 'opus_legacy';
  }

  if (parsed.kind === 'haiku') {
    const { major, minor } = parsed;
    if (major > 4 || major === 4) {
      return 'haiku';
    }
    if (major > 3 || (major === 3 && minor >= 5)) {
      return 'haiku_3_5';
    }
    return 'haiku_3';
  }

  if (parsed.kind === 'sonnet') {
    return 'sonnet';
  }

  // Synthetic events ("<synthetic>") and unknown IDs price as sonnet for
  // backward compatibility, but computeCostWithFamily flags billable unknowns
  // as fallback_sonnet in pricingStatus.
  return 'sonnet';
}

function hasBillableUsage(usage: RawUsage): boolean {
  const { cache5m, cache1h } = resolveCacheTokens(usage);
  const serverToolUse = usage.server_tool_use;
  const webSearchRequests =
    serverToolUse !== undefined && typeof serverToolUse === 'object'
      ? (serverToolUse.web_search_requests ?? 0) || 0
      : 0;
  return (
    ((usage.input_tokens ?? 0) || 0) > 0 ||
    ((usage.output_tokens ?? 0) || 0) > 0 ||
    ((usage.cache_creation_input_tokens ?? 0) || 0) > 0 ||
    cache5m > 0 ||
    cache1h > 0 ||
    ((usage.cache_read_input_tokens ?? 0) || 0) > 0 ||
    webSearchRequests > 0
  );
}

export function pricing_status_for_usage(
  modelId: string | null | undefined,
  usage: RawUsage,
  provider: PricingProvider = 'anthropic_1p',
  externallyRated = false
): PricingStatus {
  if (provider === 'internal_gateway') {
    return externallyRated ? 'internal_gateway_rated' : 'internal_gateway_unrated_estimate';
  }
  if (isKnownPricingModelId(modelId)) return 'catalog';
  return hasBillableUsage(usage) ? 'fallback_sonnet' : 'zero_usage_unknown_model';
}

// ---------------------------------------------------------------------------
// Fast-mode and data-residency guards
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
  const [major, minor] = modelVersion(modelId);
  return major === 4 && minor === 6;
}

function bedrockEndpointPremiumApplies(modelId: string | null | undefined): boolean {
  const parsed = parseModelId(modelId);
  const { major, minor } = parsed;

  if (parsed.kind === 'sonnet') {
    return major > 4 || (major === 4 && minor >= 5);
  }
  if (parsed.kind === 'haiku') {
    return major > 4 || (major === 4 && minor >= 5);
  }
  if (parsed.kind === 'opus') {
    return major > 4 || (major === 4 && minor >= 7);
  }
  return false;
}

function bedrockEndpointPremiumRatio(
  modelId: string | null | undefined,
  provider: PricingProvider,
  scope: BedrockEndpointScope
): { numerator: number; denominator: number } {
  if (provider !== 'aws_bedrock' && provider !== 'internal_gateway') {
    return { numerator: 1, denominator: 1 };
  }
  if (scope !== 'geographic_cross_region' && scope !== 'in_region') {
    return { numerator: 1, denominator: 1 };
  }
  if (!bedrockEndpointPremiumApplies(modelId)) {
    return { numerator: 1, denominator: 1 };
  }
  return { numerator: 11, denominator: 10 };
}

// ---------------------------------------------------------------------------
// pricing_multiplier_for_usage()
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
  const ratio = pricing_multiplier_ratio_for_usage(modelId, usage, 'anthropic_1p');
  return ratio.numerator / ratio.denominator;
}

function pricing_multiplier_ratio_for_usage(
  modelId: string | null | undefined,
  usage: Pick<RawUsage, 'service_tier' | 'speed' | 'inference_geo'>,
  provider: PricingProvider
): { numerator: number; denominator: number } {
  let numerator = 1;
  let denominator = 1;

  const serviceTier = String(usage.service_tier ?? '').toLowerCase();
  if (serviceTier === 'batch') {
    denominator *= 2;
  }

  const speed = String(usage.speed ?? '').toLowerCase();
  if (speed === 'fast' && fastModeApplies(modelId)) {
    numerator *= 6;
  }

  const inferenceGeo = String(usage.inference_geo ?? '')
    .toLowerCase()
    .replace(/-/g, '_');
  if (
    provider === 'anthropic_1p' &&
    (inferenceGeo === 'us' ||
      inferenceGeo === 'usa' ||
      inferenceGeo === 'us_only' ||
      inferenceGeo === 'united_states') &&
    dataResidencyApplies(modelId)
  ) {
    numerator *= 11;
    denominator *= 10;
  }

  return { numerator, denominator };
}

// ---------------------------------------------------------------------------
// Cache-token branching
// ---------------------------------------------------------------------------

/**
 * Resolve 5m and 1h cache creation token counts from a usage block.
 *
 * Branching rules:
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
 * Formula:
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
  return computeCostWithFamily(usage, modelId, model_family(modelId)).totalCostUsd;
}

export function microsToUsd(micros: number): number {
  return micros / MICRO_USD_PER_USD;
}

function priceUsdPerMTokToMicros(priceUsdPerMTok: number): number {
  return Math.round(priceUsdPerMTok * MICRO_USD_PER_USD);
}

function tokenCostMicros(tokens: number, priceUsdPerMTok: number): number {
  const priceMicrosPerMTok = priceUsdPerMTokToMicros(priceUsdPerMTok);
  return Math.round((tokens * priceMicrosPerMTok) / TOKENS_PER_MTOK);
}

function applyMultiplierMicros(
  micros: number,
  ratio: { numerator: number; denominator: number }
): number {
  return Math.round((micros * ratio.numerator) / ratio.denominator);
}

function scaleComponentMicrosToTotal(
  components: [number, number, number, number, number],
  totalCostUsdMicros: number
): [number, number, number, number, number] {
  const componentTotal = components.reduce((sum, value) => sum + value, 0);
  if (componentTotal <= 0 || totalCostUsdMicros <= 0) return [0, 0, 0, 0, 0];

  const exact = components.map((value) => (value * totalCostUsdMicros) / componentTotal);
  const scaled = exact.map((value) => Math.floor(value)) as [
    number,
    number,
    number,
    number,
    number,
  ];
  let remaining = totalCostUsdMicros - scaled.reduce((sum, value) => sum + value, 0);

  const indicesByRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  for (const entry of indicesByRemainder) {
    if (remaining <= 0) break;
    const index = entry.index as 0 | 1 | 2 | 3 | 4;
    scaled[index] = (scaled[index] ?? 0) + 1;
    remaining -= 1;
  }

  return scaled;
}

export function computeCostMicros(
  usage: RawUsage,
  modelId: string | null | undefined
): ReturnType<typeof computeCostWithFamily> {
  return computeCostWithFamily(usage, modelId, model_family(modelId));
}

/**
 * Compute a component-level USD breakdown using a specific pricing family.
 *
 * The caller may pass a family that differs from model_family(modelId) to build
 * counterfactual estimates, e.g. "what if this Opus row had been priced as
 * Sonnet?". Multipliers still use the original model ID and usage flags because
 * they represent service tier / region / speed metadata on the original call.
 */
export function computeCostWithFamily(
  usage: RawUsage,
  modelId: string | null | undefined,
  family: string,
  options: {
    pricingProvider?: PricingProvider;
    externallyRated?: boolean;
    externalCostUsdMicros?: number;
    bedrockEndpointScope?: BedrockEndpointScope;
  } = {}
): {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  webSearchCostUsd: number;
  totalCostUsd: number;
  inputCostUsdMicros: number;
  outputCostUsdMicros: number;
  cacheCreationCostUsdMicros: number;
  cacheReadCostUsdMicros: number;
  webSearchCostUsdMicros: number;
  totalCostUsdMicros: number;
  pricingMultiplier: number;
  pricingStatus: PricingStatus;
} {
  const pricingProvider = options.pricingProvider ?? 'anthropic_1p';
  const prices = MODEL_PRICES[family] ?? MODEL_PRICES.sonnet;
  if (!prices) {
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheCreationCostUsd: 0,
      cacheReadCostUsd: 0,
      webSearchCostUsd: 0,
      totalCostUsd: 0,
      inputCostUsdMicros: 0,
      outputCostUsdMicros: 0,
      cacheCreationCostUsdMicros: 0,
      cacheReadCostUsdMicros: 0,
      webSearchCostUsdMicros: 0,
      totalCostUsdMicros: 0,
      pricingMultiplier: 1,
      pricingStatus: pricing_status_for_usage(modelId, usage, pricingProvider),
    };
  }

  const inputTokens = (usage.input_tokens ?? 0) || 0;
  const outputTokens = (usage.output_tokens ?? 0) || 0;
  const cacheRead = (usage.cache_read_input_tokens ?? 0) || 0;

  const { cache5m, cache1h } = resolveCacheTokens(usage);

  const multiplierRatio = pricing_multiplier_ratio_for_usage(modelId, usage, pricingProvider);
  const endpointScope = options.bedrockEndpointScope ?? inferBedrockEndpointScope(modelId);
  const endpointPremiumRatio = bedrockEndpointPremiumRatio(modelId, pricingProvider, endpointScope);
  const combinedMultiplierRatio = {
    numerator: multiplierRatio.numerator * endpointPremiumRatio.numerator,
    denominator: multiplierRatio.denominator * endpointPremiumRatio.denominator,
  };
  const multiplier = combinedMultiplierRatio.numerator / combinedMultiplierRatio.denominator;

  const inputBaseMicros = tokenCostMicros(inputTokens, prices.input);
  const outputBaseMicros = tokenCostMicros(outputTokens, prices.output);
  const cacheCreationBaseMicros =
    tokenCostMicros(cache5m, prices.cache_creation_5m) +
    tokenCostMicros(cache1h, prices.cache_creation_1h);
  const cacheReadBaseMicros = tokenCostMicros(cacheRead, prices.cache_read);

  const inputCostUsdMicros = applyMultiplierMicros(inputBaseMicros, combinedMultiplierRatio);
  const outputCostUsdMicros = applyMultiplierMicros(outputBaseMicros, combinedMultiplierRatio);
  const cacheCreationCostUsdMicros = applyMultiplierMicros(
    cacheCreationBaseMicros,
    combinedMultiplierRatio
  );
  const cacheReadCostUsdMicros = applyMultiplierMicros(
    cacheReadBaseMicros,
    combinedMultiplierRatio
  );

  // Web search requests: additive, not multiplied.
  const serverToolUse = usage.server_tool_use;
  const webSearchRequests =
    serverToolUse !== undefined && typeof serverToolUse === 'object'
      ? (serverToolUse.web_search_requests ?? 0) || 0
      : 0;
  const webSearchCostUsdMicros = Math.round(
    webSearchRequests * WEB_SEARCH_USD_PER_REQUEST * MICRO_USD_PER_USD
  );
  const totalCostUsdMicros =
    inputCostUsdMicros +
    outputCostUsdMicros +
    cacheCreationCostUsdMicros +
    cacheReadCostUsdMicros +
    webSearchCostUsdMicros;

  const externallyRated =
    options.externallyRated === true && options.externalCostUsdMicros !== undefined;
  if (externallyRated && options.externalCostUsdMicros !== undefined) {
    const [
      scaledInputCostUsdMicros,
      scaledOutputCostUsdMicros,
      scaledCacheCreationCostUsdMicros,
      scaledCacheReadCostUsdMicros,
      scaledWebSearchCostUsdMicros,
    ] = scaleComponentMicrosToTotal(
      [
        inputCostUsdMicros,
        outputCostUsdMicros,
        cacheCreationCostUsdMicros,
        cacheReadCostUsdMicros,
        webSearchCostUsdMicros,
      ],
      options.externalCostUsdMicros
    );

    return {
      inputCostUsd: microsToUsd(scaledInputCostUsdMicros),
      outputCostUsd: microsToUsd(scaledOutputCostUsdMicros),
      cacheCreationCostUsd: microsToUsd(scaledCacheCreationCostUsdMicros),
      cacheReadCostUsd: microsToUsd(scaledCacheReadCostUsdMicros),
      webSearchCostUsd: microsToUsd(scaledWebSearchCostUsdMicros),
      totalCostUsd: microsToUsd(options.externalCostUsdMicros),
      inputCostUsdMicros: scaledInputCostUsdMicros,
      outputCostUsdMicros: scaledOutputCostUsdMicros,
      cacheCreationCostUsdMicros: scaledCacheCreationCostUsdMicros,
      cacheReadCostUsdMicros: scaledCacheReadCostUsdMicros,
      webSearchCostUsdMicros: scaledWebSearchCostUsdMicros,
      totalCostUsdMicros: options.externalCostUsdMicros,
      pricingMultiplier: multiplier,
      pricingStatus: pricing_status_for_usage(modelId, usage, pricingProvider, true),
    };
  }

  return {
    inputCostUsd: microsToUsd(inputCostUsdMicros),
    outputCostUsd: microsToUsd(outputCostUsdMicros),
    cacheCreationCostUsd: microsToUsd(cacheCreationCostUsdMicros),
    cacheReadCostUsd: microsToUsd(cacheReadCostUsdMicros),
    webSearchCostUsd: microsToUsd(webSearchCostUsdMicros),
    totalCostUsd: microsToUsd(totalCostUsdMicros),
    inputCostUsdMicros,
    outputCostUsdMicros,
    cacheCreationCostUsdMicros,
    cacheReadCostUsdMicros,
    webSearchCostUsdMicros,
    totalCostUsdMicros,
    pricingMultiplier: multiplier,
    pricingStatus:
      pricingProvider === 'aws_bedrock' && isKnownPricingModelId(modelId)
        ? 'bedrock_catalog'
        : pricing_status_for_usage(modelId, usage, pricingProvider),
  };
}
