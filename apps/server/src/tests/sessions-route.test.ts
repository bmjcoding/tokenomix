/**
 * Tests for the sessions API routes:
 *   - GET /api/sessions       → SessionSummary[]
 *   - GET /api/sessions/:id   → SessionDetail | { error: string }
 *
 * Tests exercise the real route handler from apps/server/src/routes/sessions.ts
 * via Hono's test client pattern (`app.request(url)`).
 *
 * The store is populated by injecting TokenRow objects directly into store.rows
 * (the same pattern used in turns-route.test.ts) so tests do not depend on
 * filesystem fixtures.
 *
 * Test cases:
 *   1. Valid ID returns 200 with well-formed SessionDetail body
 *   2. Unknown ID returns 404 with { error: string } envelope
 *   3. Param guard rejects oversized ID (>200 chars) with 400
 *   4. Param guard rejects path separator in ID with 400
 *   5. SessionSummary list includes projectName field
 *   6. Graceful handling when toolUses is undefined on every row in a session
 */

import type { SessionDetail, SessionSummary, TokenRow } from '@tokenomix/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store.js';
import { sessionsRoute } from '../routes/sessions.js';

// ---------------------------------------------------------------------------
// App factory — uses the REAL route (no inline reimplementation)
// ---------------------------------------------------------------------------

