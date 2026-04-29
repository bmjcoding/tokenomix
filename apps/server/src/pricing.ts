/**
 * Server-side pricing bridge.
 *
 * Re-exports all pricing symbols from @tokenomix/shared so that server
 * code imports from this single module. Also provides a thin server-side
 * helper (costForRow) for computing cost from a parsed TokenRow.
 *
 * DO NOT re-implement any pricing logic here — always delegate to the
 * shared package. This file is intentionally kept under 30 lines.
 */

export type { PriceTable, PricingStatus } from '@tokenomix/shared';
export {
  ANTHROPIC_1P_PRICING_CATALOG_METADATA,
  AWS_BEDROCK_PRICING_CATALOG_METADATA,
  computeCost,
  computeCostMicros,
  computeCostWithFamily,
  inferBedrockEndpointScope,
  isKnownPricingModelId,
  MICRO_USD_PER_USD,
  MODEL_PRICES,
  microsToUsd,
  model_family,
  PRICING_CATALOG_METADATA,
  pricing_multiplier_for_usage,
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
