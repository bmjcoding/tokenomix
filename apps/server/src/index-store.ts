/**
 * In-memory aggregation engine for tokenomix server.
 *
 * IndexStore extends EventEmitter and owns:
 *   - A Map<dedup-key, TokenRow> that deduplicates by (requestId, message.id).
 *   - A lazy aggregate snapshot invalidated on every ingest.
 *   - Batch-parallel startup scan (50 files per batch) to bound fd usage.
 *
 * Dedup key: `${requestId}:${messageId}` — BOTH must be present.
 * If either is missing, the event is not counted.
 *
 * Timestamp handling: convert UTC ISO → system-local naive datetime before
 * bucketing into daily / weekly slices.
 */

import { EventEmitter } from 'node:events';
import type { Dirent } from 'node:fs';
import { readdir as readdirFn } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  BedrockEndpointScope,
  BedrockServiceTier,
  CostComponentSummary,
  DailyBucket,
  HeatmapPoint,
  IngestionAuditSummary,
  MetricSummary,
  MetricsQuery,
  ModelBucket,
  OptimizationOpportunity,
  PeriodComparison,
  PeriodRollup,
  PricingAuditSummary,
  PricingProvider,
  ProjectBucket,
  RawUsage,
  RawUsageEventParsed,
  SessionBucket,
  SessionDetail,
  SessionDurationStats,
  SessionSummary,
  SessionTurnRow,
  SubagentBucket,
  SystemTurnDurationEventParsed,
  TokenRow,
  ToolBucket,
  ToolResultContentParsed,
  ToolResultEventParsed,
  ToolUseContentParsed,
  ToolUseEventParsed,
  TurnBucket,
  WeeklyBucket,
} from '@tokenomix/shared';
import { logEvent } from './logger.js';
import { parseJSONLFile } from './parser.js';
import {
  ANTHROPIC_1P_PRICING_CATALOG_METADATA,
  AWS_BEDROCK_PRICING_CATALOG_METADATA,
  computeCostWithFamily,
  inferBedrockEndpointScope,
  MODEL_PRICES,
  microsToUsd,
  model_family,
  resolveCacheTokens,
} from './pricing.js';
import { formatLocalHourIso, formatLocalIso } from './time.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROJECTS_DIR = nodePath.resolve(os.homedir(), '.claude', 'projects');

const BATCH_SIZE = 50;

/**
 * Maximum number of session entries retained in the sessionTimes Map.
 * When the Map exceeds this size, the oldest 10% of entries (by firstTs)
 * are evicted in a batch to amortize sort cost. This bounds memory usage
 * even under continuous high-volume ingest.
 */
const MAX_SESSION_TIMES = 50_000;

interface PricingRuntimeConfig {
  provider: PricingProvider;
  bedrockRegion: string | null;
  bedrockEndpointScope: BedrockEndpointScope;
  bedrockServiceTier: BedrockServiceTier;
}

interface FileIngestionAudit {
  invalidJsonLines: number;
  schemaMismatchLines: number;
  fileOpenErrors: number;
  assistantUsageEvents: number;
  assistantEventsWithoutUsage: number;
  missingDedupIdRows: number;
  duplicateRowsSkipped: number;
  duplicateRowsReplaced: number;
  tokenRowsRejected: number;
  rowsIndexed: number;
  ingestErrors: number;
  lastIndexedAt: string;
}

function emptyFileIngestionAudit(): FileIngestionAudit {
  return {
    invalidJsonLines: 0,
    schemaMismatchLines: 0,
    fileOpenErrors: 0,
    assistantUsageEvents: 0,
    assistantEventsWithoutUsage: 0,
    missingDedupIdRows: 0,
    duplicateRowsSkipped: 0,
    duplicateRowsReplaced: 0,
    tokenRowsRejected: 0,
    rowsIndexed: 0,
    ingestErrors: 0,
    lastIndexedAt: formatLocalIso(),
  };
}

function normalizePricingProvider(value: string | undefined): PricingProvider {
  if (value === 'aws_bedrock' || value === 'internal_gateway' || value === 'anthropic_1p') {
    return value;
  }
  return 'anthropic_1p';
}

function normalizeBedrockEndpointScope(value: string | undefined): BedrockEndpointScope {
  if (
    value === 'in_region' ||
    value === 'global_cross_region' ||
    value === 'geographic_cross_region' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeBedrockServiceTier(value: string | undefined): BedrockServiceTier {
  if (
    value === 'standard' ||
    value === 'batch' ||
    value === 'provisioned' ||
    value === 'reserved' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'standard';
}

function pricingRuntimeConfig(): PricingRuntimeConfig {
  return {
    provider: normalizePricingProvider(process.env.TOKENOMIX_PRICING_PROVIDER),
    bedrockRegion: process.env.TOKENOMIX_BEDROCK_REGION ?? null,
    bedrockEndpointScope: normalizeBedrockEndpointScope(
      process.env.TOKENOMIX_BEDROCK_ENDPOINT_SCOPE
    ),
    bedrockServiceTier: normalizeBedrockServiceTier(process.env.TOKENOMIX_BEDROCK_SERVICE_TIER),
  };
}

function pricingCatalogForConfig(
  config: PricingRuntimeConfig,
  internalGatewayCostBasis:
    | 'rated_internal_gateway_cost'
    | 'estimated_from_jsonl_usage_without_gateway_rated_cost' = 'estimated_from_jsonl_usage_without_gateway_rated_cost'
) {
  if (config.provider === 'aws_bedrock') return AWS_BEDROCK_PRICING_CATALOG_METADATA;
  if (config.provider === 'internal_gateway') {
    return {
      ...AWS_BEDROCK_PRICING_CATALOG_METADATA,
      pricingProvider: 'internal_gateway' as const,
      costBasis: internalGatewayCostBasis,
    };
  }
  return ANTHROPIC_1P_PRICING_CATALOG_METADATA;
}

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 timestamp string into a local naive Date.
 *
 * - "Z" suffix → parse as UTC (JavaScript Date always parses UTC correctly).
 * - Other formats → parse as-is.
 * - Returns null if the string is empty or unparseable.
 *
 * The resulting Date object carries local-time methods (getHours, getDate, etc.)
 * so buckets align with the user's local calendar.
 */
function parseIso(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Format a Date as YYYY-MM-DD in system local time. */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Return 0-23 hour in system local time. */
function toLocalHour(d: Date): number {
  return d.getHours();
}

/** ISO week start (Monday) as YYYY-MM-DD. */
function isoWeekStart(d: Date): string {
  const clone = new Date(d.getTime());
  const day = clone.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMon = day === 0 ? -6 : 1 - day;
  clone.setDate(clone.getDate() + diffToMon);
  return toLocalDateStr(clone);
}

// ---------------------------------------------------------------------------
// Period bound helpers
// ---------------------------------------------------------------------------

interface PeriodBounds {
  start: Date;
  end: Date;
  /** Number of calendar days in the period. */
  days: number;
}

/** Returns the first and last instant of the calendar month containing d (local time). */
function monthBounds(d: Date): PeriodBounds {
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  const days = end.getDate(); // last day of month == day count
  return { start, end, days };
}

/** Returns the first and last instant of the calendar quarter containing d (local time). */
function quarterBounds(d: Date): PeriodBounds {
  const q = Math.floor(d.getMonth() / 3); // 0-3
  const startMonth = q * 3;
  const year = d.getFullYear();
  const start = new Date(year, startMonth, 1, 0, 0, 0, 0);
  const end = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  // Count days from calendar components: sum the actual days in each month
  // of the quarter. This avoids off-by-one errors from millisecond arithmetic
  // when end is set to 23:59:59.999 (which is slightly less than a full day).
  let days = 0;
  for (let mo = startMonth; mo < startMonth + 3; mo++) {
    // Day 0 of month mo+1 === last day of month mo.
    days += new Date(year, mo + 1, 0).getDate();
  }
  return { start, end, days };
}

/** Returns the first and last instant of the calendar year containing d (local time). */
function yearBounds(d: Date): PeriodBounds {
  const year = d.getFullYear();
  const start = new Date(year, 0, 1, 0, 0, 0, 0);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);
  // Leap-year safe: check whether Feb 29 exists in this year.
  const isLeap = new Date(year, 1, 29).getMonth() === 1;
  const days = isLeap ? 366 : 365;
  return { start, end, days };
}

/** Shift a period back by one unit (month, quarter, or year). */
type PeriodType = 'month' | 'quarter' | 'year';
function previousPeriodDate(current: Date, type: PeriodType): Date {
  const d = new Date(current.getTime());
  if (type === 'month') {
    d.setDate(1); // avoid month-overflow (e.g. Mar 31 → Feb 31)
    d.setMonth(d.getMonth() - 1);
  } else if (type === 'quarter') {
    d.setDate(1);
    d.setMonth(d.getMonth() - 3);
  } else {
    d.setFullYear(d.getFullYear() - 1);
  }
  return d;
}

/**
 * Build a Map<YYYY-MM-DD, dayIndex> for every calendar day in [bounds.start,
 * bounds.end] inclusive.
 *
 * Uses Date.UTC to advance one day at a time so that the iteration is immune
 * to DST transitions: UTC midnight values are always exactly 86 400 000 ms
 * apart regardless of the local timezone.
 *
 * The returned map has exactly bounds.days entries.
 */
function buildDayIndexMap(bounds: PeriodBounds): Map<string, number> {
  const map = new Map<string, number>();
  // Represent the start date as a UTC midnight using its local calendar
  // components so that we iterate calendar days, not 24-hour intervals.
  const sy = bounds.start.getFullYear();
  const sm = bounds.start.getMonth();
  const sd = bounds.start.getDate();
  let utcMs = Date.UTC(sy, sm, sd);
  for (let idx = 0; idx < bounds.days; idx++) {
    const d = new Date(utcMs);
    // Format the calendar date that this UTC midnight corresponds to.
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(d.getUTCDate()).padStart(2, '0');
    map.set(`${y}-${mo}-${dy}`, idx);
    utcMs += 86_400_000;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Median of a sorted (ascending) array of numbers. Returns 0 for empty arrays. */
function medianSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** P90 of a sorted (ascending) array. Returns 0 for empty arrays. */
function p90Sorted(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.9) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Compute SessionDurationStats from a pre-filtered per-session time map.
 *
 * Accepts any Map<sessionId, {firstTs, lastTs}> — callers are responsible for
 * pre-filtering to the desired period before calling this helper.
 * Sessions with duration >= 180 minutes are treated as outliers and excluded.
 * weeklyMedianTrend returns at most MAX_WEEKS entries (oldest → newest).
 */
function computeDurationStatsForSessions(
  filteredSessionTimes: Map<string, { firstTs: number; lastTs: number }>
): SessionDurationStats {
  const OUTLIER_THRESHOLD = 180; // minutes
  const MAX_WEEKS = 12;

  const allDurations: number[] = [];
  let outliersExcluded = 0;

  // Per ISO-week-start string → list of non-outlier durations.
  const weekBuckets = new Map<string, number[]>();

  for (const [, times] of filteredSessionTimes) {
    const durationMinutes = (times.lastTs - times.firstTs) / 60_000;
    if (durationMinutes >= OUTLIER_THRESHOLD) {
      outliersExcluded++;
      continue;
    }
    allDurations.push(durationMinutes);

    // Bucket by ISO week of firstTs.
    const firstDate = new Date(times.firstTs);
    const weekKey = isoWeekStart(firstDate);
    const bucket = weekBuckets.get(weekKey);
    if (bucket) {
      bucket.push(durationMinutes);
    } else {
      weekBuckets.set(weekKey, [durationMinutes]);
    }
  }

  allDurations.sort((a, b) => a - b);

  // Build weekly trend: take last MAX_WEEKS weeks (sorted oldest → newest).
  // For short periods (e.g., one month) this may return fewer than 12 entries.
  const allWeeks = [...weekBuckets.keys()].sort();
  const recentWeeks = allWeeks.slice(-MAX_WEEKS);
  const weeklyMedianTrend = recentWeeks.map((wk) => {
    const bucket = [...(weekBuckets.get(wk) ?? [])].sort((a, b) => a - b);
    return medianSorted(bucket);
  });

  return {
    medianMinutes: medianSorted(allDurations),
    p90Minutes: p90Sorted(allDurations),
    weeklyMedianTrend,
    outliersExcluded,
    totalCounted: allDurations.length,
  };
}

function emptyCostComponents(): CostComponentSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheCreationCostUsd: 0,
    cacheReadCostUsd: 0,
    webSearchCostUsd: 0,
  };
}

function fallbackCostComponentsForRow(row: TokenRow): {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheCreationCostUsd: number;
  cacheReadCostUsd: number;
  webSearchCostUsd: number;
} {
  const prices = MODEL_PRICES[row.modelFamily] ?? MODEL_PRICES.sonnet;
  const multiplier = row.pricingMultiplier ?? 1;
  return {
    inputCostUsd: ((row.inputTokens * (prices?.input ?? 0)) / 1_000_000) * multiplier,
    outputCostUsd: ((row.outputTokens * (prices?.output ?? 0)) / 1_000_000) * multiplier,
    cacheCreationCostUsd:
      ((row.cacheCreation5m * (prices?.cache_creation_5m ?? 0)) / 1_000_000 +
        (row.cacheCreation1h * (prices?.cache_creation_1h ?? 0)) / 1_000_000) *
      multiplier,
    cacheReadCostUsd: ((row.cacheReadTokens * (prices?.cache_read ?? 0)) / 1_000_000) * multiplier,
    webSearchCostUsd: row.webSearchRequests * 0.01,
  };
}

function rowCostUsdMicros(row: TokenRow): number {
  return row.costUsdMicros ?? Math.round(row.costUsd * 1_000_000);
}

function rowBillableTokenTotal(row: TokenRow): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.cacheCreation5m +
    row.cacheCreation1h +
    row.cacheReadTokens
  );
}

function shouldReplaceDuplicateRow(args: {
  existingRow: TokenRow;
  existingTimestampMs: number | undefined;
  candidateRow: TokenRow;
  candidateTimestampMs: number | undefined;
}): boolean {
  const { existingRow, existingTimestampMs, candidateRow, candidateTimestampMs } = args;

  if (candidateTimestampMs !== undefined && existingTimestampMs !== undefined) {
    if (candidateTimestampMs > existingTimestampMs) return true;
    if (candidateTimestampMs < existingTimestampMs) return false;
  } else if (candidateTimestampMs !== undefined) {
    return true;
  } else if (existingTimestampMs !== undefined) {
    return false;
  }

  const candidateMicros = rowCostUsdMicros(candidateRow);
  const existingMicros = rowCostUsdMicros(existingRow);
  if (candidateMicros > existingMicros) return true;
  if (candidateMicros < existingMicros) return false;

  return rowBillableTokenTotal(candidateRow) > rowBillableTokenTotal(existingRow);
}

function addCostComponents(acc: CostComponentSummary, row: TokenRow): void {
  const fallback = fallbackCostComponentsForRow(row);
  acc.inputTokens += row.inputTokens;
  acc.outputTokens += row.outputTokens;
  acc.cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
  acc.cacheReadTokens += row.cacheReadTokens;
  acc.webSearchRequests += row.webSearchRequests;
  acc.inputCostUsd += row.inputCostUsd ?? fallback.inputCostUsd;
  acc.outputCostUsd += row.outputCostUsd ?? fallback.outputCostUsd;
  acc.cacheCreationCostUsd += row.cacheCreationCostUsd ?? fallback.cacheCreationCostUsd;
  acc.cacheReadCostUsd += row.cacheReadCostUsd ?? fallback.cacheReadCostUsd;
  acc.webSearchCostUsd += row.webSearchCostUsd ?? fallback.webSearchCostUsd;
}

function estimateOpusToSonnetSavings(row: TokenRow): number {
  if (row.modelFamily !== 'opus' && row.modelFamily !== 'opus_legacy') return 0;
  const sonnet = MODEL_PRICES.sonnet;
  if (!sonnet) return 0;
  const multiplier = row.pricingMultiplier ?? 1;
  const sonnetCost =
    ((row.inputTokens * sonnet.input) / 1_000_000 +
      (row.outputTokens * sonnet.output) / 1_000_000 +
      (row.cacheCreation5m * sonnet.cache_creation_5m) / 1_000_000 +
      (row.cacheCreation1h * sonnet.cache_creation_1h) / 1_000_000 +
      (row.cacheReadTokens * sonnet.cache_read) / 1_000_000) *
      multiplier +
    (row.webSearchCostUsd ?? row.webSearchRequests * 0.01);
  return Math.max(0, row.costUsd - sonnetCost);
}

function shareOfTotal(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function displayPathSegment(pathLike: string): string {
  const trimmed = pathLike.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]+/);
  return parts[parts.length - 1] || trimmed;
}

