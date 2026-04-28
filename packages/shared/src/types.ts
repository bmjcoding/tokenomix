/**
 * Shared TypeScript types for @tokenomix/shared.
 *
 * All types are consumed by both apps/server and apps/web. They model the
 * Claude Code JSONL raw data, the in-memory index, and the API response shapes
 * that the Hono server exposes.
 */

// ---------------------------------------------------------------------------
// Raw JSONL types (Claude Code session files)
// ---------------------------------------------------------------------------

/**
 * The nested cache_creation sub-object added in Claude Code ~v2.1.100+.
 * Older logs omit this field; the branching logic in pricing.ts handles that.
 */
export interface CacheCreation {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

/**
 * The server_tool_use sub-object added in Claude Code ~v2.1.100+.
 */
export interface ServerToolUse {
  web_search_requests?: number;
  web_fetch_requests?: number;
}

/**
 * Usage block inside a JSONL `message` object.
 * Optional fields reflect version differences (v2.1.86–v2.1.99 vs v2.1.100+).
 */
export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Nested TTL-split cache creation (v2.1.100+). */
  cache_creation?: CacheCreation;
  /** Web and fetch request counts (v2.1.100+). */
  server_tool_use?: ServerToolUse;
  /** "standard" | "batch" */
  service_tier?: string;
  /** "standard" | "fast" */
  speed?: string;
  /** "us" | "not_available" | "" | … */
  inference_geo?: string;
}

/**
 * Top-level JSONL event object.
 * Only `assistant` type records carry usage data we process.
 */
export interface RawUsageEvent {
  type: string;
  uuid?: string;
  parentUuid?: string;
  requestId?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string | null;
  /** Inner message from the Anthropic API. */
  message?: {
    model?: string;
    id?: string;
    type?: string;
    role?: string;
    stop_reason?: string | null;
    usage?: RawUsage;
  };
}

// ---------------------------------------------------------------------------
// In-memory index types
// ---------------------------------------------------------------------------

/**
 * A single deduplicated, priced token usage row stored in the IndexStore.
 * Produced from one (requestId, message.id) pair in the JSONL files.
 */
export interface TokenRow {
  /** YYYY-MM-DD local date (from parse_iso → local naive datetime). */
  date: string;
  /** 0-23 hour of day in local time. */
  hour: number;
  sessionId: string;
  project: string;
  modelId: string;
  /** Model pricing family (opus | opus_legacy | sonnet | haiku | haiku_3_5 | haiku_3). */
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  /** 5-minute cache creation tokens (after branching logic). */
  cacheCreation5m: number;
  /** 1-hour cache creation tokens (after branching logic). */
  cacheCreation1h: number;
  cacheReadTokens: number;
  webSearchRequests: number;
  /** Computed USD cost for this row (token cost × multiplier + web search add-on). */
  costUsd: number;
  isSubagent: boolean;
}

// ---------------------------------------------------------------------------
// Bucket types for aggregated API responses
// ---------------------------------------------------------------------------

