/**
 * In-memory aggregation engine for tokenomix server.
 *
 * IndexStore extends EventEmitter and owns:
 *   - A Map<dedup-key, TokenRow> that deduplicates by (requestId, message.id).
 *   - A lazy aggregate snapshot invalidated on every ingest.
 *   - Batch-parallel startup scan (50 files per batch) to bound fd usage.
 *
 * Dedup key: `${requestId}:${messageId}` — BOTH must be present.
 * If either is missing, the event is NOT counted (matches claude-usage.py:634).
 *
 * Timestamp handling: convert UTC ISO → system-local naive datetime before
 * bucketing into daily / weekly slices (mirrors parse_iso in claude-usage.py).
 */

import { EventEmitter } from 'node:events';
import type { Dirent } from 'node:fs';
import { readdir as readdirFn } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type {
  DailyBucket,
  HeatmapPoint,
  MetricSummary,
  MetricsQuery,
  ModelBucket,
  PeriodComparison,
  PeriodRollup,
  ProjectBucket,
  RawUsage,
  RawUsageEventParsed,
  SessionBucket,
  SessionDurationStats,
  SessionSummary,
  SubagentBucket,
  TokenRow,
  ToolBucket,
  TurnBucket,
  WeeklyBucket,
} from '@tokenomix/shared';
import type {
  SystemTurnDurationEventParsed,
  ToolResultEventParsed,
  ToolUseEventParsed,
} from '@tokenomix/shared';
import { logEvent } from './logger.js';
import { parseJSONLFile } from './parser.js';
import { computeCost, model_family, resolveCacheTokens } from './pricing.js';

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

// ---------------------------------------------------------------------------
// Timestamp helpers (mirrors claude-usage.py parse_iso lines 316-339)
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 timestamp string into a local naive Date.
 *
 * - "Z" suffix → parse as UTC (JavaScript Date always parses UTC correctly).
 * - Other formats → parse as-is.
 * - Returns null if the string is empty or unparseable.
 *
 * The resulting Date object carries local-time methods (getHours, getDate, etc.)
 * which mirror Python's aware_utc.astimezone().replace(tzinfo=None) behavior.
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
  const costUsd = computeCost(rawUsage, modelId);

  const isSubagent = filePath.includes('/subagents/');

  // Derive projectName as path.basename(cwd) with trailing slashes stripped.
  // This normalizes paths like "/foo/bar/" to "bar" (not "").
  const rawCwd = event.cwd ?? '';
  const projectName = nodePath.basename(rawCwd.replace(/\/+$/, ''));

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
    costUsd,
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
  sessionTimes: Map<string, { firstTs: number; lastTs: number }>
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

  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate >= cutoff30d) {
      costUsd30d += row.costUsd;
      inputTokens30d += row.inputTokens;
      outputTokens30d += row.outputTokens;
      cacheCreationTokens30d += row.cacheCreation5m + row.cacheCreation1h;
      cacheReadTokens30d += row.cacheReadTokens;
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

  // ── avgCostPerTurn30d / avgCostPerTurnPrev30d ─────────────────────────────
  // Uses projectFiltered (absolute 30d / prior 30d windows from today).
  let costSum30d = 0;
  let count30d = 0;
  let costSumPrev30d = 0;
  let countPrev30d = 0;
  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate >= cutoff30d) {
      costSum30d += row.costUsd;
      count30d += 1;
    } else if (rowDate >= cutoff60d) {
      costSumPrev30d += row.costUsd;
      countPrev30d += 1;
    }
  }
  const avgCostPerTurn30d = count30d > 0 ? costSum30d / count30d : 0;
  const avgCostPerTurnPrev30d = countPrev30d > 0 ? costSumPrev30d / countPrev30d : 0;

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
    bySession,
    heatmapData,
    byTool,
    bySubagent,
    totalFilesTouched,
    avgCostPerTurn30d,
    avgCostPerTurnPrev30d,
    toolErrorRate30d,
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
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      events: number;
      isSubagent: boolean;
    }
  >();

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
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreation5m + row.cacheCreation1h,
        cacheReadTokens: row.cacheReadTokens,
        events: 1,
        isSubagent: row.isSubagent,
      });
    }
  }

  return [...sessionMap.values()].sort((a, b) => b.costUsd - a.costUsd);
}

// ---------------------------------------------------------------------------
// IndexStore
// ---------------------------------------------------------------------------

export class IndexStore extends EventEmitter {
  /** @internal Exposed as package-internal for test access; do not mutate from outside. */
  readonly rows = new Map<string, TokenRow>();
  /** Per-session first/last event timestamps (epoch ms). Used for duration stats. */
  private readonly sessionTimes = new Map<string, { firstTs: number; lastTs: number }>();
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