function decodeClaudeProjectDirName(name: string): string {
  if (!name.startsWith('-')) return name;
  const sentinel = '\u0000';
  return `/${name
    .slice(1)
    .replace(/--/g, `${sentinel}.`)
    .replace(/-/g, '/')
    .replaceAll(sentinel, '/')}`;
}

function projectPathFromJsonlPath(filePath: string): string {
  const relative = nodePath.relative(PROJECTS_DIR, filePath);
  if (relative.startsWith('..') || nodePath.isAbsolute(relative)) return '';
  const projectDir = relative.split(/[\\/]+/)[0];
  return projectDir ? decodeClaudeProjectDirName(projectDir) : '';
}

function projectLabelForDisplay(project: string): string {
  return displayPathSegment(project) || 'current project';
}

function isSubagentFilePath(filePath: string): boolean {
  return /(^|[\\/])subagents([\\/]|$)/.test(filePath);
}

function numberField(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function externalCostUsdMicros(event: RawUsageEventParsed): number | undefined {
  const raw = event as unknown as Record<string, unknown>;
  const micros = numberField(raw, [
    'costUsdMicros',
    'cost_usd_micros',
    'gatewayCostUsdMicros',
    'internalCostUsdMicros',
    'chargebackCostUsdMicros',
  ]);
  if (micros !== undefined) return Math.round(micros);

  const usd = numberField(raw, [
    'costUsd',
    'cost_usd',
    'gatewayCostUsd',
    'internalCostUsd',
    'chargebackCostUsd',
  ]);
  return usd !== undefined ? Math.round(usd * 1_000_000) : undefined;
}

function formatUsdCompact(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function buildOptimizationOpportunities(args: {
  costUsd30d: number;
  components: CostComponentSummary;
  byProject30d: ProjectBucket[];
  bashToolCalls30d: number;
  turnCostTop5PctShare30d: number;
  mainSessionCostUsd30d: number;
  subagentCostUsd30d: number;
  agentToolCalls30d: number;
  opusToSonnetSavings30d: number;
}): OptimizationOpportunity[] {
  // Rule scores are deterministic analyst heuristics, not LLM inference and
  // not probabilities. They express how directly the observed metric supports
  // the proposed experiment.
  const opportunities: OptimizationOpportunity[] = [];
  const {
    costUsd30d,
    components,
    byProject30d,
    bashToolCalls30d,
    turnCostTop5PctShare30d,
    mainSessionCostUsd30d,
    subagentCostUsd30d,
    agentToolCalls30d,
    opusToSonnetSavings30d,
  } = args;

  const cacheUsd = components.cacheCreationCostUsd + components.cacheReadCostUsd;
  const cacheShare = shareOfTotal(cacheUsd, costUsd30d);
  if (cacheShare >= 0.45) {
    opportunities.push({
      id: 'context-cache-pressure',
      category: 'context',
      title: 'Context rereads dominate cost',
      recommendation:
        'Measure Graphify-assisted navigation, shorter sessions, earlier /clear or /compact policies, narrower file reads, and reusable project notes on the projects with the highest cache-read cost.',
      evidence: `${formatUsdCompact(cacheUsd)} of 30d spend (${(cacheShare * 100).toFixed(0)}%) came from cache creation/read.`,
      impactUsd30d: cacheUsd * 0.12,
      confidence: 0.72,
    });
  }

  if (opusToSonnetSavings30d >= Math.max(25, costUsd30d * 0.05)) {
    opportunities.push({
      id: 'opus-routing',
      category: 'model',
      title: 'Opus routing needs an audit',
      recommendation:
        'Run matched Sonnet trials for low-risk Opus-heavy workflows and compare task completion, rework, tests, and review defects before changing defaults.',
      evidence: `A pure pricing counterfactual says Sonnet-priced Opus rows would cost about ${formatUsdCompact(opusToSonnetSavings30d)} less over 30d.`,
      impactUsd30d: opusToSonnetSavings30d,
      confidence: 0.52,
    });
  }

  if (bashToolCalls30d >= 100) {
    opportunities.push({
      id: 'rtk-bash-output',
      category: 'tooling',
      title: 'Bash output is large enough for RTK trials',
      recommendation:
        'Enable RTK for a controlled Bash-heavy cohort, then compare tool-result token volume, failed-command recovery, and total session cost.',
      evidence: `Observed ${bashToolCalls30d.toLocaleString('en-US')} Bash calls over 30d.`,
      impactUsd30d: components.outputCostUsd * 0.08 + components.cacheReadCostUsd * 0.03,
      confidence: 0.61,
    });
  }

  if (turnCostTop5PctShare30d >= 0.2) {
    opportunities.push({
      id: 'expensive-turn-outliers',
      category: 'workflow',
      title: 'A small number of turns drive spend',
      recommendation:
        'Add a top-turn drilldown that shows token component, model, project, tools used, and preceding context size for the top 5% most expensive turns.',
      evidence: `The top 5% most expensive turns account for ${(turnCostTop5PctShare30d * 100).toFixed(0)}% of 30d spend.`,
      impactUsd30d: costUsd30d * turnCostTop5PctShare30d * 0.15,
      confidence: 0.68,
    });
  }

  const topProject = byProject30d[0];
  if (topProject && costUsd30d > 0 && topProject.costUsd / costUsd30d >= 0.25) {
    const projectName = projectLabelForDisplay(topProject.project);
    opportunities.push({
      id: 'top-project-concentration',
      category: 'project',
      title: `${projectName} is the first optimization target`,
      recommendation:
        'Run the first Graphify, RTK, and model-routing experiments here, because this project has enough spend concentration to produce a measurable signal quickly.',
      evidence: `${projectName} accounts for ${((topProject.costUsd / costUsd30d) * 100).toFixed(0)}% of 30d spend.`,
      impactUsd30d: topProject.costUsd * 0.1,
      confidence: 0.66,
      project: topProject.project,
    });
  }

  const subagentShare = shareOfTotal(
    subagentCostUsd30d,
    mainSessionCostUsd30d + subagentCostUsd30d
  );
  if (subagentShare >= 0.3 && agentToolCalls30d > 0) {
    opportunities.push({
      id: 'subagent-cost-governance',
      category: 'workflow',
      title: 'Subagents are a major cost center',
      recommendation:
        'Track Agent-tool dispatches separately from subagent turns and require per-agent budgets, scope limits, and success criteria before broad dispatch.',
      evidence: `Subagent rows account for ${(subagentShare * 100).toFixed(0)}% of 30d spend across ${agentToolCalls30d.toLocaleString('en-US')} Agent tool calls.`,
      impactUsd30d: subagentCostUsd30d * 0.08,
      confidence: 0.58,
    });
  }

  return opportunities
    .sort((a, b) => b.impactUsd30d * b.confidence - a.impactUsd30d * a.confidence)
    .slice(0, 6);
}

function buildPricingAudit(rows: TokenRow[], config: PricingRuntimeConfig): PricingAuditSummary {
  let totalCostUsdMicros = 0;
  let fallbackPricedRows = 0;
  let fallbackPricedCostUsdMicros = 0;
  let zeroUsageUnknownModelRows = 0;
  let internalGatewayRatedRows = 0;
  let internalGatewayUnratedRows = 0;
  const fallbackModelIds = new Set<string>();
  const inferredBedrockScopes = new Set<BedrockEndpointScope>();

  for (const row of rows) {
    const rowMicros = rowCostUsdMicros(row);
    totalCostUsdMicros += rowMicros;
    const inferredScope = inferBedrockEndpointScope(row.modelId);
    if (inferredScope !== 'unknown') inferredBedrockScopes.add(inferredScope);

    if (row.pricingStatus === 'fallback_sonnet') {
      fallbackPricedRows += 1;
      fallbackPricedCostUsdMicros += rowMicros;
      fallbackModelIds.add(row.modelId || '<missing>');
    } else if (row.pricingStatus === 'zero_usage_unknown_model') {
      zeroUsageUnknownModelRows += 1;
    } else if (row.pricingStatus === 'internal_gateway_rated') {
      internalGatewayRatedRows += 1;
    } else if (row.pricingStatus === 'internal_gateway_unrated_estimate') {
      internalGatewayUnratedRows += 1;
    }
  }

  const bedrockEndpointScope =
    config.bedrockEndpointScope !== 'unknown'
      ? config.bedrockEndpointScope
      : inferredBedrockScopes.size === 1
        ? ([...inferredBedrockScopes][0] ?? 'unknown')
        : 'unknown';
  const bedrockEndpointScopeSource =
    config.bedrockEndpointScope !== 'unknown'
      ? 'env'
      : inferredBedrockScopes.size === 1
        ? 'model_id'
        : 'unknown';

  const warnings: string[] = [];
  if (config.provider !== 'internal_gateway') {
    warnings.push(
      `Pricing provider is ${config.provider}; values are estimates from static public pricing, not internal LLM Gateway rated cost.`
    );
  }
  if (config.provider === 'internal_gateway' && internalGatewayUnratedRows > 0) {
    warnings.push(
      `${internalGatewayUnratedRows.toLocaleString('en-US')} row(s) are marked internal-gateway estimates because no gateway-rated cost feed is ingested.`
    );
  }
  if (config.provider === 'internal_gateway' && internalGatewayRatedRows > 0) {
    warnings.push(
      'Internal gateway rated rows use rated total cost; token-component breakdowns are proportional estimates unless gateway component costs are ingested.'
    );
  }
  if (
    (config.provider === 'aws_bedrock' || config.provider === 'internal_gateway') &&
    !config.bedrockRegion
  ) {
    warnings.push(
      'Bedrock region is not configured; regional price differences cannot be validated.'
    );
  }
  if (
    (config.provider === 'aws_bedrock' || config.provider === 'internal_gateway') &&
    bedrockEndpointScope === 'unknown'
  ) {
    warnings.push(
      'Bedrock endpoint scope is unknown; global/geographic/in-region endpoint pricing differences cannot be validated.'
    );
  }
  if (inferredBedrockScopes.size > 1 && config.bedrockEndpointScope === 'unknown') {
    warnings.push(
      `Multiple Bedrock endpoint scopes were inferred from model IDs (${[...inferredBedrockScopes].sort().join(', ')}); configure TOKENOMIX_BEDROCK_ENDPOINT_SCOPE for authoritative grouping.`
    );
  }
  if (
    (config.provider === 'aws_bedrock' || config.provider === 'internal_gateway') &&
    config.bedrockServiceTier !== 'standard'
  ) {
    warnings.push(
      `Bedrock service tier is configured as ${config.bedrockServiceTier}; row pricing only applies modifiers present in JSONL usage unless gateway-rated cost is ingested.`
    );
  }
  if (fallbackPricedRows > 0) {
    warnings.push(
      `${fallbackPricedRows.toLocaleString('en-US')} billable row(s) used Sonnet fallback pricing because the model ID was not recognized by the static catalog.`
    );
  }
  if (zeroUsageUnknownModelRows > 0) {
    warnings.push(
      `${zeroUsageUnknownModelRows.toLocaleString('en-US')} zero-usage row(s) had unrecognized model IDs and did not affect cost.`
    );
  }

  const internalGatewayCostBasis =
    config.provider === 'internal_gateway' &&
    internalGatewayRatedRows > 0 &&
    internalGatewayUnratedRows === 0
      ? 'rated_internal_gateway_cost'
      : 'estimated_from_jsonl_usage_without_gateway_rated_cost';

  return {
    catalog: pricingCatalogForConfig(config, internalGatewayCostBasis),
    provider: config.provider,
    bedrockRegion: config.bedrockRegion,
    bedrockEndpointScope,
    bedrockServiceTier: config.bedrockServiceTier,
    bedrockEndpointScopeSource,
    totalCostUsdMicros,
    fallbackPricedRows,
    fallbackPricedCostUsd: microsToUsd(fallbackPricedCostUsdMicros),
    fallbackPricedCostUsdMicros,
    fallbackPricedModelIds: [...fallbackModelIds].sort(),
    zeroUsageUnknownModelRows,
    internalGatewayRatedRows,
    internalGatewayUnratedRows,
    warnings,
  };
}

function buildIngestionAudit(args: {
  rowsIndexed: number;
  filesDiscovered: number;
  fileAudits: Iterable<FileIngestionAudit>;
}): IngestionAuditSummary {
  let filesAttempted = 0;
  let filesWithParseWarnings = 0;
  let invalidJsonLines = 0;
  let schemaMismatchLines = 0;
  let fileOpenErrors = 0;
  let assistantUsageEvents = 0;
  let assistantEventsWithoutUsage = 0;
  let missingDedupIdRows = 0;
  let duplicateRowsSkipped = 0;
  let duplicateRowsReplaced = 0;
  let tokenRowsRejected = 0;
  let ingestErrors = 0;
  let lastIndexedAt: string | null = null;

  for (const audit of args.fileAudits) {
    filesAttempted += 1;
    invalidJsonLines += audit.invalidJsonLines;
    schemaMismatchLines += audit.schemaMismatchLines;
    fileOpenErrors += audit.fileOpenErrors;
    assistantUsageEvents += audit.assistantUsageEvents;
    assistantEventsWithoutUsage += audit.assistantEventsWithoutUsage;
    missingDedupIdRows += audit.missingDedupIdRows;
    duplicateRowsSkipped += audit.duplicateRowsSkipped;
    duplicateRowsReplaced += audit.duplicateRowsReplaced;
    tokenRowsRejected += audit.tokenRowsRejected;
    ingestErrors += audit.ingestErrors;
    if (audit.invalidJsonLines > 0 || audit.schemaMismatchLines > 0 || audit.fileOpenErrors > 0) {
      filesWithParseWarnings += 1;
    }
    if (lastIndexedAt === null || audit.lastIndexedAt > lastIndexedAt) {
      lastIndexedAt = audit.lastIndexedAt;
    }
  }

  const warnings: string[] = [];
  if (filesAttempted < args.filesDiscovered) {
    warnings.push(
      `${(args.filesDiscovered - filesAttempted).toLocaleString('en-US')} discovered JSONL file(s) have not been parsed in this server process.`
    );
  }
  if (invalidJsonLines > 0) {
    warnings.push(
      `${invalidJsonLines.toLocaleString('en-US')} line(s) were skipped because they were not valid JSON.`
    );
  }
  if (schemaMismatchLines > 0) {
    warnings.push(
      `${schemaMismatchLines.toLocaleString('en-US')} line(s) were skipped because they did not match the accepted event schema.`
    );
  }
  if (fileOpenErrors > 0) {
    warnings.push(`${fileOpenErrors.toLocaleString('en-US')} file(s) could not be opened or read.`);
  }
  if (missingDedupIdRows > 0) {
    warnings.push(
      `${missingDedupIdRows.toLocaleString('en-US')} assistant usage row(s) were skipped because requestId or message.id was missing.`
    );
  }
  if (duplicateRowsSkipped + duplicateRowsReplaced > 0) {
    warnings.push(
      `${(duplicateRowsSkipped + duplicateRowsReplaced).toLocaleString('en-US')} duplicate assistant usage row(s) shared a requestId/message.id; ${duplicateRowsReplaced.toLocaleString('en-US')} replaced earlier rows and ${duplicateRowsSkipped.toLocaleString('en-US')} were skipped as older or lower-usage rows.`
    );
  }
  if (tokenRowsRejected > 0) {
    warnings.push(
      `${tokenRowsRejected.toLocaleString('en-US')} assistant usage event(s) could not be converted to token rows.`
    );
  }
  if (ingestErrors > 0) {
    warnings.push(
      `${ingestErrors.toLocaleString('en-US')} file-level ingestion error(s) were caught during indexing.`
    );
  }

  return {
    filesDiscovered: args.filesDiscovered,
    filesAttempted,
    filesWithParseWarnings,
    invalidJsonLines,
    schemaMismatchLines,
    fileOpenErrors,
    assistantUsageEvents,
    assistantEventsWithoutUsage,
    missingDedupIdRows,
    duplicateRowsSkipped,
    duplicateRowsReplaced,
    tokenRowsRejected,
    rowsIndexed: args.rowsIndexed,
    ingestErrors,
    lastIndexedAt,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively collect all *.jsonl paths under a directory.
 * Uses only node:fs/promises — no glob dependency.
 */
async function collectJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      // Cast needed because Node 22's readdir overload for withFileTypes returns
      // Dirent<Buffer> by default; specifying encoding:'utf-8' returns Dirent<string>.
      entries = (await readdirFn(current, {
        withFileTypes: true,
        encoding: 'utf-8',
      })) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const full = nodePath.join(current, name);
      if (entry.isSymbolicLink()) continue; // skip symlinks — avoids circular traversal
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/**
 * Build a TokenRow from a validated JSONL assistant event.
 * Returns null if essential fields are missing (usage, timestamp).
 *
 * `projectName` is derived here as `path.basename(cwd.replace(/\/+$/, ''))`.
 * Trailing slashes are stripped before `basename` so paths like `/foo/bar/`
 * yield `"bar"` rather than `""`. An empty cwd or cwd of `"/"` yields an
 * empty string; rows with an empty `projectName` are excluded from
 * `totalProjectsTouched` by the truthiness guard in `aggregate()`.
 *
 * Tool/duration fields (`toolUses`, `toolErrors`, `filesTouched`,
 * `turnDurationMs`) are NOT populated here — they are merged by
 * `ingestFileInternal()` after the two-pass accumulation.
 */
export function buildTokenRow(event: RawUsageEventParsed, filePath: string): TokenRow | null {
  const msg = event.message;
  if (!msg?.usage) return null;

  const modelId = msg.model ?? '';
  const usage = msg.usage;

  const ts = parseIso(event.timestamp ?? undefined);
  if (!ts) return null;

  // Use type assertion to bridge the Zod inferred type (objectOutputType with
  // passthrough) and the hand-written RawUsage interface. The shapes are
  // structurally identical at runtime.
  const rawUsage = usage as unknown as RawUsage;

  const { cache5m, cache1h } = resolveCacheTokens(rawUsage);
  const pricingConfig = pricingRuntimeConfig();
  const externalCostMicros = externalCostUsdMicros(event);
  const costComponents = computeCostWithFamily(rawUsage, modelId, model_family(modelId), {
    pricingProvider: pricingConfig.provider,
    externallyRated:
      pricingConfig.provider === 'internal_gateway' && externalCostMicros !== undefined,
    ...(externalCostMicros !== undefined ? { externalCostUsdMicros: externalCostMicros } : {}),
    bedrockEndpointScope:
      pricingConfig.bedrockEndpointScope === 'unknown'
        ? inferBedrockEndpointScope(modelId)
        : pricingConfig.bedrockEndpointScope,
  });

  const isSubagent = isSubagentFilePath(filePath);

  // Prefer the real cwd emitted in JSONL. When older or partial logs omit cwd,
  // fall back to the Claude projects directory name so dashboards still group
  // the row under a user-derived project rather than a hardcoded placeholder.
  const rawCwd = event.cwd || projectPathFromJsonlPath(filePath);
  const projectName = displayPathSegment(rawCwd);

  const row: TokenRow = {
    date: toLocalDateStr(ts),
    hour: toLocalHour(ts),
    sessionId: event.sessionId ?? '',
    project: rawCwd,
    projectName,
    modelId,
    modelFamily: model_family(modelId),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreation5m: cache5m,
    cacheCreation1h: cache1h,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
    costUsd: costComponents.totalCostUsd,
    costUsdMicros: costComponents.totalCostUsdMicros,
    pricingMultiplier: costComponents.pricingMultiplier,
    pricingStatus: costComponents.pricingStatus,
    inputCostUsd: costComponents.inputCostUsd,
    inputCostUsdMicros: costComponents.inputCostUsdMicros,
    outputCostUsd: costComponents.outputCostUsd,
    outputCostUsdMicros: costComponents.outputCostUsdMicros,
    cacheCreationCostUsd: costComponents.cacheCreationCostUsd,
    cacheCreationCostUsdMicros: costComponents.cacheCreationCostUsdMicros,
    cacheReadCostUsd: costComponents.cacheReadCostUsd,
    cacheReadCostUsdMicros: costComponents.cacheReadCostUsdMicros,
    webSearchCostUsd: costComponents.webSearchCostUsd,
    webSearchCostUsdMicros: costComponents.webSearchCostUsdMicros,
    isSubagent,
  };

  return row;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function parseSinceCutoff(since: string | undefined, now: Date): Date | null {
  if (!since) return null;
  // Pure integer: treat as number of days.
  if (/^\d+$/.test(since)) {
    const days = Number.parseInt(since, 10);
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // "Nd" pattern (e.g. "30d").
  const dMatch = /^(\d+)d$/i.exec(since);
  if (dMatch) {
    const days = Number.parseInt(dMatch[1] ?? '0', 10);
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // ISO date or datetime string.
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Compute the full MetricSummary snapshot from all rows.
 *
 * Applies the optional MetricsQuery filters:
 *   - `since` — ISO date or relative "Nd" string.
 *   - `project` — substring match against row.project.
 *
 * IMPORTANT: the `since` filter scopes the time-series data (dailySeries,
 * weeklySeries, heatmapData) and the all-time totals for the filtered view,
 * but the windowed totals (costUsd30d, costUsd5d, inputTokens30d,
 * outputTokens30d, cacheCreationTokens30d, cacheReadTokens30d,
 * avgCostPerTurn30d, toolErrorRate30d) are ALWAYS computed against the full
 * unfiltered row set. They are defined as absolute 30d/5d windows from
 * today, not windows relative to the `since` filter.
 *
 * sessionTimes is the IndexStore's per-session timestamp map; it is passed
 * through to buildPeriodRollup, which filters it to sessions whose firstTs
 * falls within each period so SessionDurationStats is period-scoped.
 */
function aggregate(
  rows: TokenRow[],
  query: MetricsQuery,
  sessionTimes: Map<string, { firstTs: number; lastTs: number }>,
  ingestionAudit: IngestionAuditSummary
): MetricSummary {
  const now = new Date();

  const sinceCutoff = parseSinceCutoff(query.since, now);

  const cutoff30d = new Date(now.getTime());
  cutoff30d.setDate(cutoff30d.getDate() - 30);
  cutoff30d.setHours(0, 0, 0, 0);

  const cutoff5d = new Date(now.getTime());
  cutoff5d.setDate(cutoff5d.getDate() - 5);
  cutoff5d.setHours(0, 0, 0, 0);

  // Filter rows for time-series and totals (project + since).
  const filtered = rows.filter((r) => {
    if (query.project && !r.project.includes(query.project)) return false;
    if (sinceCutoff) {
      const rowDate = new Date(`${r.date}T00:00:00`);
      if (rowDate < sinceCutoff) return false;
    }
    return true;
  });

  // Windowed totals are computed over the full row set (optionally
  // project-filtered, but NOT since-filtered). They are absolute 30d/5d
  // windows from today, independent of any since filter the caller passes.
  const projectFilter = query.project;
  const projectFiltered = projectFilter
    ? rows.filter((r) => r.project.includes(projectFilter))
    : rows;

  let costUsd30d = 0;
  let costUsd5d = 0;
  let inputTokens30d = 0;
  let outputTokens30d = 0;
  let cacheCreationTokens30d = 0;
  let cacheReadTokens30d = 0;
  const costComponents30d = emptyCostComponents();
  let mainSessionCostUsd30d = 0;
  let subagentCostUsd30d = 0;
  let agentToolCalls30d = 0;
  let bashToolCalls30d = 0;
  let opusToSonnetSavings30d = 0;
  const project30dMap = new Map<string, ProjectBucket>();

  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate >= cutoff30d) {
      costUsd30d += row.costUsd;
      inputTokens30d += row.inputTokens;
      outputTokens30d += row.outputTokens;
      cacheCreationTokens30d += row.cacheCreation5m + row.cacheCreation1h;
      cacheReadTokens30d += row.cacheReadTokens;
      addCostComponents(costComponents30d, row);
      if (row.isSubagent) {
        subagentCostUsd30d += row.costUsd;
      } else {
        mainSessionCostUsd30d += row.costUsd;
      }
      agentToolCalls30d += row.toolUses?.Agent ?? 0;
      bashToolCalls30d += row.toolUses?.Bash ?? 0;
      opusToSonnetSavings30d += estimateOpusToSonnetSavings(row);

      const existingProject30d = project30dMap.get(row.project);
      if (existingProject30d) {
        existingProject30d.costUsd += row.costUsd;
        existingProject30d.inputTokens += row.inputTokens;
        existingProject30d.outputTokens += row.outputTokens;
        existingProject30d.events += 1;
      } else {
        project30dMap.set(row.project, {
          project: row.project,
          costUsd: row.costUsd,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          events: 1,
        });
      }
    }
    if (rowDate >= cutoff5d) {
      costUsd5d += row.costUsd;
    }
  }

  // All-time totals (over the since+project filtered set).
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalCacheReadTokens = 0;
  const sessionsSet = new Set<string>();
  const projectsSet = new Set<string>();
  const projectsNameSet = new Set<string>();

  // Buckets.
  const dailyMap = new Map<string, DailyBucket>();
  const weeklyMap = new Map<string, WeeklyBucket>();
  const modelMap = new Map<string, ModelBucket>();
  const projectMap = new Map<string, ProjectBucket>();
  const sessionMap = new Map<string, SessionBucket>();
  const heatmapMap = new Map<string, HeatmapPoint>();

  for (const row of filtered) {
    totalCostUsd += row.costUsd;
    totalInputTokens += row.inputTokens;
    totalOutputTokens += row.outputTokens;
    totalCacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
    totalCacheReadTokens += row.cacheReadTokens;
    if (row.sessionId) sessionsSet.add(row.sessionId);
    if (row.project) projectsSet.add(row.project);
    if (row.projectName) projectsNameSet.add(row.projectName); // empty projectName excluded by design: rows with no resolvable cwd basename are not counted as a distinct project

    // rowDate is re-derived here for use in the daily/weekly bucket logic.
    const rowDate = new Date(`${row.date}T00:00:00`);

    // Daily bucket.
    const existingDay = dailyMap.get(row.date);
    if (existingDay) {
      existingDay.costUsd += row.costUsd;
      existingDay.inputTokens += row.inputTokens;
      existingDay.outputTokens += row.outputTokens;
      existingDay.cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
      existingDay.cacheReadTokens += row.cacheReadTokens;
    } else {
      dailyMap.set(row.date, {
        date: row.date,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreation5m + row.cacheCreation1h,
        cacheReadTokens: row.cacheReadTokens,
      });
    }

    // Weekly bucket.
    const weekStartStr = isoWeekStart(rowDate);
    const existingWeek = weeklyMap.get(weekStartStr);
    if (existingWeek) {
      existingWeek.costUsd += row.costUsd;
      existingWeek.inputTokens += row.inputTokens;
      existingWeek.outputTokens += row.outputTokens;
    } else {
      weeklyMap.set(weekStartStr, {
        weekStart: weekStartStr,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      });
    }

    // Model bucket.
    const existingModel = modelMap.get(row.modelFamily);
    if (existingModel) {
      existingModel.costUsd += row.costUsd;
      existingModel.inputTokens += row.inputTokens;
      existingModel.outputTokens += row.outputTokens;
      existingModel.cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
      existingModel.cacheReadTokens += row.cacheReadTokens;
      existingModel.events += 1;
    } else {
      modelMap.set(row.modelFamily, {
        modelFamily: row.modelFamily,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreation5m + row.cacheCreation1h,
        cacheReadTokens: row.cacheReadTokens,
        events: 1,
      });
    }

    // Project bucket.
    const existingProject = projectMap.get(row.project);
    if (existingProject) {
      existingProject.costUsd += row.costUsd;
      existingProject.inputTokens += row.inputTokens;
      existingProject.outputTokens += row.outputTokens;
      existingProject.events += 1;
    } else {
      projectMap.set(row.project, {
        project: row.project,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        events: 1,
      });
    }

    // Session bucket.
    const existingSession = sessionMap.get(row.sessionId);
    if (existingSession) {
      existingSession.costUsd += row.costUsd;
      existingSession.inputTokens += row.inputTokens;
      existingSession.outputTokens += row.outputTokens;
      existingSession.cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
      existingSession.cacheReadTokens += row.cacheReadTokens;
      existingSession.events += 1;
    } else {
      sessionMap.set(row.sessionId, {
        sessionId: row.sessionId,
        project: row.project,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreation5m + row.cacheCreation1h,
        cacheReadTokens: row.cacheReadTokens,
        events: 1,
      });
    }

    // Heatmap: key = "YYYY-MM-DD:HH"
    const heatKey = `${row.date}:${row.hour}`;
    const existingHeat = heatmapMap.get(heatKey);
    if (existingHeat) {
      existingHeat.costUsd += row.costUsd;
    } else {
      heatmapMap.set(heatKey, {
        date: row.date,
        hour: row.hour,
        costUsd: row.costUsd,
      });
    }
  }

  // Sort series.
  const dailySeries = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const weeklySeries = [...weeklyMap.values()].sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart)
  );
  const byModel = [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const byProject = [...projectMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const byProject30d = [...project30dMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const bySession = [...sessionMap.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 15);
  const heatmapData = [...heatmapMap.values()];

  // ── New analytics aggregations ─────────────────────────────────────────────
  //
  // Two base sets drive the passes below:
  //   `filtered`        — since+project filter; used for byTool, bySubagent, and
  //                        totalFilesTouched so those charts react to the caller's
  //                        time-window selection (same as dailySeries / byProject).
  //   `projectFiltered` — project-only filter (no since); used for the windowed KPI
  //                        fields (avgCostPerTurn30d, toolErrorRate30d,
  //                        cacheCreationTokens30d, cacheReadTokens30d) because those
  //                        are absolute 30d windows from today, matching the
  //                        costUsd30d / inputTokens30d convention above.
  // A future KPI should use `projectFiltered` for absolute-window metrics and
  // `filtered` for time-selection-aware breakdowns.

  // Prior 30-day window (days 31-60 from today) for avgCostPerTurnPrev30d.
  const cutoff60d = new Date(now.getTime());
  cutoff60d.setDate(cutoff60d.getDate() - 60);
  cutoff60d.setHours(0, 0, 0, 0);

  // ── byTool: aggregate toolUses / toolErrors over the since-filtered set ────
  // Design decision: tool counts are scoped to the since+project filter (same
  // as dailySeries / byProject) so the chart reacts to time-window selections.
  const toolMap = new Map<string, { count: number; errorCount: number }>();
  for (const row of filtered) {
    if (row.toolUses) {
      for (const [toolName, count] of Object.entries(row.toolUses)) {
        const existing = toolMap.get(toolName);
        const errorCount = row.toolErrors?.[toolName] ?? 0;
        if (existing) {
          existing.count += count;
          existing.errorCount += errorCount;
        } else {
          toolMap.set(toolName, { count, errorCount });
        }
      }
    }
  }
  const byTool: ToolBucket[] = [...toolMap.entries()]
    .map(([toolName, { count, errorCount }]) => ({
      toolName,
      count,
      errorCount,
      errorRate: count > 0 ? errorCount / count : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ── bySubagent: aggregate subagent rows over the since-filtered set ─────────
  // agentType = modelFamily (same field the subagent leaderboard displays).
  // dispatches = row count (not unique session count) for consistency with the
  // rest of the codebase which uses row counts for event-based metrics.
  const subagentMap = new Map<
    string,
    {
      dispatches: number;
      totalTokens: number;
      totalCostUsd: number;
      durationMsSum: number;
      durationCount: number;
      toolUseCount: number;
      toolErrorCount: number;
    }
  >();
  for (const row of filtered) {
    if (!row.isSubagent) continue;
    const agentType = row.modelFamily;
    const existing = subagentMap.get(agentType);
    const durationMs = row.turnDurationMs;
    const toolUses = row.toolUses ? Object.values(row.toolUses).reduce((s, c) => s + c, 0) : 0;
    const toolErrors = row.toolErrors
      ? Object.values(row.toolErrors).reduce((s, c) => s + c, 0)
      : 0;
    if (existing) {
      existing.dispatches += 1;
      existing.totalTokens += row.inputTokens + row.outputTokens;
      existing.totalCostUsd += row.costUsd;
      if (durationMs !== undefined) {
        existing.durationMsSum += durationMs;
        existing.durationCount += 1;
      }
      existing.toolUseCount += toolUses;
      existing.toolErrorCount += toolErrors;
    } else {
      subagentMap.set(agentType, {
        dispatches: 1,
        totalTokens: row.inputTokens + row.outputTokens,
        totalCostUsd: row.costUsd,
        durationMsSum: durationMs ?? 0,
        durationCount: durationMs !== undefined ? 1 : 0,
        toolUseCount: toolUses,
        toolErrorCount: toolErrors,
      });
    }
  }
  const bySubagent: SubagentBucket[] = [...subagentMap.entries()]
    .map(([agentType, acc]) => ({
      agentType,
      dispatches: acc.dispatches,
      totalTokens: acc.totalTokens,
      totalCostUsd: acc.totalCostUsd,
      avgDurationMs: acc.durationCount > 0 ? acc.durationMsSum / acc.durationCount : 0,
      successRate: acc.toolUseCount > 0 ? 1 - acc.toolErrorCount / acc.toolUseCount : 1,
    }))
    .sort((a, b) => b.dispatches - a.dispatches);

  // NOTE: activeMs30d and idleMs30d have been removed from MetricSummary.
  // durationAccumulator and TokenRow.turnDurationMs are retained — they are
  // still consumed by getTurns() (TurnBucket.durationMs) and the bySubagent
  // accumulator (SubagentBucket.avgDurationMs).

  // ── totalFilesTouched: cardinality of unique paths across filtered rows ─────
  const touchedPathsSet = new Set<string>();
  for (const row of filtered) {
    if (row.filesTouched) {
      for (const fp of row.filesTouched) {
        touchedPathsSet.add(fp);
      }
    }
  }
  const totalFilesTouched = touchedPathsSet.size;

  // ── avgCostPerTurn30d / avgCostPerTurnPrev30d / prev-30d window totals ──────
  // Uses projectFiltered (absolute 30d / prior 30d windows from today).
  // In a single pass we also collect:
  //   - turn-cost values for the 30d window (for percentile computation)
  //   - inputTokens, outputTokens, and costUsd sums for the prev-30d window
  let costSum30d = 0;
  let count30d = 0;
  let costSumPrev30d = 0;
  let countPrev30d = 0;
  let inputTokensPrev30d = 0;
  let outputTokensPrev30d = 0;
  let costUsd30dPrev = 0;
  const turnCosts30d: number[] = [];
  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate >= cutoff30d) {
      costSum30d += row.costUsd;
      count30d += 1;
      turnCosts30d.push(row.costUsd);
    } else if (rowDate >= cutoff60d) {
      costSumPrev30d += row.costUsd;
      countPrev30d += 1;
      inputTokensPrev30d += row.inputTokens;
      outputTokensPrev30d += row.outputTokens;
      costUsd30dPrev += row.costUsd;
    }
  }
  const avgCostPerTurn30d = count30d > 0 ? costSum30d / count30d : 0;
  const avgCostPerTurnPrev30d = countPrev30d > 0 ? costSumPrev30d / countPrev30d : 0;

  // ── Turn-cost percentiles (30d window) ────────────────────────────────────
  // Formula: sort ascending, index = floor(p/100 * n) clamped to [0, n-1].
  turnCosts30d.sort((a, b) => a - b);
  function percentileFloor(sorted: number[], p: number): number {
    const n = sorted.length;
    if (n === 0) return 0;
    const idx = Math.min(Math.floor((p / 100) * n), n - 1);
    return sorted[idx] ?? 0;
  }
  const turnCostP50_30d = percentileFloor(turnCosts30d, 50);
  const turnCostP90_30d = percentileFloor(turnCosts30d, 90);
  const turnCostP99_30d = percentileFloor(turnCosts30d, 99);

  function topCostShare(sortedAsc: number[], fraction: number): number {
    if (sortedAsc.length === 0 || costUsd30d === 0) return 0;
    const count = Math.max(1, Math.ceil(sortedAsc.length * fraction));
    let sum = 0;
    for (let i = sortedAsc.length - count; i < sortedAsc.length; i++) {
      sum += sortedAsc[i] ?? 0;
    }
    return sum / costUsd30d;
  }
  const turnCostTop1PctShare30d = topCostShare(turnCosts30d, 0.01);
  const turnCostTop5PctShare30d = topCostShare(turnCosts30d, 0.05);

  // ── toolErrorRate30d: total errors / total tool uses in 30d window ────────
  let totalToolUses30d = 0;
  let totalToolErrors30d = 0;
  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate < cutoff30d) continue;
    if (row.toolUses) {
      for (const count of Object.values(row.toolUses)) {
        totalToolUses30d += count;
      }
    }
    if (row.toolErrors) {
      for (const count of Object.values(row.toolErrors)) {
        totalToolErrors30d += count;
      }
    }
  }
  const toolErrorRate30d = totalToolUses30d > 0 ? totalToolErrors30d / totalToolUses30d : 0;

  // ── Calendar-period rollups ────────────────────────────────────────────────
  // Period rollups always run over the project-filtered (not since-filtered)
  // rows so calendar windows are not truncated by an unrelated since= param.
  //
  // CLAUD-016: when a project filter is active, build a project-scoped view of
  // sessionTimes so per-period SessionDurationStats excludes sessions from
  // other projects. Without this, sessions from unrelated projects pollute the
  // duration distribution.
  let effectiveSessionTimes = sessionTimes;
  if (query.project) {
    // Collect all sessionIds that appear in the project-filtered rows.
    const projectSessionIds = new Set<string>();
    for (const row of projectFiltered) {
      if (row.sessionId) projectSessionIds.add(row.sessionId);
    }
    // Build a filtered sessionTimes Map containing only those sessionIds.
    effectiveSessionTimes = new Map();
    for (const [sid, times] of sessionTimes) {
      if (projectSessionIds.has(sid)) {
        effectiveSessionTimes.set(sid, times);
      }
    }
  }

  // SRE-2: Compute all 6 period rollups in a SINGLE pass over projectFiltered
  // rows (rather than 6 separate passes). Each row is checked against all 6
  // period bounds and its data added to any matching period's accumulators.
  // A row can match multiple periods (e.g., March belongs to currMonth,
  // currQuarter, and currYear simultaneously).
  const curMonth = monthBounds(now);
  const prevMonth = monthBounds(previousPeriodDate(now, 'month'));
  const curQuarter = quarterBounds(now);
  const prevQuarter = quarterBounds(previousPeriodDate(now, 'quarter'));
  const curYear = yearBounds(now);
  const prevYear = yearBounds(previousPeriodDate(now, 'year'));

  const allPeriodBounds = [
    curMonth,
    prevMonth,
    curQuarter,
    prevQuarter,
    curYear,
    prevYear,
  ] as const;

  // Per-period accumulators — one typed struct per period avoids non-null
  // assertions on indexed arrays while remaining a fixed-size allocation.
  interface PeriodAcc {
    costUsd: number;
    totalTokens: number;
    sessions: Set<string>;
    dayIndexMap: Map<string, number>;
    dailyCost: number[];
    dailyTokens: number[];
    dailySessionSets: Set<string>[];
  }

  const periodAccs: PeriodAcc[] = allPeriodBounds.map((b) => ({
    costUsd: 0,
    totalTokens: 0,
    sessions: new Set<string>(),
    dayIndexMap: buildDayIndexMap(b),
    dailyCost: new Array<number>(b.days).fill(0),
    dailyTokens: new Array<number>(b.days).fill(0),
    dailySessionSets: Array.from({ length: b.days }, () => new Set<string>()),
  }));

  // Single pass over rows — each row checked against all 6 periods.
  for (const row of projectFiltered) {
    const tok = row.inputTokens + row.outputTokens;
    for (const acc of periodAccs) {
      const dayIdx = acc.dayIndexMap.get(row.date) ?? -1;
      if (dayIdx === -1) continue;
      acc.costUsd += row.costUsd;
      acc.totalTokens += tok;
      // dayIdx is always in [0, days) because dayIndexMap is built from bounds.
      (acc.dailyCost[dayIdx] as number) += row.costUsd;
      (acc.dailyTokens[dayIdx] as number) += tok;
      if (row.sessionId) {
        acc.sessions.add(row.sessionId);
        (acc.dailySessionSets[dayIdx] as Set<string>).add(row.sessionId);
      }
    }
  }

  // Finalize each period into a PeriodRollup.
  function finalizePeriod(acc: PeriodAcc, bounds: PeriodBounds): PeriodRollup {
    const dailySessions = acc.dailySessionSets.map((s) => s.size);
    const periodStart = bounds.start.getTime();
    const periodEnd = bounds.end.getTime();
    const filteredForPeriod = new Map<string, { firstTs: number; lastTs: number }>();
    for (const [sid, times] of effectiveSessionTimes) {
      if (times.firstTs >= periodStart && times.firstTs <= periodEnd) {
        filteredForPeriod.set(sid, times);
      }
    }
    return {
      costUsd: acc.costUsd,
      totalTokens: acc.totalTokens,
      sessionCount: acc.sessions.size,
      dailyCost: acc.dailyCost,
      dailyTokens: acc.dailyTokens,
      dailySessions,
      sessionDuration: computeDurationStatsForSessions(filteredForPeriod),
    };
  }

  const monthlyRollup: PeriodComparison = {
    current: finalizePeriod(periodAccs[0] as PeriodAcc, curMonth),
    previous: finalizePeriod(periodAccs[1] as PeriodAcc, prevMonth),
  };
  const quarterlyRollup: PeriodComparison = {
    current: finalizePeriod(periodAccs[2] as PeriodAcc, curQuarter),
    previous: finalizePeriod(periodAccs[3] as PeriodAcc, prevQuarter),
  };
  const yearlyRollup: PeriodComparison = {
    current: finalizePeriod(periodAccs[4] as PeriodAcc, curYear),
    previous: finalizePeriod(periodAccs[5] as PeriodAcc, prevYear),
  };

  const optimizationOpportunities = buildOptimizationOpportunities({
    costUsd30d,
    components: costComponents30d,
    byProject30d,
    bashToolCalls30d,
    turnCostTop5PctShare30d,
    mainSessionCostUsd30d,
    subagentCostUsd30d,
    agentToolCalls30d,
    opusToSonnetSavings30d,
  });
  const pricingAudit = buildPricingAudit(filtered, pricingRuntimeConfig());

  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    totalSessions: sessionsSet.size,
    totalProjects: projectsSet.size,
    totalProjectsTouched: projectsNameSet.size,
    costUsd30d,
    costUsd5d,
    inputTokens30d,
    outputTokens30d,
    cacheCreationTokens30d,
    cacheReadTokens30d,
    dailySeries,
    weeklySeries,
    byModel,
    byProject,
    byProject30d,
    bySession,
    heatmapData,
    byTool,
    bySubagent,
    totalFilesTouched,
    avgCostPerTurn30d,
    avgCostPerTurnPrev30d,
    toolErrorRate30d,
    pricingAudit,
    ingestionAudit,
    costComponents30d,
    turnCostTop1PctShare30d,
    turnCostTop5PctShare30d,
    mainSessionCostUsd30d,
    subagentCostUsd30d,
    agentToolCalls30d,
    opusToSonnetSavings30d,
    optimizationOpportunities,
    turnCostP50_30d,
    turnCostP90_30d,
    turnCostP99_30d,
    inputTokensPrev30d,
    outputTokensPrev30d,
    costUsd30dPrev,
    retroRollup: null,
    retroTimeline: [],
    retroForecast: [],
    monthlyRollup,
    quarterlyRollup,
    yearlyRollup,
  };
}

// ---------------------------------------------------------------------------
// Session summary computation
// ---------------------------------------------------------------------------

function computeSessionSummaries(rows: TokenRow[], query: MetricsQuery): SessionSummary[] {
  const now = new Date();
  const sinceCutoff = parseSinceCutoff(query.since, now);

  const sessionMap = new Map<
    string,
    {
      sessionId: string;
      project: string;
      projectName: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      events: number;
      isSubagent: boolean;
    }
  >();

  // Parallel accumulator: sessionId → toolName → { count, errorCount }
  const toolAccumulator = new Map<string, Map<string, { count: number; errorCount: number }>>();

  for (const row of rows) {
    if (query.project && !row.project.includes(query.project)) continue;
    if (sinceCutoff) {
      const rowDate = new Date(`${row.date}T00:00:00`);
      if (rowDate < sinceCutoff) continue;
    }

    const existing = sessionMap.get(row.sessionId);
    if (existing) {
      existing.costUsd += row.costUsd;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
      existing.cacheReadTokens += row.cacheReadTokens;
      existing.events += 1;
    } else {
      sessionMap.set(row.sessionId, {
        sessionId: row.sessionId,
        project: row.project,
        projectName: row.projectName,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreation5m + row.cacheCreation1h,
        cacheReadTokens: row.cacheReadTokens,
        events: 1,
        isSubagent: row.isSubagent,
      });
    }

    // Accumulate tool uses and errors for this session.
    let sessionTools = toolAccumulator.get(row.sessionId);
    if (!sessionTools) {
      sessionTools = new Map<string, { count: number; errorCount: number }>();
      toolAccumulator.set(row.sessionId, sessionTools);
    }
    const uses = row.toolUses ?? {};
    const errors = row.toolErrors ?? {};
    for (const [toolName, count] of Object.entries(uses)) {
      const existing2 = sessionTools.get(toolName);
      if (existing2) {
        existing2.count += count;
      } else {
        sessionTools.set(toolName, { count, errorCount: 0 });
      }
    }
    for (const [toolName, errCount] of Object.entries(errors)) {
      const existing2 = sessionTools.get(toolName);
      if (existing2) {
        existing2.errorCount += errCount;
      } else {
        sessionTools.set(toolName, { count: 0, errorCount: errCount });
      }
    }
  }

  // Build final SessionSummary[] with topTools and toolNamesCount.
  const result: SessionSummary[] = [];
  for (const entry of sessionMap.values()) {
    const sessionTools = toolAccumulator.get(entry.sessionId);
    let topTools: ToolBucket[] = [];
    let toolNamesCount = 0;
    if (sessionTools && sessionTools.size > 0) {
      toolNamesCount = sessionTools.size;
      topTools = [...sessionTools.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3)
        .map(([toolName, { count, errorCount }]) => ({
          toolName,
          count,
          errorCount,
          errorRate: count > 0 ? errorCount / count : 0,
        }));
    }
    result.push({ ...entry, topTools, toolNamesCount });
  }

  return result.sort((a, b) => b.costUsd - a.costUsd);
}

// ---------------------------------------------------------------------------
// IndexStore
// ---------------------------------------------------------------------------

export class IndexStore extends EventEmitter {
  /** @internal Exposed as package-internal for test access; do not mutate from outside. */
  readonly rows = new Map<string, TokenRow>();
  private readonly rowTimestampMs = new Map<string, number>();
  /** Per-session first/last event timestamps (epoch ms). Used for duration stats. */
  private readonly sessionTimes = new Map<string, { firstTs: number; lastTs: number }>();
  private readonly fileIngestionAudits = new Map<string, FileIngestionAudit>();
  private filesDiscovered = 0;
  private snapshot: MetricSummary | null = null;
  private lastUpdated: Date = new Date();
  private _initialized = false;

  constructor() {
    super();
    // Suppress MaxListenersExceededWarning when many SSE clients connect.
    // Each /api/events connection registers one 'change' listener; the listener
    // is removed on stream abort so there is no permanent leak.
    this.setMaxListeners(50);
  }

  /** Millisecond timestamp of the last file-change event. */
  get lastChangeTs(): number {
    return this.lastUpdated.getTime();
  }

  get indexedRows(): number {
    return this.rows.size;
  }

  get lastUpdatedAt(): Date {
    return this.lastUpdated;
  }

  private recordSessionTimestamp(row: TokenRow, tsMs: number | undefined): void {
    if (tsMs === undefined || !Number.isFinite(tsMs) || !row.sessionId) return;
    const existing = this.sessionTimes.get(row.sessionId);
    if (existing) {
      existing.firstTs = Math.min(existing.firstTs, tsMs);
      existing.lastTs = Math.max(existing.lastTs, tsMs);
      return;
    }

    this.sessionTimes.set(row.sessionId, { firstTs: tsMs, lastTs: tsMs });
    // Evict oldest 10% when the Map grows beyond MAX_SESSION_TIMES.
    // Batching avoids re-sorting on every individual insert.
    if (this.sessionTimes.size > MAX_SESSION_TIMES) {
      const evictCount = Math.ceil(MAX_SESSION_TIMES * 0.1);
      const sorted = [...this.sessionTimes.entries()].sort((a, b) => a[1].firstTs - b[1].firstTs);
      for (let ei = 0; ei < evictCount; ei++) {
        const entry = sorted[ei];
        if (entry) this.sessionTimes.delete(entry[0]);
      }
    }
  }

  /**
   * Full startup scan — discover all JSONL files and ingest in parallel batches
   * of BATCH_SIZE to avoid fd-limit exhaustion with 2,500+ files.
   */
  async initialize(): Promise<void> {
    const files = await collectJsonlFiles(PROJECTS_DIR).catch(() => [] as string[]);
    this.filesDiscovered = files.length;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((f) => this.ingestFileInternal(f)));
    }

    this.recompute();
    this._initialized = true;
  }

  /**
   * Re-parse one file and add any new rows (dedup prevents double-counting).
   * Called by the watcher on file add/change.
   */
  async ingestFile(filePath: string): Promise<void> {
    logEvent('info', 'change', { path: filePath, action: 'rebuild', ts: Date.now() });
    await this.ingestFileInternal(filePath);
    this.snapshot = null;
    this.lastUpdated = new Date();
    this.emit('change');
  }

  /**
   * Parse one JSONL file using two sequential readline passes and merge results
   * into the shared row map.
   *
   * Pass 1 collects all `tool_use`, `tool_result`, and `system/turn_duration`
   * events into `requestId`-keyed accumulators. Pass 2 builds `TokenRow` entries
   * from `assistant` events and merges tool/duration data from pass 1.
   *
   * Using two passes (rather than buffering all lines) keeps peak memory at
   * O(distinct requestIds with tool events), not O(all lines in the file).
   * See ADR 0003 for the full rationale and alternatives considered.
   */
  private async ingestFileInternal(filePath: string): Promise<void> {
    const fileAudit = emptyFileIngestionAudit();
    // ── Two-pass ingest ───────────────────────────────────────────────────────
    //
    // Bug 4 fix: JSONL files from Claude Code can have tool_use/tool_result and
    // system/turn_duration events that appear AFTER the assistant event for the
    // same requestId. A single-pass approach would build the TokenRow before the
    // tool data arrives, leaving toolUses empty for those turns.
    //
    // Solution: stream the file twice via readline (never buffering all lines in
    // memory). Pass 1 collects all tool_use, tool_result, and system/turn_duration
    // events into per-requestId accumulators. Pass 2 builds TokenRow entries from
    // assistant events and merges the complete pass-1 accumulators.
    //
    // Both passes re-open the file independently (no seek/rewind needed).
    // Memory cost: O(distinct requestIds with tool events) — bounded by the
    // number of unique turns in the file, not all lines.
    //
    // Privacy invariant: only toolName and input.file_path are extracted from
    // tool_use events. No other fields from event.input are stored. This is
    // enforced by the ToolUseEventSchema stripping all other input fields at
    // parse time.
    //
    // Known race window: if the file is written between pass 1 and pass 2 by an
    // active Claude Code session, pass 2 may see lines that pass 1 did not (or
    // vice versa). The file-watcher calls ingestFile() again on any change, so
    // any mid-ingest append is self-healed on the next watcher event. The dedup
    // key (requestId:messageId) ensures re-ingested rows are not double-counted.
    //
    // Duplicate-tool risk: if a JSONL file contains multiple assistant events
    // sharing the same requestId (non-standard but possible in edge cases), the
    // pass-1 toolAccumulator accumulates tool events for all of them under one
    // key. Each assistant event in pass 2 would then receive the same merged
    // tool data. In practice Claude Code emits one assistant event per requestId,
    // so this risk is theoretical; the dedup key (requestId:messageId) still
    // prevents the same (requestId, messageId) pair from being counted twice.

    // Map<requestId, Map<toolName, {count, filePaths}>>
    const toolAccumulator = new Map<string, Map<string, { count: number; filePaths: string[] }>>();

    // Map<toolUseId, request/tool metadata> — used to resolve nested
    // tool_result blocks which usually live in a following user event and do
    // not carry requestId themselves.
    // Entries are purged on first match to keep the map small.
    const toolUseIdToMeta = new Map<string, { requestId: string; toolName: string }>();
    const pendingErrorByToolUseId = new Map<string, number>();

    // Map<requestId, Map<toolName, errorCount>>
    const errorAccumulator = new Map<string, Map<string, number>>();

    // Map<requestId, durationMs> — from system/turn_duration events.
    const durationAccumulator = new Map<string, number>();

    // Turn-duration events in current Claude Code logs do not include
    // requestId. They point at the previous event via parentUuid, so pass 1
    // records a small uuid ancestry map and resolves durations after scanning.
    const parentByUuid = new Map<string, string>();
    const requestIdByUuid = new Map<string, string>();
    const pendingDurations: Array<{ parentUuid: string | null | undefined; durationMs: number }> =
      [];

    function pathFromInput(
      input:
        | {
            file_path?: string | undefined;
            path?: string | undefined;
            planFilePath?: string | undefined;
          }
        | undefined
    ): string | undefined {
      return input?.file_path ?? input?.path ?? input?.planFilePath;
    }

    function accumulateToolUse(requestId: string, toolName: string, filePath_: string | undefined) {
      let toolsForReq = toolAccumulator.get(requestId);
      if (!toolsForReq) {
        toolsForReq = new Map();
        toolAccumulator.set(requestId, toolsForReq);
      }
      const existing = toolsForReq.get(toolName);
      if (existing) {
        existing.count += 1;
        if (filePath_) existing.filePaths.push(filePath_);
      } else {
        toolsForReq.set(toolName, {
          count: 1,
          filePaths: filePath_ ? [filePath_] : [],
        });
      }
    }

    function accumulateToolError(requestId: string, toolName: string, count = 1) {
      let errorsForReq = errorAccumulator.get(requestId);
      if (!errorsForReq) {
        errorsForReq = new Map();
        errorAccumulator.set(requestId, errorsForReq);
      }
      errorsForReq.set(toolName, (errorsForReq.get(toolName) ?? 0) + count);
    }

    function isToolUseContent(block: unknown): block is ToolUseContentParsed {
      return (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'tool_use'
      );
    }

    function isToolResultContent(block: unknown): block is ToolResultContentParsed {
      return (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'tool_result'
      );
    }

    function resolveRequestIdFromAncestor(uuid: string | null | undefined): string | undefined {
      let cursor = uuid ?? undefined;
      for (let depth = 0; cursor && depth < 12; depth++) {
        const requestId = requestIdByUuid.get(cursor);
        if (requestId) return requestId;
        cursor = parentByUuid.get(cursor);
      }
      return undefined;
    }

    // ── Pass 1: collect tool/duration events ──────────────────────────────────
    try {
      for await (const event of parseJSONLFile(filePath, {
        onSkip: (reason) => {
          if (reason === 'invalid-json') fileAudit.invalidJsonLines += 1;
          if (reason === 'schema-mismatch') fileAudit.schemaMismatchLines += 1;
          if (reason === 'file-open-error') fileAudit.fileOpenErrors += 1;
        },
      })) {
        if (event.type === 'assistant') {
          if (event.message?.usage) {
            fileAudit.assistantUsageEvents += 1;
          } else {
            fileAudit.assistantEventsWithoutUsage += 1;
          }
        }

        if (event.uuid && event.parentUuid) {
          parentByUuid.set(event.uuid, event.parentUuid);
        }
        if (event.uuid && event.requestId) {
          requestIdByUuid.set(event.uuid, event.requestId);
        }

        // Current Claude Code JSONL stores tool_use/tool_result inside
        // message.content[] rather than as top-level events. The content blocks
        // have already been stripped by the Zod schema to preserve only tool
        // name, tool ID, is_error, and path-like scalar input fields.
        const messageContent = (event.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
            if (isToolUseContent(block)) {
              const rid = event.requestId;
              const toolName = block.name;
              if (!rid || !toolName) continue;

              accumulateToolUse(rid, toolName, pathFromInput(block.input));

              if (block.id) {
                toolUseIdToMeta.set(block.id, { requestId: rid, toolName });
                const pendingErrorCount = pendingErrorByToolUseId.get(block.id);
                if (pendingErrorCount !== undefined) {
                  accumulateToolError(rid, toolName, pendingErrorCount);
                  pendingErrorByToolUseId.delete(block.id);
                }
              }
              continue;
            }

            if (isToolResultContent(block)) {
              if (!block.tool_use_id) continue;
              const toolMeta = toolUseIdToMeta.get(block.tool_use_id);
              toolUseIdToMeta.delete(block.tool_use_id);
              if (block.is_error === true && toolMeta) {
                accumulateToolError(toolMeta.requestId, toolMeta.toolName);
              } else if (block.is_error === true) {
                pendingErrorByToolUseId.set(
                  block.tool_use_id,
                  (pendingErrorByToolUseId.get(block.tool_use_id) ?? 0) + 1
                );
              }
            }
          }
        }

        // ── tool_use branch ─────────────────────────────────────────────────
        if (event.type === 'tool_use') {
          const toolEvent = event as unknown as ToolUseEventParsed;
          const rid = toolEvent.requestId;
          if (!rid) continue;

          const toolName = toolEvent.toolName;
          const filePath_ = pathFromInput(toolEvent.input);

          // Record tool name by uuid for later join with tool_result.
          if (toolEvent.uuid) {
            toolUseIdToMeta.set(toolEvent.uuid, { requestId: rid, toolName });
          }

          // Accumulate count and file paths by (requestId, toolName).
          accumulateToolUse(rid, toolName, filePath_);
          continue;
        }

        // ── tool_result branch ──────────────────────────────────────────────
        if (event.type === 'tool_result') {
          const resultEvent = event as unknown as ToolResultEventParsed;
          const rid = resultEvent.requestId;

          // Resolve and immediately purge toolUseIdToMeta so the map only holds
          // entries for open (unresolved) tool invocations. This bounds peak memory
          // to O(concurrent open tools) rather than O(all tool_use events in file).
          const toolMeta = resultEvent.tool_use_id
            ? toolUseIdToMeta.get(resultEvent.tool_use_id)
            : undefined;
          if (resultEvent.tool_use_id) {
            toolUseIdToMeta.delete(resultEvent.tool_use_id);
          }

          // Only accumulate errors; non-error results need no further processing.
          if (!rid || !resultEvent.is_error) continue;

          const toolName = toolMeta?.toolName;
          if (!toolName) continue; // tool_use uuid not seen — skip

          accumulateToolError(rid, toolName);
          continue;
        }

        // ── system/turn_duration branch ─────────────────────────────────────
        if (event.type === 'system') {
          // The AssistantEventSchema uses z.string() for type, so system events
          // pass through. We need to check subtype at runtime.
          const sysEvent = event as unknown as SystemTurnDurationEventParsed;
          if ((sysEvent as { subtype?: string }).subtype !== 'turn_duration') continue;
          const rid = sysEvent.requestId;
          if (!rid) {
            pendingDurations.push({
              parentUuid: sysEvent.parentUuid,
              durationMs: sysEvent.durationMs,
            });
            continue;
          }
          // Last write wins if multiple duration events share the same requestId.
          durationAccumulator.set(rid, sysEvent.durationMs);
        }

        // assistant and other event types are not needed in pass 1 — skip.
      }
    } catch (err: unknown) {
      fileAudit.ingestErrors += 1;
      logEvent('error', 'ingest-error', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
        pass: 1,
      });
      // If pass 1 failed entirely, pass 2 will still run but with empty accumulators.
    }

    for (const pending of pendingDurations) {
      const requestId = resolveRequestIdFromAncestor(pending.parentUuid);
      if (requestId) {
        durationAccumulator.set(requestId, pending.durationMs);
      }
    }

    function mergeTurnMetadata(row: TokenRow, requestId: string, existingRow?: TokenRow): void {
      const toolsForReq = toolAccumulator.get(requestId);
      if (toolsForReq) {
        const toolUses: Record<string, number> = {};
        // Use a Set for O(1) dedup instead of Array.includes() which is O(n).
        const touchedSet = new Set<string>();
        for (const [toolName, data] of toolsForReq) {
          toolUses[toolName] = data.count;
          for (const fp of data.filePaths) {
            touchedSet.add(fp);
          }
        }
        row.toolUses = toolUses;
        if (touchedSet.size > 0) row.filesTouched = [...touchedSet];
      } else if (existingRow?.toolUses) {
        row.toolUses = { ...existingRow.toolUses };
        if (existingRow.filesTouched) row.filesTouched = [...existingRow.filesTouched];
      }

      const errorsForReq = errorAccumulator.get(requestId);
      if (errorsForReq) {
        const toolErrors: Record<string, number> = {};
        for (const [toolName, count] of errorsForReq) {
          toolErrors[toolName] = count;
        }
        row.toolErrors = toolErrors;
      } else if (existingRow?.toolErrors) {
        row.toolErrors = { ...existingRow.toolErrors };
      }

      const durationMs = durationAccumulator.get(requestId);
      if (durationMs !== undefined) {
        row.turnDurationMs = durationMs;
      } else if (existingRow?.turnDurationMs !== undefined) {
        row.turnDurationMs = existingRow.turnDurationMs;
      }
    }

    // ── Pass 2: build TokenRows from assistant events ─────────────────────────
    try {
      for await (const event of parseJSONLFile(filePath)) {
        // ── assistant branch ─────────────────────────────────────────────────
        if (event.type !== 'assistant') continue;
        if (!event.message?.usage) continue;

        const requestId = event.requestId;
        const messageId = event.message.id;

        // Dedup key: BOTH requestId AND message.id must be present.
        if (!requestId || !messageId) {
          fileAudit.missingDedupIdRows += 1;
          continue;
        }

        const dedupKey = `${requestId}:${messageId}`;
        const row = buildTokenRow(event, filePath);
        if (row) {
          const tsMs = parseIso(event.timestamp ?? undefined)?.getTime();
          const existingRow = this.rows.get(dedupKey);
          mergeTurnMetadata(row, requestId, existingRow);

          if (existingRow) {
            const shouldReplace = shouldReplaceDuplicateRow({
              existingRow,
              existingTimestampMs: this.rowTimestampMs.get(dedupKey),
              candidateRow: row,
              candidateTimestampMs: tsMs,
            });

            if (!shouldReplace) {
              fileAudit.duplicateRowsSkipped += 1;
              continue;
            }

            fileAudit.duplicateRowsReplaced += 1;
          }

          this.rows.set(dedupKey, row);
          if (tsMs !== undefined) this.rowTimestampMs.set(dedupKey, tsMs);

          if (!existingRow) fileAudit.rowsIndexed += 1;

          // Track per-session first/last timestamps for duration stats.
          // Parse the timestamp independently so we have epoch ms precision;
          // buildTokenRow only stores date+hour in the TokenRow.
          this.recordSessionTimestamp(row, tsMs);
        } else {
          fileAudit.tokenRowsRejected += 1;
        }
      }
    } catch (err: unknown) {
      fileAudit.ingestErrors += 1;
      // Log file-level ingestion errors with path only (no JSONL contents).
      logEvent('error', 'ingest-error', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
        pass: 2,
      });
    }

    fileAudit.lastIndexedAt = formatLocalIso();
    this.fileIngestionAudits.set(filePath, fileAudit);
  }

  /** Invalidate the aggregate snapshot (triggers recompute on next getMetrics). */
  recompute(): void {
    this.snapshot = null;
  }

  /** Return MetricSummary, using cached snapshot when no filters applied. */
  getMetrics(query: MetricsQuery = {}): MetricSummary {
    const isDefaultQuery = !query.since && !query.project;
    if (isDefaultQuery && this.snapshot) return this.snapshot;

    const allRows = [...this.rows.values()];
    const result = aggregate(
      allRows,
      query,
      this.sessionTimes,
      buildIngestionAudit({
        rowsIndexed: this.rows.size,
        filesDiscovered: this.filesDiscovered,
        fileAudits: this.fileIngestionAudits.values(),
      })
    );

    if (isDefaultQuery) {
      this.snapshot = result;
    }

    return result;
  }

  /** Return per-session summaries, optionally filtered. */
  getSessions(query: MetricsQuery = {}): SessionSummary[] {
    const allRows = [...this.rows.values()];
    return computeSessionSummaries(allRows, query);
  }

  /**
   * Return per-turn data (TurnBucket[]) filtered by since and project, sorted
   * by costUsd descending, sliced to limit (max 50).
   *
   * Each TokenRow = one assistant turn. The timestamp is reconstructed from
   * row.date + row.hour (hour-level precision). This is an inherent limitation
   * of the in-memory model: epoch ms is stored only in sessionTimes, not in
   * TokenRow. Hour-level precision is acceptable for the expensive-turns table
   * because it is sorted by cost, not by time.
   */
  getTurns(query: MetricsQuery = {}, limit = 10): TurnBucket[] {
    const now = new Date();
    const sinceCutoff = parseSinceCutoff(query.since, now);

    const result: TurnBucket[] = [];
    for (const row of this.rows.values()) {
      if (query.project && !row.project.includes(query.project)) continue;
      if (sinceCutoff) {
        const rowDate = new Date(`${row.date}T00:00:00`);
        if (rowDate < sinceCutoff) continue;
      }
      // Reconstruct local ISO timestamp from date + hour (hour-precision).
      const timestamp = formatLocalHourIso(row.date, row.hour);
      result.push({
        timestamp,
        sessionId: row.sessionId,
        project: row.project,
        modelId: row.modelId,
        modelFamily: row.modelFamily,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        costUsd: row.costUsd,
        durationMs: row.turnDurationMs ?? null,
      });
    }

    // Sort by costUsd descending (most expensive turn first).
    result.sort((a, b) => b.costUsd - a.costUsd);
    return result.slice(0, Math.min(limit, 50));
  }

  /**
   * Return the full SessionDetail for a given sessionId, or null when no rows
   * exist for that session. Aggregates token/cost totals, derives a full
   * ToolBucket array (all tools, not capped at 3), and builds a per-turn array
   * sorted ascending by timestamp (oldest first).
   *
   * firstTs and lastTs are read from the private sessionTimes map; they are
   * returned as null when the entry has been evicted (50K-entry LRU cap).
   */
  getSessionDetail(sessionId: string): SessionDetail | null {
    const sessionRows: TokenRow[] = [];
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId) sessionRows.push(row);
    }
    if (sessionRows.length === 0) return null;

    // Aggregate totals.
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let webSearchRequests = 0;
    let isSubagent = false;
    let project = '';
    let projectName = '';

    // Full tool accumulator (not capped).
    const toolAcc = new Map<string, { count: number; errorCount: number }>();

    for (const row of sessionRows) {
      costUsd += row.costUsd;
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      cacheCreationTokens += row.cacheCreation5m + row.cacheCreation1h;
      cacheReadTokens += row.cacheReadTokens;
      webSearchRequests += row.webSearchRequests;
      if (row.isSubagent) isSubagent = true;
      // Use the first row's project/projectName (consistent within a session).
      if (!project) {
        project = row.project;
        projectName = row.projectName;
      }

      const uses = row.toolUses ?? {};
      const errors = row.toolErrors ?? {};
      for (const [toolName, count] of Object.entries(uses)) {
        const e = toolAcc.get(toolName);
        if (e) {
          e.count += count;
        } else {
          toolAcc.set(toolName, { count, errorCount: 0 });
        }
      }
      for (const [toolName, errCount] of Object.entries(errors)) {
        const e = toolAcc.get(toolName);
        if (e) {
          e.errorCount += errCount;
        } else {
          toolAcc.set(toolName, { count: 0, errorCount: errCount });
        }
      }
    }

    // Build byTool (all tools, sorted by count desc).
    const byTool: ToolBucket[] = [...toolAcc.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([toolName, { count, errorCount }]) => ({
        toolName,
        count,
        errorCount,
        errorRate: count > 0 ? errorCount / count : 0,
      }));

    // Build turns array sorted ascending by date+hour (oldest first).
    const turns: SessionTurnRow[] = sessionRows
      .slice()
      .sort((a, b) => {
        const aKey = `${a.date}:${String(a.hour).padStart(2, '0')}`;
        const bKey = `${b.date}:${String(b.hour).padStart(2, '0')}`;
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      })
      .map((row) => ({
        timestamp: formatLocalHourIso(row.date, row.hour),
        modelId: row.modelId,
        modelFamily: row.modelFamily,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        costUsd: row.costUsd,
        durationMs: row.turnDurationMs ?? null,
        toolUses: row.toolUses ?? {},
        toolErrors: row.toolErrors ?? {},
      }));

    // Read first/last timestamps from sessionTimes (null when evicted).
    const times = this.sessionTimes.get(sessionId);
    const firstTs = times ? new Date(times.firstTs).toISOString() : null;
    const lastTs = times ? new Date(times.lastTs).toISOString() : null;

    return {
      sessionId,
      project,
      projectName,
      costUsd,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      webSearchRequests,
      events: sessionRows.length,
      isSubagent,
      firstTs,
      lastTs,
      byTool,
      turns,
    };
  }

  isReady(): boolean {
    return this._initialized;
  }
}
