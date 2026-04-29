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
  /** "standard" | "batch". Null on API-error records. */
  service_tier?: string | null;
  /** "standard" | "fast". Null on API-error records. */
  speed?: string | null;
  /** "us" | "not_available" | "" | …. Null on API-error records. */
  inference_geo?: string | null;
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
 *
 * Optional fields are populated by the new ingest branches added in the
 * tools/subagent analytics feature: tool_use, tool_result, and system/turn_duration
 * events are merged into the corresponding assistant turn's row.
 */
export interface TokenRow {
  /** YYYY-MM-DD local date (from parse_iso → local naive datetime). */
  date: string;
  /** 0-23 hour of day in local time. */
  hour: number;
  sessionId: string;
  project: string;
  /**
   * Human-readable project name derived from path.basename(cwd).
   * Trailing slashes are stripped before basename extraction so paths like
   * "/foo/bar/" yield "bar" not "".
   */
  projectName: string;
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
  /**
   * Computed cost in micro-USD (1 USD = 1,000,000 micro-USD).
   * This is the audit-preferred integer representation; costUsd is retained
   * for chart/UI compatibility.
   */
  costUsdMicros?: number;
  /** Token-pricing multiplier applied to this row, excluding additive web-search charges. */
  pricingMultiplier?: number;
  /** Pricing status for this row. Fallback or unrated rows are estimates, not authoritative. */
  pricingStatus?: PricingStatus;
  /** USD cost from raw input tokens after pricing multipliers. */
  inputCostUsd?: number;
  /** Micro-USD cost from raw input tokens after pricing multipliers. */
  inputCostUsdMicros?: number;
  /** USD cost from output tokens after pricing multipliers. */
  outputCostUsd?: number;
  /** Micro-USD cost from output tokens after pricing multipliers. */
  outputCostUsdMicros?: number;
  /** USD cost from cache creation tokens after pricing multipliers. */
  cacheCreationCostUsd?: number;
  /** Micro-USD cost from cache creation tokens after pricing multipliers. */
  cacheCreationCostUsdMicros?: number;
  /** USD cost from cache read tokens after pricing multipliers. */
  cacheReadCostUsd?: number;
  /** Micro-USD cost from cache read tokens after pricing multipliers. */
  cacheReadCostUsdMicros?: number;
  /** Additive USD cost from server-side web search requests. */
  webSearchCostUsd?: number;
  /** Additive micro-USD cost from server-side web search requests. */
  webSearchCostUsdMicros?: number;
  isSubagent: boolean;

  // ── Fields populated by the tool/duration ingest branches ──────────────────

  /**
   * Duration of this turn in milliseconds from system/turn_duration events.
   * Undefined when no turn_duration event was emitted for this turn.
   */
  turnDurationMs?: number;

  /**
   * Per-tool invocation counts for tools invoked within this turn.
   * Key: tool name (e.g. "Bash", "Read", "Write"). Value: invocation count.
   * Undefined when no tool_use events were associated with this turn.
   */
  toolUses?: Record<string, number>;

  /**
   * Per-tool error counts for tools that returned is_error: true within this turn.
   * Key: tool name. Value: error count.
   * Undefined when no tool errors occurred within this turn.
   */
  toolErrors?: Record<string, number>;

