/**
 * Server-side pricing bridge.
 *
 * Re-exports the pricing symbols used by server code from @tokenomix/shared
 * so imports stay centralized. Also provides a thin server-side
 * helper (costForRow) for computing cost from a parsed TokenRow.
 *
 * DO NOT re-implement any pricing logic here — always delegate to the
 * shared package. This file is intentionally kept under 30 lines.
 */

export {
  ANTHROPIC_1P_PRICING_CATALOG_METADATA,
  AWS_BEDROCK_PRICING_CATALOG_METADATA,
  computeCost,
  computeCostWithFamily,
  computeOpenAiCodexCost,
  inferBedrockEndpointScope,
  isKnownPricingModelId,
  LOCAL_MODEL_EQUIVALENT_PRICING_CATALOG_METADATA,
  MIXED_STATIC_PRICING_CATALOG_METADATA,
  MODEL_PRICES,
  microsToUsd,
  model_family,
  OPENAI_API_PRICING_CATALOG_METADATA,
  OPENAI_CODEX_LONG_CONTEXT_THRESHOLD_INPUT_TOKENS,
  openAiCodexFastModeMultiplierForModel,
  openAiCodexLongContextApplies,
  openAiCodexPriceForModel,
  PRICING_CATALOG_METADATA,
  pricing_status_for_usage,
  resolveCacheTokens,
  WEB_SEARCH_USD_PER_REQUEST,
} from '@tokenomix/shared';

import type { TokenRow } from '@tokenomix/shared';

/**
 * Return the pre-computed costUsd from an already-built TokenRow.
 * Cost is computed once during ingestion in index-store.ts.
 */
export function costForRow(row: TokenRow): number {
  return row.costUsd;
}
