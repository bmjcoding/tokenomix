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
  TokenRow,
  WeeklyBucket,
} from '@tokenomix/shared';
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
// Structured logging
// ---------------------------------------------------------------------------

/**
 * Write a structured JSON log entry to stdout (or stderr for 'error' level).
 * All entries include timestamp, level, service, and event fields.
 */
function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'tokenomix-server',
    event,
    ...fields,
  });
  if (level === 'error') {
    process.stderr.write(`${entry}\n`);
  } else {
    process.stdout.write(`${entry}\n`);
  }
}

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
 * Build a TokenRow from a validated JSONL event.
 * Returns null if essential fields are missing (usage, timestamp).
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

  const row: TokenRow = {
    date: toLocalDateStr(ts),
    hour: toLocalHour(ts),
    sessionId: event.sessionId ?? '',
    project: event.cwd ?? '',
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
 * outputTokens30d) are ALWAYS computed against the full unfiltered row set.
 * They are defined as absolute 30d/5d windows from today, not windows
 * relative to the `since` filter.
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

  for (const row of projectFiltered) {
    const rowDate = new Date(`${row.date}T00:00:00`);
    if (rowDate >= cutoff30d) {
      costUsd30d += row.costUsd;
      inputTokens30d += row.inputTokens;
      outputTokens30d += row.outputTokens;
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
    costUsd30d,
    costUsd5d,
    inputTokens30d,
    outputTokens30d,
    dailySeries,
    weeklySeries,
    byModel,
    byProject,
    bySession,
    heatmapData,
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

  private async ingestFileInternal(filePath: string): Promise<void> {
    try {
      for await (const event of parseJSONLFile(filePath)) {
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

  isReady(): boolean {
    return this._initialized;
  }
}