  /**
   * Unique file paths touched by tool_use events within this turn.
   * Populated from scalar path-like fields on tool_use events only; command
   * strings, patterns, file contents, and tool output are never stored.
   * Undefined when no file-touching tool uses occurred within this turn.
   */
  filesTouched?: string[];
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
// New analytics bucket types (tools, subagents, turns, files)
// ---------------------------------------------------------------------------

/**
 * Per-tool aggregated counts for the tools-breakdown panel.
 * Populated by the aggregate() function from TokenRow.toolUses and TokenRow.toolErrors.
 */
export interface ToolBucket {
  /** Tool name as emitted by Claude Code (e.g. "Bash", "Read", "Write", "Edit"). */
  toolName: string;
  /** Total invocations in the window. */
  count: number;
  /** Total invocations that returned is_error: true. */
  errorCount: number;
  /** errorCount / count (0..1). 0 when count is 0. */
  errorRate: number;
}

/** Cost and token contribution by billing component for a window. */
export interface CostComponentSummary {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  webSearchRequests: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  webSearchCostUsd: number;
}

/** Versioned source metadata for the static pricing catalog used in calculations. */
export interface PricingCatalogMetadata {
  catalogVersion: string;
  billingCurrency: 'USD';
  sourceUrl: string;
  sourceLastChecked: string;
  precision: 'micro-usd';
  pricingProvider: PricingProvider;
  costBasis:
    | 'estimated_from_jsonl_usage_static_anthropic_catalog'
    | 'estimated_from_jsonl_usage_static_bedrock_catalog'
    | 'rated_internal_gateway_cost'
    | 'estimated_from_jsonl_usage_without_gateway_rated_cost';
}

export type PricingProvider = 'anthropic_1p' | 'aws_bedrock' | 'internal_gateway';

export type BedrockEndpointScope =
  | 'in_region'
  | 'global_cross_region'
  | 'geographic_cross_region'
  | 'unknown';

export type BedrockServiceTier = 'standard' | 'batch' | 'provisioned' | 'reserved' | 'unknown';

/** Pricing status for one row. */
export type PricingStatus =
  | 'catalog'
  | 'bedrock_catalog'
  | 'internal_gateway_rated'
  | 'internal_gateway_unrated_estimate'
  | 'fallback_sonnet'
  | 'zero_usage_unknown_model';

/** Audit metadata returned with metrics so reports can disclose pricing quality. */
export interface PricingAuditSummary {
  catalog: PricingCatalogMetadata;
  provider: PricingProvider;
  bedrockRegion: string | null;
  bedrockEndpointScope: BedrockEndpointScope;
  bedrockServiceTier: BedrockServiceTier;
  bedrockEndpointScopeSource: 'model_id' | 'env' | 'unknown';
  totalCostUsdMicros: number;
  fallbackPricedRows: number;
  fallbackPricedCostUsd: number;
  fallbackPricedCostUsdMicros: number;
  fallbackPricedModelIds: string[];
  zeroUsageUnknownModelRows: number;
  internalGatewayRatedRows: number;
  internalGatewayUnratedRows: number;
  warnings: string[];
}

/** Ingestion/completeness metadata for audit workflows. */
export interface IngestionAuditSummary {
  /** JSONL files discovered during startup scan. */
  filesDiscovered: number;
  /** JSONL files parsed at least once in the current server process. */
  filesAttempted: number;
  /** Files with at least one parse or schema warning. */
  filesWithParseWarnings: number;
  /** Lines skipped because JSON.parse failed. */
  invalidJsonLines: number;
  /** Lines skipped because they did not match the accepted event schema. */
  schemaMismatchLines: number;
  /** Files that could not be opened/read by the parser. */
  fileOpenErrors: number;
  /** Assistant events containing a usage block before row-level filters. */
  assistantUsageEvents: number;
  /** Assistant events without usage, useful for understanding non-billable transcript volume. */
  assistantEventsWithoutUsage: number;
  /** Rows skipped because requestId or message.id was absent. */
  missingDedupIdRows: number;
  /** Rows skipped because the dedup key was already indexed. */
  duplicateRowsSkipped: number;
  /** Duplicate rows that replaced an earlier retained row because they were newer/fuller usage. */
  duplicateRowsReplaced: number;
  /** Assistant usage events rejected by row construction, usually invalid timestamp/usage shape. */
  tokenRowsRejected: number;
  /** Rows retained after parsing and deduplication. */
  rowsIndexed: number;
  /** File-level ingestion exceptions caught outside normal parse skips. */
  ingestErrors: number;
  /** Last time any file audit was refreshed, as ISO-8601. */
  lastIndexedAt: string | null;
  warnings: string[];
}

/** High-level optimization recommendation derived from observed usage. */
export interface OptimizationOpportunity {
  id: string;
  category: 'context' | 'model' | 'tooling' | 'workflow' | 'project';
  title: string;
  recommendation: string;
  evidence: string;
  impactUsd30d: number;
  /** Deterministic rule score from server heuristics; not an LLM probability. */
  confidence: number;
  project?: string;
}

/**
 * Per-subagent-type aggregated stats for the subagent leaderboard panel.
 * A "subagent" is a TokenRow where isSubagent === true.
 * agentType is derived from the row's modelFamily.
 */
export interface SubagentBucket {
  /**
   * Agent type label derived from modelFamily (e.g. "sonnet", "haiku").
   * Used as the display key in the leaderboard table.
   */
  agentType: string;
  /** Number of subagent dispatches (turns) in the window. */
  dispatches: number;
  /** Sum of (inputTokens + outputTokens) across subagent turns in the window. */
  totalTokens: number;
  /** Sum of costUsd across subagent turns in the window. */
  totalCostUsd: number;
  /**
   * Average turn duration in milliseconds.
   * Computed only from rows that have a defined turnDurationMs; 0 when none available.
   */
  avgDurationMs: number;
  /**
   * 1 − (tool errors / tool invocations) for this subagent's turns in the window.
   * 1.0 when no tool invocations are present (no failures by definition).
   */
  successRate: number;
}

/**
 * Per-turn data shape returned by GET /api/turns.
 * Each entry corresponds to one assistant turn (one TokenRow).
 * Callers compute inputTokens + outputTokens for a total token count.
 */
export interface TurnBucket {
  /**
   * Local ISO 8601 timestamp with UTC offset, derived from row.date + row.hour.
   * Example: "2026-04-15T14:00:00.000-05:00".
   */
  timestamp: string;
  sessionId: string;
  project: string;
  modelId: string;
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /**
   * Turn duration in milliseconds from the system/turn_duration event.
   * null when no duration event was recorded for this turn.
   */
  durationMs: number | null;
}

/**
 * Per-file-path touch count (how many turns touched the file).
 * Defined for future downstream consumers; NOT included in MetricSummary
 * (see REVISION 2026-04-28: topFiles removed from MetricSummary).
 * Export this type so frontend panels can import it when needed.
 */
export interface FileTouchBucket {
  /** Absolute or relative file path as emitted by the tool_use event. */
  path: string;
  /** Number of distinct turns that included this path in their filesTouched array. */
  touches: number;
}

// ---------------------------------------------------------------------------
// Session summary (for /api/sessions)
// ---------------------------------------------------------------------------

/** Session-level summary returned by GET /api/sessions. */
export interface SessionSummary {
  sessionId: string;
  /** Full absolute cwd path (e.g. "/Users/x/.claude/projects/my-app"). */
  project: string;
  /** Human-readable project name derived from path.basename(cwd). */
  projectName: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  events: number;
  /**
   * ISO 8601 timestamp of the first turn in this session (UTC). null when the session
   * has been evicted from the in-memory sessionTimes map (sessions older than the
   * 50,000-entry LRU cap). Matches the format and semantics of SessionDetail.firstTs.
   */
  firstTs: string | null;
  isSubagent: boolean;
  /**
   * Top-3 tools by invocation count across all turns in this session.
   * Sorted descending by count. Empty array when no tool data is available.
   */
  topTools: ToolBucket[];
  /**
   * Total count of distinct tool names seen across all turns in this session.
   * Used to derive the "+N more" overflow badge in the list chip column.
   * 0 when no tool data is available.
   */
  toolNamesCount: number;
}

// ---------------------------------------------------------------------------
// Session detail types (for GET /api/sessions/:id)
// ---------------------------------------------------------------------------

/**
 * Lightweight per-turn shape for the session detail view.
 * One entry per TokenRow in the session, sorted ascending by timestamp.
 */
export interface SessionTurnRow {
  /**
   * Local ISO 8601 timestamp with UTC offset, derived from row.date + row.hour.
   * Same format as TurnBucket.timestamp: "2026-04-15T14:00:00.000-05:00".
   */
  timestamp: string;
  modelId: string;
  modelFamily: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /**
   * Turn duration in milliseconds from the system/turn_duration event.
   * null when no duration event was recorded for this turn.
   */
  durationMs: number | null;
  /**
   * Per-tool invocation counts for this turn.
   * Empty object when no tool_use events were associated with this turn
   * (normalises undefined on TokenRow to a defined empty record).
   */
  toolUses: Record<string, number>;
  /**
   * Per-tool error counts for this turn.
   * Empty object when no tool errors occurred within this turn.
   */
  toolErrors: Record<string, number>;
}

/**
 * Full session rollup returned by GET /api/sessions/:id.
 * Includes token/cost totals, per-tool aggregates, and per-turn detail rows.
 */
export interface SessionDetail {
  sessionId: string;
  /** Full absolute cwd path. */
  project: string;
  /** Human-readable project name derived from path.basename(cwd). */
  projectName: string;
  costUsd: number;
  /**
   * Per-component USD cost breakdown for the session.
   * Sum of input + output + cacheCreate + cacheRead equals the total costUsd
   * field, modulo small rounding differences. All values default to 0 when no
   * priced rows are in the session.
   */
  costBreakdown: {
    /** USD cost attributed to raw input tokens for the session. */
    input: number;
    /** USD cost attributed to output tokens for the session. */
    output: number;
    /** USD cost attributed to cache creation tokens for the session. */
    cacheCreate: number;
    /** USD cost attributed to cache read tokens for the session. */
    cacheRead: number;
  };
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Count of web search requests across all turns in this session. */
  webSearchRequests: number;
  /** Count of assistant turns (TokenRows) in this session. */
  events: number;
  isSubagent: boolean;
  /**
   * ISO 8601 timestamp of the first turn in the session.
   * null when the session has been evicted from the in-memory sessionTimes map
   * (applies to sessions older than the 50,000-entry LRU cap).
   */
  firstTs: string | null;
  /**
   * ISO 8601 timestamp of the last turn in the session.
   * null when evicted from the sessionTimes map (same condition as firstTs).
   */
  lastTs: string | null;
  /**
   * Truncated text of the first user-role message in this session, server-hard-capped to 500 chars.
   * null when no qualifying user message was found or the entry has been evicted.
   * Privacy intent: server hard-truncates so the wire shape is bounded; the API never
   * serves the full transcript or the JSONL file contents. Pair with initialPromptTruncated
   * and jsonlPath as the only data surfaces beyond aggregates.
   */
  initialPrompt: string | null;
  /**
   * True when the original first-user-message text exceeded the server-side cap (500 chars)
   * and initialPrompt has been truncated. False when null/short. Drives the "(truncated)"
   * indicator in the UI.
   */
  initialPromptTruncated: boolean;
  /**
   * Absolute filesystem path of the first JSONL file that contained an event for this
   * session. null when not captured (older sessions or evicted entries). Path string only —
   * the API does NOT serve the file contents; this is metadata for "Reveal in Finder" /
   * copy-to-clipboard affordances on the client.
   */
  jsonlPath: string | null;
  /** Tool usage aggregated across all turns in this session. */
  byTool: ToolBucket[];
  /** Per-turn detail rows, sorted ascending by timestamp (oldest first). */
  turns: SessionTurnRow[];
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
  /**
   * Count of distinct projectName basenames in the unfiltered (all-time) row set.
   * Populated from Set<TokenRow.projectName>. Retained alongside totalProjects
   * (which counts raw cwd strings) for backward compatibility.
   * Structurally totalProjectsTouched ≤ totalProjects since multiple cwd paths
   * can share the same basename.
   */
  totalProjectsTouched: number;