  /**
   * Full startup scan — discover all JSONL files and ingest in parallel batches
   * of BATCH_SIZE to avoid fd-limit exhaustion with 2,500+ files.
   */
  async initialize(): Promise<void> {
    const files = await collectJsonlFiles(PROJECTS_DIR).catch(() => [] as string[]);

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

    // Map<toolUseId(uuid), toolName> — used to resolve tool name from tool_result.
    // Entries are purged on first match to keep the map small.
    const toolUseIdToName = new Map<string, string>();

    // Map<requestId, Map<toolName, errorCount>>
    const errorAccumulator = new Map<string, Map<string, number>>();

    // Map<requestId, durationMs> — from system/turn_duration events.
    const durationAccumulator = new Map<string, number>();

    // ── Pass 1: collect tool/duration events ──────────────────────────────────
    try {
      for await (const event of parseJSONLFile(filePath)) {
        // ── tool_use branch ─────────────────────────────────────────────────
        if (event.type === 'tool_use') {
          const toolEvent = event as unknown as ToolUseEventParsed;
          const rid = toolEvent.requestId;
          if (!rid) continue;

          const toolName = toolEvent.toolName;
          const filePath_ = toolEvent.input?.file_path; // privacy: only file_path

          // Record tool name by uuid for later join with tool_result.
          if (toolEvent.uuid) {
            toolUseIdToName.set(toolEvent.uuid, toolName);
          }

          // Accumulate count and file paths by (requestId, toolName).
          let toolsForReq = toolAccumulator.get(rid);
          if (!toolsForReq) {
            toolsForReq = new Map();
            toolAccumulator.set(rid, toolsForReq);
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
          continue;
        }

        // ── tool_result branch ──────────────────────────────────────────────
        if (event.type === 'tool_result') {
          const resultEvent = event as unknown as ToolResultEventParsed;
          const rid = resultEvent.requestId;

          // Resolve and immediately purge toolUseIdToName so the map only holds
          // entries for open (unresolved) tool invocations. This bounds peak memory
          // to O(concurrent open tools) rather than O(all tool_use events in file).
          const toolName = resultEvent.tool_use_id
            ? toolUseIdToName.get(resultEvent.tool_use_id)
            : undefined;
          if (resultEvent.tool_use_id) {
            toolUseIdToName.delete(resultEvent.tool_use_id);
          }

          // Only accumulate errors; non-error results need no further processing.
          if (!rid || !resultEvent.is_error) continue;

          if (!toolName) continue; // tool_use uuid not seen — skip

          let errorsForReq = errorAccumulator.get(rid);
          if (!errorsForReq) {
            errorsForReq = new Map();
            errorAccumulator.set(rid, errorsForReq);
          }
          errorsForReq.set(toolName, (errorsForReq.get(toolName) ?? 0) + 1);
          continue;
        }

        // ── system/turn_duration branch ─────────────────────────────────────
        if (event.type === 'system') {
          // The AssistantEventSchema uses z.string() for type, so system events
          // pass through. We need to check subtype at runtime.
          const sysEvent = event as unknown as SystemTurnDurationEventParsed;
          if ((sysEvent as { subtype?: string }).subtype !== 'turn_duration') continue;
          const rid = sysEvent.requestId;
          if (!rid) continue;
          // Last write wins if multiple duration events share the same requestId.
          durationAccumulator.set(rid, sysEvent.durationMs);
        }

        // assistant and other event types are not needed in pass 1 — skip.
      }
    } catch (err: unknown) {
      logEvent('error', 'ingest-error', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
        pass: 1,
      });
      // If pass 1 failed entirely, pass 2 will still run but with empty accumulators.
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
        // Matches claude-usage.py:634: (rid, mid) if rid and mid else None
        if (!requestId || !messageId) continue;

        const dedupKey = `${requestId}:${messageId}`;
        if (this.rows.has(dedupKey)) continue;

        const row = buildTokenRow(event, filePath);
        if (row) {
          // Merge tool/duration data collected in pass 1 for this requestId.
          // Because pass 1 completed before pass 2 began, tool events that
          // appear anywhere in the file (before or after the assistant event)
          // are guaranteed to be in the accumulators before we look them up here.
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
          }

          const errorsForReq = errorAccumulator.get(requestId);
          if (errorsForReq) {
            const toolErrors: Record<string, number> = {};
            for (const [toolName, count] of errorsForReq) {
              toolErrors[toolName] = count;
            }
            row.toolErrors = toolErrors;
          }

          const durationMs = durationAccumulator.get(requestId);
          if (durationMs !== undefined) {
            row.turnDurationMs = durationMs;
          }

          this.rows.set(dedupKey, row);

          // Track per-session first/last timestamps for duration stats.
          // Parse the timestamp independently so we have epoch ms precision;
          // buildTokenRow only stores date+hour in the TokenRow.
          const tsMs = parseIso(event.timestamp ?? undefined)?.getTime();
          if (tsMs !== undefined && row.sessionId) {
            const existing = this.sessionTimes.get(row.sessionId);
            if (existing) {
              existing.firstTs = Math.min(existing.firstTs, tsMs);
              existing.lastTs = Math.max(existing.lastTs, tsMs);
            } else {
              this.sessionTimes.set(row.sessionId, { firstTs: tsMs, lastTs: tsMs });
              // Evict oldest 10% when the Map grows beyond MAX_SESSION_TIMES.
              // Batching avoids re-sorting on every individual insert.
              if (this.sessionTimes.size > MAX_SESSION_TIMES) {
                const evictCount = Math.ceil(MAX_SESSION_TIMES * 0.1);
                const sorted = [...this.sessionTimes.entries()].sort(
                  (a, b) => a[1].firstTs - b[1].firstTs
                );
                for (let ei = 0; ei < evictCount; ei++) {
                  const entry = sorted[ei];
                  if (entry) this.sessionTimes.delete(entry[0]);
                }
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      // Log file-level ingestion errors with path only (no JSONL contents).
      logEvent('error', 'ingest-error', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
        pass: 2,
      });
    }
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
    const result = aggregate(allRows, query, this.sessionTimes);

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
      // Reconstruct ISO timestamp from date + hour (hour-precision).
      const hour = String(row.hour).padStart(2, '0');
      const timestamp = `${row.date}T${hour}:00:00`;
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

  isReady(): boolean {
    return this._initialized;
  }
}
