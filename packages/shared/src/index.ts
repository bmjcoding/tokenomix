/**
 * @tokenomix/shared — public API barrel.
 *
 * Re-exports all public symbols from types, schemas, and pricing modules.
 * Consumers import from "@tokenomix/shared" and receive TS source directly
 * (no build step required for internal workspace use).
 */

// Types
export type {
  CacheCreation,
  ServerToolUse,
  RawUsage,
  RawUsageEvent,
  TokenRow,
  DailyBucket,
  WeeklyBucket,
  ModelBucket,
  ProjectBucket,
  SessionBucket,
  HeatmapPoint,
  // New analytics bucket types
  ToolBucket,
  SubagentBucket,
  TurnBucket,
  FileTouchBucket,
  // Session summary
  SessionSummary,
  // Retro stubs
  RetroRollup,
  RetroTimelinePoint,
  RetroForecastPoint,
  // Metrics response
  MetricSummary,
  MetricsQuery,
  SinceOption,
  // Period rollup types
  PeriodRollup,
  PeriodComparison,
  SessionDurationStats,
} from './types.js';

// Schemas
export {
  CacheCreationSchema,
  ServerToolUseSchema,
  RawUsageSchema,
  // New event schemas
  AssistantEventSchema,
  ToolUseEventSchema,
  ToolResultEventSchema,
  SystemTurnDurationSchema,
  // Union schema (replaces the old single-object schema at the same export name)
  RawUsageEventSchema,
} from './schemas.js';

export type {
  CacheCreationParsed,
  ServerToolUseParsed,
  RawUsageParsed,
  // New parsed event types
  AssistantEventParsed,
  ToolUseEventParsed,
  ToolResultEventParsed,
  SystemTurnDurationEventParsed,
  // Union parsed type (unchanged name — drop-in for existing consumers)
  RawUsageEventParsed,
} from './schemas.js';

// Pricing
export {
  WEB_SEARCH_USD_PER_REQUEST,
  MODEL_PRICES,
  model_family,
  pricing_multiplier_for_usage,
  resolveCacheTokens,
  computeCost,
} from './pricing.js';

export type { PriceTable } from './pricing.js';