  // ── Windowed totals ──
  costUsd30d: number;
  costUsd5d: number;
  inputTokens30d: number;
  outputTokens30d: number;
  /**
   * Sum of (cacheCreation5m + cacheCreation1h) for rows in the absolute 30-day
   * window (project-filtered only, same source set as inputTokens30d/outputTokens30d).
   * 0 when no cache-creation events exist in the window.
   */
  cacheCreationTokens30d: number;
  /**
   * Sum of cacheReadTokens for rows in the absolute 30-day window
   * (project-filtered only, same source set as inputTokens30d/outputTokens30d).
   * 0 when no cache-read events exist in the window.
   */
  cacheReadTokens30d: number;

  // ── Series / breakdown arrays ─────────────────────────────────────────────
  dailySeries: DailyBucket[];
  weeklySeries: WeeklyBucket[];
  byModel: ModelBucket[];
  byProject: ProjectBucket[];
  /** Per-project rollup for the absolute 30-day window, sorted by cost. */
  byProject30d: ProjectBucket[];
  /** Top N sessions by cost. */
  bySession: SessionBucket[];
  /** Raw per-(date, hour) entries; NOT pre-aggregated by dayOfWeek. */
  heatmapData: HeatmapPoint[];

  // ── New analytics breakdown arrays (tools + subagents) ───────────────────