function buildSessionsApp(store: IndexStore): Hono {
  const app = new Hono();
  app.route('/api/sessions', sessionsRoute(store));
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal TokenRow for injection into store.rows. */
function makeRow(overrides: Partial<TokenRow>): TokenRow {
  return {
    date: '2026-04-27',
    hour: 10,
    sessionId: 'session-default',
    project: '/projects/default',
    projectName: 'default',
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
// Tests for GET /api/sessions/:id
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id', () => {
  it('valid ID returns 200 with well-formed SessionDetail body', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-detail-001';
    rows.set(
      'req_d1:msg_d1',
      makeRow({
        sessionId,
        project: '/projects/my-app',
        projectName: 'my-app',
        inputTokens: 500,
        outputTokens: 200,
        cacheCreation5m: 100,
        cacheCreation1h: 50,
        cacheReadTokens: 300,
        webSearchRequests: 2,
        costUsd: 0.0123,
        toolUses: { Bash: 3, Read: 5 },
        toolErrors: { Bash: 1 },
        turnDurationMs: 4200,
      })
    );
    rows.set(
      'req_d2:msg_d2',
      makeRow({
        sessionId,
        project: '/projects/my-app',
        projectName: 'my-app',
        inputTokens: 300,
        outputTokens: 100,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        costUsd: 0.005,
        toolUses: { Write: 2 },
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    // Top-level identity fields.
    expect(body.sessionId).toBe(sessionId);
    expect(body.project).toBe('/projects/my-app');
    expect(body.projectName).toBe('my-app');

    // Aggregated token/cost totals.
    expect(body.inputTokens).toBe(800);
    expect(body.outputTokens).toBe(300);
    expect(body.cacheCreationTokens).toBe(150); // 100+50 from row 1
    expect(body.cacheReadTokens).toBe(300);
    expect(body.webSearchRequests).toBe(2);
    expect(typeof body.costUsd).toBe('number');
    expect(body.costUsd).toBeCloseTo(0.0173, 5);
    expect(body.events).toBe(2);

    // firstTs / lastTs are null when injected directly (sessionTimes not populated).
    expect(body.firstTs === null || typeof body.firstTs === 'string').toBe(true);
    expect(body.lastTs === null || typeof body.lastTs === 'string').toBe(true);

    // byTool: aggregated across both turns.
    expect(Array.isArray(body.byTool)).toBe(true);
    const toolNames = body.byTool.map((t) => t.toolName);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    const bashBucket = body.byTool.find((t) => t.toolName === 'Bash');
    expect(bashBucket?.count).toBe(3);
    expect(bashBucket?.errorCount).toBe(1);
    expect(typeof bashBucket?.errorRate).toBe('number');

    // turns: sorted ascending, one entry per row.
    expect(Array.isArray(body.turns)).toBe(true);
    expect(body.turns).toHaveLength(2);
    const firstTurn = body.turns[0];
    expect(typeof firstTurn?.timestamp).toBe('string');
    expect(typeof firstTurn?.modelId).toBe('string');
    expect(typeof firstTurn?.costUsd).toBe('number');
    expect(typeof firstTurn?.inputTokens).toBe('number');
    expect(typeof firstTurn?.outputTokens).toBe('number');
    expect(typeof firstTurn?.cacheReadTokens).toBe('number');
    // toolUses must be a Record<string, number>, not undefined.
    expect(typeof firstTurn?.toolUses).toBe('object');
    expect(typeof firstTurn?.toolErrors).toBe('object');
  });

  it('unknown sessionId returns 404 with { error: string }', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    const res = await app.request('/api/sessions/does-not-exist');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('oversized ID (201+ chars) returns 400 with { error: string }', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    const oversizedId = 'a'.repeat(201);
    const res = await app.request(`/api/sessions/${oversizedId}`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('ID with path separator returns 400 with { error: string }', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    // Use URL-encoded forward slash so the path param isn't split by the router.
    const res = await app.request('/api/sessions/foo%2Fbar');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('ID with backslash returns 400 with { error: string }', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    // Use URL-encoded backslash (%5C) so the raw character doesn't interfere with routing.
    const res = await app.request('/api/sessions/foo%5Cbar');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('ID with NULL byte returns 400 with { error: string }', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    // Use URL-encoded NULL byte (%00) to confirm the allowlist rejects it.
    const res = await app.request('/api/sessions/foo%00bar');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('session with undefined toolUses returns 200; byTool is [] and turn toolUses is {}', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-no-tools';
    // Row with no toolUses field at all (undefined by makeRow defaults).
    rows.set(
      'req_nt:msg_nt',
      makeRow({
        sessionId,
        project: '/projects/no-tool-app',
        projectName: 'no-tool-app',
        costUsd: 0.002,
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    // byTool must be an empty array (no tool data).
    expect(body.byTool).toEqual([]);

    // Each turn's toolUses and toolErrors must be a defined empty object (not undefined).
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]?.toolUses).toEqual({});
    expect(body.turns[0]?.toolErrors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// costBreakdown tests for GET /api/sessions/:id
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id — costBreakdown', () => {
  it('sum of costBreakdown components approximately equals costUsd across multiple rows', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-breakdown-sum';

    // Row 1: stored per-component costs set explicitly.
    rows.set(
      'req_cb1:msg_cb1',
      makeRow({
        sessionId,
        project: '/projects/breakdown-test',
        projectName: 'breakdown-test',
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 500,
        costUsd: 0.004,
        inputCostUsd: 0.003,
        outputCostUsd: 0.0006,
        cacheCreationCostUsd: 0,
        cacheReadCostUsd: 0.0004,
      })
    );

    // Row 2: second set of explicit stored per-component costs.
    rows.set(
      'req_cb2:msg_cb2',
      makeRow({
        sessionId,
        project: '/projects/breakdown-test',
        projectName: 'breakdown-test',
        inputTokens: 500,
        outputTokens: 100,
        cacheCreation5m: 200,
        cacheCreation1h: 0,
        cacheReadTokens: 0,
        costUsd: 0.002,
        inputCostUsd: 0.0015,
        outputCostUsd: 0.0003,
        cacheCreationCostUsd: 0.0002,
        cacheReadCostUsd: 0,
      })
    );

    // Row 3: third row with different component values.
    rows.set(
      'req_cb3:msg_cb3',
      makeRow({
        sessionId,
        project: '/projects/breakdown-test',
        projectName: 'breakdown-test',
        inputTokens: 300,
        outputTokens: 50,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 100,
        costUsd: 0.001,
        inputCostUsd: 0.0007,
        outputCostUsd: 0.0001,
        cacheCreationCostUsd: 0,
        cacheReadCostUsd: 0.0002,
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    // costBreakdown field must exist and be an object.
    expect(body.costBreakdown).toBeDefined();
    expect(typeof body.costBreakdown).toBe('object');

    // All four fields must be numeric.
    expect(typeof body.costBreakdown.input).toBe('number');
    expect(typeof body.costBreakdown.output).toBe('number');
    expect(typeof body.costBreakdown.cacheCreate).toBe('number');
    expect(typeof body.costBreakdown.cacheRead).toBe('number');

    // The sum of per-component costs should approximately equal costUsd.
    const componentSum =
      body.costBreakdown.input +
      body.costBreakdown.output +
      body.costBreakdown.cacheCreate +
      body.costBreakdown.cacheRead;
    expect(componentSum).toBeCloseTo(body.costUsd, 4);

    // Verify expected accumulated values from our explicit fixtures.
    expect(body.costBreakdown.input).toBeCloseTo(0.003 + 0.0015 + 0.0007, 6);
    expect(body.costBreakdown.output).toBeCloseTo(0.0006 + 0.0003 + 0.0001, 6);
    expect(body.costBreakdown.cacheCreate).toBeCloseTo(0 + 0.0002 + 0, 6);
    expect(body.costBreakdown.cacheRead).toBeCloseTo(0.0004 + 0 + 0.0002, 6);
  });

  it('costBreakdown is all zeros when rows have no priced cost components', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-breakdown-zero';

    // Row with all zero tokens — fallback pricing will also yield zero for all components.
    rows.set(
      'req_cz1:msg_cz1',
      makeRow({
        sessionId,
        project: '/projects/zero-test',
        projectName: 'zero-test',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        costUsd: 0,
        // Explicitly omit all *CostUsd fields — no stored component costs.
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    expect(body.costBreakdown).toBeDefined();
    expect(body.costBreakdown.input).toBe(0);
    expect(body.costBreakdown.output).toBe(0);
    expect(body.costBreakdown.cacheCreate).toBe(0);
    expect(body.costBreakdown.cacheRead).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests for GET /api/sessions (list)
// ---------------------------------------------------------------------------

describe('GET /api/sessions', () => {
  it('session summary includes projectName equal to basename of project path', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-pn-001';
    rows.set(
      'req_pn:msg_pn',
      makeRow({
        sessionId,
        project: '/users/alice/projects/awesome-app',
        projectName: 'awesome-app',
        costUsd: 0.05,
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.projectName).toBe('awesome-app');
  });

  it('session summary includes topTools (array) and toolNamesCount (non-negative integer)', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-tools-001';
    rows.set(
      'req_tp1:msg_tp1',
      makeRow({
        sessionId,
        project: '/projects/tools-test',
        projectName: 'tools-test',
        costUsd: 0.01,
        toolUses: { Bash: 10, Read: 6, Write: 4, Edit: 2, Grep: 1 },
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();

    // topTools is an array of at most 3 entries, sorted by count descending.
    expect(Array.isArray(entry?.topTools)).toBe(true);
    expect((entry?.topTools.length ?? 0) >= 0).toBe(true);
    expect((entry?.topTools.length ?? 0) <= 3).toBe(true);

    // toolNamesCount is a non-negative integer.
    expect(typeof entry?.toolNamesCount).toBe('number');
    expect(Number.isInteger(entry?.toolNamesCount)).toBe(true);
    expect((entry?.toolNamesCount ?? -1) >= 0).toBe(true);

    // With 5 distinct tools, topTools should have 3 and toolNamesCount should be 5.
    expect(entry?.topTools).toHaveLength(3);
    expect(entry?.toolNamesCount).toBe(5);

    // Top tool should be Bash (count: 10).
    expect(entry?.topTools[0]?.toolName).toBe('Bash');
    expect(entry?.topTools[0]?.count).toBe(10);
  });

  it('session summary has topTools as [] and toolNamesCount as 0 when no toolUses', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-no-tools-list';
    rows.set(
      'req_ntl:msg_ntl',
      makeRow({
        sessionId,
        project: '/projects/plain',
        projectName: 'plain',
        costUsd: 0.001,
        // No toolUses field (undefined by default).
      })
    );

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.topTools).toEqual([]);
    expect(entry?.toolNamesCount).toBe(0);
  });

  it('sessions list is sorted by costUsd descending', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set('req_s1:msg_s1', makeRow({ sessionId: 'sess-cheap', costUsd: 0.001 }));
    rows.set('req_s2:msg_s2', makeRow({ sessionId: 'sess-expensive', costUsd: 0.1 }));
    rows.set('req_s3:msg_s3', makeRow({ sessionId: 'sess-mid', costUsd: 0.05 }));

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    expect(body).toHaveLength(3);
    expect(body[0]?.sessionId).toBe('sess-expensive');
    expect(body[1]?.sessionId).toBe('sess-mid');
    expect(body[2]?.sessionId).toBe('sess-cheap');
  });
});