/** One calendar-day cost + token bucket for the daily time-series. */
export interface DailyBucket {
  /** YYYY-MM-DD */
  date: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** One ISO week cost + token bucket for the weekly time-series. */
export interface WeeklyBucket {
  /** ISO week start date, YYYY-MM-DD (Monday). */
  weekStart: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-model-family rollup. */
export interface ModelBucket {
  modelFamily: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  events: number;
}

/** Per-project rollup. */
export interface ProjectBucket {
  project: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  events: number;
}

/**
 * Per-session rollup used for the bySession list and the Sessions page table.
 * sessionId and project are the primary display fields.
 */
export interface SessionBucket {
  sessionId: string;
  project: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  events: number;
}

/**
 * Raw per-(date, hour) entry in the heatmap dataset.
 * The server emits one entry per unique (date, hour) combination.
 * The HeatmapChart component is responsible for client-side aggregation
 * to (dayOfWeek, hour) buckets via `new Date(point.date).getDay()`.
 */
export interface HeatmapPoint {
  /** YYYY-MM-DD */
  date: string;
  /** 0-23 */
  hour: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Session summary (for /api/sessions)
// ---------------------------------------------------------------------------

/** Session-level summary returned by GET /api/sessions. */
export interface SessionSummary {
  sessionId: string;
  project: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  events: number;
  isSubagent: boolean;
}

// ---------------------------------------------------------------------------
// Retro forward-compatibility stubs (v1 server returns null / [])
// ---------------------------------------------------------------------------

/** Minimal retro rollup shape. Server returns null in v1. */
export interface RetroRollup {
  totalCostUsd: number;
}

/** Retro timeline point. Server returns [] in v1. */
export interface RetroTimelinePoint {
  /** YYYY-MM-DD */
  date: string;
  costUsd: number;
}

/** Retro forecast point. Server returns [] in v1. */
export interface RetroForecastPoint {
  /** YYYY-MM-DD */
  date: string;
  costUsd: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Period rollup types (calendar-period KPI comparisons)
// ---------------------------------------------------------------------------

/**
 * Aggregated metrics for a single calendar period (month, quarter, or year).
 * dailyCost, dailyTokens, and dailySessions are indexed by day offset from
 * period start; days with no events have value 0 (suitable for sparkline
 * rendering). All three arrays have the same length (one entry per calendar
 * day in the period).
 *
 * sessionDuration contains stats scoped to the same period: only sessions
 * whose first event falls within [period.start, period.end] are counted.
 * This ensures sessionDuration.totalCounted + sessionDuration.outliersExcluded
 * is reconcilable with sessionCount.
 */
export interface PeriodRollup {
  costUsd: number;
  /** Total tokens: input + output (cache tokens excluded). */
  totalTokens: number;
  /** Distinct sessionIds with at least one event in the period. */
  sessionCount: number;
  /** Daily costUsd values for each day in the period (sparkline data). */
  dailyCost: number[];
  /** Daily input+output tokens for each day in the period (sparkline data). */
  dailyTokens: number[];
  /** Count of distinct sessionIds with at least one event on each day of the period. */
  dailySessions: number[];
  /** Session-duration stats scoped to this period (sessions starting within the period). */
  sessionDuration: SessionDurationStats;
}

/** Side-by-side comparison of the current period vs the immediately preceding one. */
export interface PeriodComparison {
  current: PeriodRollup;
  previous: PeriodRollup;
}

/** Aggregated session-duration stats. Outliers (>=3h) are excluded. */
export interface SessionDurationStats {
  /** Median session duration in MINUTES across non-outlier sessions. */
  medianMinutes: number;
  /** P90 session duration in minutes. */
  p90Minutes: number;
  /** Per-week median duration trend (most recent ~12 weeks, oldest → newest). Sparkline data. */
  weeklyMedianTrend: number[];
  /** Number of sessions excluded as >=3h outliers. */
  outliersExcluded: number;
  /** Total non-outlier sessions counted. */
  totalCounted: number;
}

// ---------------------------------------------------------------------------
// MetricSummary — flat shape (matches GET /api/metrics response)
// ---------------------------------------------------------------------------

/**
 * The primary metrics response shape from GET /api/metrics.
 *
 * All-time totals are flat top-level fields (no nested totals_all object).
 * Windowed totals are also flat (no nested totals_30d / totals_5d objects).
 * This matches the contract documented in the integration_contracts section.
 */
export interface MetricSummary {
  // ── All-time totals ──────────────────────────────────────────────────────
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalSessions: number;
  totalProjects: number;

  // ── Windowed totals (mirroring Python collect_data totals_30d / totals_5d) ──
  costUsd30d: number;
  costUsd5d: number;
  inputTokens30d: number;
  outputTokens30d: number;

  // ── Series / breakdown arrays ─────────────────────────────────────────────
  dailySeries: DailyBucket[];
  weeklySeries: WeeklyBucket[];
  byModel: ModelBucket[];
  byProject: ProjectBucket[];
  /** Top N sessions by cost. */
  bySession: SessionBucket[];
  /** Raw per-(date, hour) entries; NOT pre-aggregated by dayOfWeek. */
  heatmapData: HeatmapPoint[];

  // ── Retro forward-compatibility stubs ───────────────────────────────────
  retroRollup: RetroRollup | null;
  retroTimeline: RetroTimelinePoint[];
  retroForecast: RetroForecastPoint[];

  // ── Calendar-period rollups ──────────────────────────────────────────────
  /** Current calendar month vs previous calendar month. */
  monthlyRollup: PeriodComparison;
  /** Current calendar quarter vs previous calendar quarter. */
  quarterlyRollup: PeriodComparison;
  /** Current calendar year vs previous calendar year. */
  yearlyRollup: PeriodComparison;
}

// ---------------------------------------------------------------------------
// MetricsQuery (query parameters for GET /api/metrics)
// ---------------------------------------------------------------------------

/** Optional filters accepted by GET /api/metrics. */
export interface MetricsQuery {
  /** ISO date string or day-count as string (e.g. "30", "2026-01-01"). */
  since?: string;
  /** Project path substring filter. */
  project?: string;
}

// ---------------------------------------------------------------------------
// SinceOption — canonical time-window literal type
// ---------------------------------------------------------------------------

/**
 * Canonical set of time-window sentinel values shared between client and server.
 *
 * - '7d'  — last 7 days
 * - '30d' — last 30 days
 * - 'all' — no filter (parseSinceCutoff returns null for 'all', treating it as
 *            no date restriction)
 *
 * Callers on both the web client and the server should use this type for
 * UI toggles and route query params to ensure the contract stays in sync.
 */
export type SinceOption = '7d' | '30d' | 'all';