  /**
   * Per-tool invocation and error counts over the filtered window.
   * Populated from TokenRow.toolUses and TokenRow.toolErrors.
   * Empty array when no tool_use events have been ingested.
   */
  byTool: ToolBucket[];

  /**
   * Per-subagent-type aggregated stats over the filtered window.
   * Only rows where isSubagent === true contribute.
   * Empty array when no subagent turns are present.
   */
  bySubagent: SubagentBucket[];

  // ── Files-touched KPI ─────────────────────────────────────────────────────

  /**
   * Count of unique file paths touched across all rows in the filtered window.
   * Populated from the union of TokenRow.filesTouched arrays.
   * 0 when no tool_use events with file_path have been ingested.
   *
   * NOTE: topFiles (top-N paths by touch count) is intentionally NOT included
   * here — it has no current frontend consumer. Use FileTouchBucket if needed.
   */
  totalFilesTouched: number;

  // ── Cost-per-turn KPIs (30-day window and prior 30-day window) ────────────

  /**
   * Mean costUsd per turn in the 30-day absolute window.
   * 0 when no turns exist in the window.
   */
  avgCostPerTurn30d: number;

  /**
   * Mean costUsd per turn in the prior 30-day window (days 31–60 from today).
   * Used for delta comparison with avgCostPerTurn30d.
   * 0 when no turns exist in the prior window.
   */
  avgCostPerTurnPrev30d: number;

