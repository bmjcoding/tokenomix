/**
 * Tests for buildPeriodRollup via the IndexStore.
 *
 * Covers:
 *   - dailySessions field: length equals dailyCost.length, correct per-day counts.
 *   - DST safety: rows on consecutive calendar days land in distinct buckets even
 *     when the test system is in a DST timezone.
 *   - Days with no events produce 0 in dailySessions (not undefined/missing).
 *   - sessionCount (period-wide) is unaffected by the new field.
 *
 * Also covers aggregate() fields added in Subtask 2:
 *   - totalProjectsTouched: basename-deduped count of distinct projectNames.
 *   - cacheCreationTokens30d: sum of (cacheCreation5m + cacheCreation1h) for rows
 *     in the absolute 30d window (projectFiltered set).
 *   - cacheReadTokens30d: sum of cacheReadTokens for rows in the same 30d window.
 */

import type { MetricSummary, TokenRow } from '@tokenomix/shared';
import { describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal TokenRow for testing. */
function makeRow(overrides: Partial<TokenRow>): TokenRow {
  return {
    date: '2026-04-01',
    hour: 12,
    sessionId: 'session-a',
    project: '/test/proj',
    projectName: 'proj',
    modelId: 'claude-sonnet-4-6',
    modelFamily: 'sonnet',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    costUsd: 0.001,
    isSubagent: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Access buildPeriodRollup indirectly via IndexStore.getMetrics
// ---------------------------------------------------------------------------

/**
 * Injects rows directly into the IndexStore's private map using the
 * ingestFile pathway — avoided here to stay unit-level. Instead we exercise
 * the public API by calling getMetrics() after manually populating via the
 * store's internal row map.
 *
 * We use the store's getMetrics() output and inspect monthlyRollup.current,
 * which covers the calendar month of `now`.
 */

describe('buildPeriodRollup — dailySessions field', () => {
  it('dailySessions has the same length as dailyCost', () => {
    const store = new IndexStore();
    // Inject rows via internal access (test-only pattern used in this codebase).
    const rows = store.rows as Map<string, TokenRow>;

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d1 = String(today.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d1}`;

    rows.set('req1:msg1', makeRow({ date: todayStr, sessionId: 'sess-1', costUsd: 0.01 }));
    rows.set('req2:msg2', makeRow({ date: todayStr, sessionId: 'sess-2', costUsd: 0.02 }));

    const metrics = store.getMetrics();
    const rollup = metrics.monthlyRollup.current;

    expect(rollup.dailySessions).toHaveLength(rollup.dailyCost.length);
    expect(rollup.dailySessions).toHaveLength(rollup.dailyTokens.length);
  });

  it('dailySessions[i] counts distinct sessions on that day', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const todayDay = today.getDate();
    const todayStr = `${y}-${m}-${String(todayDay).padStart(2, '0')}`;

    // Two events on today, same session.
    rows.set('req1:msg1', makeRow({ date: todayStr, sessionId: 'sess-x', costUsd: 0.01 }));
    rows.set('req2:msg2', makeRow({ date: todayStr, sessionId: 'sess-x', costUsd: 0.01 }));
    // One event on today from a different session.
    rows.set('req3:msg3', makeRow({ date: todayStr, sessionId: 'sess-y', costUsd: 0.01 }));

    const metrics = store.getMetrics();
    const rollup = metrics.monthlyRollup.current;
    const dayIdx = todayDay - 1; // month periods start from day 1 → idx 0

    expect(rollup.dailySessions[dayIdx]).toBe(2);
    // Period-wide sessionCount must also be 2.
    expect(rollup.sessionCount).toBe(2);
  });

  it('days with no events produce 0 in dailySessions', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const todayStr = `${y}-${m}-${String(today.getDate()).padStart(2, '0')}`;

    rows.set('req1:msg1', makeRow({ date: todayStr, sessionId: 'sess-a', costUsd: 0.01 }));

    const metrics = store.getMetrics();
    const rollup = metrics.monthlyRollup.current;

    // All entries must be 0 or a positive integer — never undefined.
    for (const v of rollup.dailySessions) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
    }

    // All days except today must be 0 (store is fresh, only today has data).
    const todayIdx = today.getDate() - 1;
    for (let i = 0; i < rollup.dailySessions.length; i++) {
      if (i !== todayIdx) {
        expect(rollup.dailySessions[i]).toBe(0);
      }
    }
  });

  it('rows outside the period bounds do not appear in dailySessions', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // A date clearly outside the current month (2 years ago).
    const oldDate = `${new Date().getFullYear() - 2}-01-15`;
    rows.set('req1:msg1', makeRow({ date: oldDate, sessionId: 'sess-old', costUsd: 10.0 }));

    const metrics = store.getMetrics();
    const rollup = metrics.monthlyRollup.current;

    // No sessions counted in the current month rollup.
    expect(rollup.sessionCount).toBe(0);
    expect(rollup.dailySessions.every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DST safety: calendar-day offset correctness
// ---------------------------------------------------------------------------

describe('buildPeriodRollup — DST-safe day indexing', () => {
  it('events on consecutive calendar days land in consecutive buckets', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = today.getDate();

    // Only use today and yesterday to ensure they're in the same month
    // (skip if today is the 1st to avoid crossing month boundary).
    if (d < 2) return; // degenerate — skip

    const todayStr = `${y}-${m}-${String(d).padStart(2, '0')}`;
    const yesterdayStr = `${y}-${m}-${String(d - 1).padStart(2, '0')}`;

    rows.set('req1:msg1', makeRow({ date: todayStr, sessionId: 'sess-t', costUsd: 0.1 }));
    rows.set('req2:msg2', makeRow({ date: yesterdayStr, sessionId: 'sess-y', costUsd: 0.2 }));

    const metrics = store.getMetrics();
    const rollup = metrics.monthlyRollup.current;

    const todayIdx = d - 1;
    const yesterdayIdx = d - 2;

    // Must land in different buckets.
    expect(rollup.dailyCost[todayIdx]).toBeCloseTo(0.1, 10);
    expect(rollup.dailyCost[yesterdayIdx]).toBeCloseTo(0.2, 10);
    // And the session counts per-day must also be distinct.
    expect(rollup.dailySessions[todayIdx]).toBe(1);
    expect(rollup.dailySessions[yesterdayIdx]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// totalProjectsTouched — basename dedup
// ---------------------------------------------------------------------------

describe('aggregate() — totalProjectsTouched basename dedup', () => {
  /**
   * Two TokenRows share the same projectName basename ('alt-central') but have
   * different full cwd project paths. aggregate() must count them as one project
   * in totalProjectsTouched (Set<projectName>.size = 1).
   *
   * The test uses makeRow() which defaults projectName to 'proj'. We override
   * project and projectName to set up the dedup scenario.
   */
  it('two rows with different project paths but same basename count as one project', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Two rows: different full paths, same basename 'alt-central'.
    rows.set(
      'req_dup_a:msg_dup_a',
      makeRow({
        project: '/foo/alt-central',
        projectName: 'alt-central',
        sessionId: 'sess-dup-a',
        costUsd: 0.01,
      })
    );
    rows.set(
      'req_dup_b:msg_dup_b',
      makeRow({
        project: '/bar/alt-central',
        projectName: 'alt-central',
        sessionId: 'sess-dup-b',
        costUsd: 0.01,
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    // totalProjectsTouched uses Set<projectName>, so both rows share one key.
    expect(metrics.totalProjectsTouched).toBe(1);

    // totalProjects uses raw cwd path, so it still counts 2 distinct paths.
    expect(metrics.totalProjects).toBe(2);
  });

  it('three rows with two distinct basenames count as two projects', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_3p_a:msg_3p_a',
      makeRow({ project: '/foo/alpha', projectName: 'alpha', sessionId: 'sess-3p-a' })
    );
    rows.set(
      'req_3p_b:msg_3p_b',
      makeRow({ project: '/bar/alpha', projectName: 'alpha', sessionId: 'sess-3p-b' })
    );
    rows.set(
      'req_3p_c:msg_3p_c',
      makeRow({ project: '/baz/beta', projectName: 'beta', sessionId: 'sess-3p-c' })
    );

    const metrics: MetricSummary = store.getMetrics();

    expect(metrics.totalProjectsTouched).toBe(2);
    expect(metrics.totalProjects).toBe(3); // raw cwd paths: /foo/alpha, /bar/alpha, /baz/beta
  });
});

// ---------------------------------------------------------------------------
// cacheCreationTokens30d / cacheReadTokens30d — 30d window scoping
// ---------------------------------------------------------------------------

describe('aggregate() — 30d cache token aggregation', () => {
  /**
   * cacheCreationTokens30d and cacheReadTokens30d are computed over the
   * projectFiltered set (absolute 30d from today, project filter only — NOT
   * since-filtered). This test uses recent dates to ensure rows fall within
   * the 30d window.
   *
   * Row A (30d window): cacheCreation5m=3000, cacheCreation1h=2000, cacheReadTokens=500
   * Row B (30d window): cacheCreation5m=1000, cacheCreation1h=0,    cacheReadTokens=200
   * Row C (outside 30d): cacheCreation5m=9999, cacheCreation1h=9999, cacheReadTokens=9999
   *
   * Expected cacheCreationTokens30d = (3000+2000) + (1000+0) = 6000
   * Expected cacheReadTokens30d    = 500 + 200 = 700
   */
  it('cacheCreationTokens30d sums (cacheCreation5m + cacheCreation1h) for rows in 30d window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Recent dates (within 30d window).
    rows.set(
      'req_cache_a:msg_cache_a',
      makeRow({
        date: '2026-04-27',
        cacheCreation5m: 3000,
        cacheCreation1h: 2000,
        cacheReadTokens: 500,
        costUsd: 0.01,
      })
    );
    rows.set(
      'req_cache_b:msg_cache_b',
      makeRow({
        date: '2026-04-26',
        cacheCreation5m: 1000,
        cacheCreation1h: 0,
        cacheReadTokens: 200,
        costUsd: 0.01,
      })
    );

    // Row outside the 30d window (2 years ago) — must NOT contribute.
    rows.set(
      'req_cache_old:msg_cache_old',
      makeRow({
        date: `${new Date().getFullYear() - 2}-01-15`,
        cacheCreation5m: 9999,
        cacheCreation1h: 9999,
        cacheReadTokens: 9999,
        costUsd: 0.01,
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    // cacheCreationTokens30d = (3000+2000) + (1000+0) = 6000
    expect(metrics.cacheCreationTokens30d).toBe(6000);

    // cacheReadTokens30d = 500 + 200 = 700
    expect(metrics.cacheReadTokens30d).toBe(700);
  });

  it('cacheCreationTokens30d is 0 when no rows fall within the 30d window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Only old rows — outside the 30d window.
    rows.set(
      'req_nocache:msg_nocache',
      makeRow({
        date: `${new Date().getFullYear() - 2}-06-01`,
        cacheCreation5m: 5000,
        cacheCreation1h: 1000,
        cacheReadTokens: 300,
        costUsd: 0.01,
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    expect(metrics.cacheCreationTokens30d).toBe(0);
    expect(metrics.cacheReadTokens30d).toBe(0);
  });
});