  // ── Tool error rate KPI (30-day window) ───────────────────────────────────

  /**
   * Ratio of total tool errors to total tool invocations in the 30-day window.
   * 0..1 range. 0 when no tool invocations exist in the window.
   */
  toolErrorRate30d: number;

  /**
   * Pricing-source and precision metadata for this response. The numeric
   * costUsd fields remain display-oriented USD numbers; this object carries
   * integer micro-USD totals and fallback warnings for audit workflows.
   */
  pricingAudit: PricingAuditSummary;

  /**
   * Parser and indexing completeness metadata. This makes malformed files,
   * skipped rows, and dedup losses visible to the dashboard instead of only
   * existing in server logs.
   */
  ingestionAudit: IngestionAuditSummary;

  // ── Cost-driver diagnostics (30-day absolute window) ─────────────────────

  /**
   * Billing-component breakdown for the 30-day absolute window.
   * This is the primary source for "what is actually driving spend?"
   */
  costComponents30d: CostComponentSummary;

  /** Share of 30d spend captured by the top 1% most expensive turns. */
  turnCostTop1PctShare30d: number;

  /** Share of 30d spend captured by the top 5% most expensive turns. */
  turnCostTop5PctShare30d: number;

  /** Cost from non-subagent rows in the 30-day absolute window. */
  mainSessionCostUsd30d: number;

  /** Cost from subagent rows in the 30-day absolute window. */
  subagentCostUsd30d: number;

  /** Number of `Agent` tool invocations observed in the 30-day window. */
  agentToolCalls30d: number;

  /**
   * Estimated 30d savings if all Opus-priced rows had been priced as Sonnet.
   * This is a routing hypothesis, not a recommendation by itself.
   */
  opusToSonnetSavings30d: number;

  /**
   * Ranked, heuristic optimization opportunities. Values are derived from
   * observed local session data and should be treated as candidates for
   * controlled before/after experiments, not guaranteed savings.
   */
  optimizationOpportunities: OptimizationOpportunity[];

  // ── Turn-cost percentiles (30-day absolute window) ────────────────────────
  //
  // These three fields are computed from the distribution of per-turn costUsd
  // values for all rows in the last 30 calendar days (project-filtered, same
  // source as avgCostPerTurn30d). Sorted ascending; index = floor(p/100 * n)
  // clamped to [0, n-1]. Zero when no turns exist in the window.

  /**
   * 50th-percentile (median) per-turn cost in USD within the 30-day window.
   * Window: today − 30 days to today (project-filtered only).
   * Units: USD. Zero-state: 0 when no turns exist in the window.
   */
  turnCostP50_30d: number;

  /**
   * 90th-percentile per-turn cost in USD within the 30-day window.
   * Window: today − 30 days to today (project-filtered only).
   * Units: USD. Zero-state: 0 when no turns exist in the window.
   */
  turnCostP90_30d: number;

  /**
   * 99th-percentile per-turn cost in USD within the 30-day window.
   * Window: today − 30 days to today (project-filtered only).
   * Units: USD. Zero-state: 0 when no turns exist in the window.
   */
  turnCostP99_30d: number;

  // ── Prior 30-day window totals (days 31–60 from today) ───────────────────
  //
  // These three fields mirror inputTokens30d / outputTokens30d / costUsd30d
  // but for the immediately preceding 30-day window (days 31–60 from today).
  // Source: projectFiltered rows (project-only filter, no since filter).
  // Used by the frontend to compute prev-period deltas without a second API call.

  /**
   * Sum of inputTokens for rows in the prior 30-day window (days 31–60 from today).
   * Window: today − 60 days to today − 31 days inclusive (project-filtered only).
   * Units: token count. Zero-state: 0 when no rows exist in the prior window.
   */
  inputTokensPrev30d: number;

  /**
   * Sum of outputTokens for rows in the prior 30-day window (days 31–60 from today).
   * Window: today − 60 days to today − 31 days inclusive (project-filtered only).
   * Units: token count. Zero-state: 0 when no rows exist in the prior window.
   */
  outputTokensPrev30d: number;

  /**
   * Sum of costUsd for rows in the prior 30-day window (days 31–60 from today).
   * Window: today − 60 days to today − 31 days inclusive (project-filtered only).
   * Units: USD. Zero-state: 0 when no rows exist in the prior window.
   * Used by the frontend to derive cost-per-output-token prev-30d delta:
   *   costUsd30dPrev / outputTokensPrev30d (guard: outputTokensPrev30d === 0 → em-dash).
   */
  costUsd30dPrev: number;

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
