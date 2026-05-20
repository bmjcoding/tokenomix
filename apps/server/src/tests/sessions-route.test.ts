/**
 * Tests for the sessions API routes:
 *   - GET /api/sessions       → SessionSummary[]
 *   - GET /api/sessions/:id   → SessionDetail | { error: string }
 *   - POST /api/sessions/:id/reveal → 204 | 404 | 400
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
 *   7. GET /api/sessions rejects malformed limits
 *   8–11. initialPrompt / initialPromptTruncated / jsonlPath from ingestFile
 *   12–14. POST /api/sessions/:id/reveal
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type SessionDetail,
  type SessionSummary,
  type TokenRow,
  WEB_SEARCH_USD_PER_REQUEST,
} from '@tokenomix/shared';
import { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { IndexStore } from '../index-store.js';
import { LOCAL_ACTION_HEADER } from '../routes/local-action.js';
import { sessionsRoute } from '../routes/sessions.js';

// ---------------------------------------------------------------------------
// Module-level mock for node:child_process — hoisted by Vitest before imports
// so the route module picks up the mock when it runs `spawn(...)`.
// Each test that needs spawn mocked will configure the mock via
// `mockSpawn.mockReturnValue(...)`.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Import the mocked spawn AFTER vi.mock so we get the mock version.
const { spawn: mockSpawn } = await import('node:child_process');
const LOCAL_ACTION_REQUEST = { method: 'POST', headers: { [LOCAL_ACTION_HEADER]: '1' } } as const;

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
    minute: 0,
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
        webSearchRequests: 2,
        costUsd: 0.024,
        inputCostUsd: 0.003,
        outputCostUsd: 0.0006,
        cacheCreationCostUsd: 0,
        cacheReadCostUsd: 0.0004,
        webSearchCostUsd: 2 * WEB_SEARCH_USD_PER_REQUEST,
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

    // All component fields must be numeric.
    expect(typeof body.costBreakdown.input).toBe('number');
    expect(typeof body.costBreakdown.output).toBe('number');
    expect(typeof body.costBreakdown.cacheCreate).toBe('number');
    expect(typeof body.costBreakdown.cacheRead).toBe('number');
    expect(typeof body.costBreakdown.webSearch).toBe('number');

    // The sum of per-component costs should approximately equal costUsd.
    const componentSum =
      body.costBreakdown.input +
      body.costBreakdown.output +
      body.costBreakdown.cacheCreate +
      body.costBreakdown.cacheRead +
      body.costBreakdown.webSearch;
    expect(componentSum).toBeCloseTo(body.costUsd, 4);

    // Verify expected accumulated values from our explicit fixtures.
    expect(body.costBreakdown.input).toBeCloseTo(0.003 + 0.0015 + 0.0007, 6);
    expect(body.costBreakdown.output).toBeCloseTo(0.0006 + 0.0003 + 0.0001, 6);
    expect(body.costBreakdown.cacheCreate).toBeCloseTo(0 + 0.0002 + 0, 6);
    expect(body.costBreakdown.cacheRead).toBeCloseTo(0.0004 + 0 + 0.0002, 6);
    expect(body.costBreakdown.webSearch).toBeCloseTo(2 * WEB_SEARCH_USD_PER_REQUEST, 6);
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
    expect(body.costBreakdown.webSearch).toBe(0);
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

  it('marks a session summary as subagent when any row in the session is from a subagent', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-mixed-subagent';
    rows.set('req_main:msg_main', makeRow({ sessionId, costUsd: 0.001, isSubagent: false }));
    rows.set('req_agent:msg_agent', makeRow({ sessionId, costUsd: 0.002, isSubagent: true }));

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.isSubagent).toBe(true);
  });

  it('rejects malformed limit values instead of partial numeric coercion', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    for (const limit of ['-5', '0', '10abc']) {
      const res = await app.request(`/api/sessions?limit=${encodeURIComponent(limit)}`);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('limit must be a positive integer');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for initialPrompt / initialPromptTruncated / jsonlPath
// ---------------------------------------------------------------------------

// Track temp files created during these tests for cleanup.
const tempFiles: string[] = [];

afterAll(async () => {
  await Promise.all(tempFiles.map((f) => fs.unlink(f).catch(() => undefined)));
});

/**
 * Write a JSONL fixture to a temp file and return its path.
 * The fixture contains a single user event with the given message content.
 */
async function writeTempJsonl(
  sessionId: string,
  messageContent: string | Array<Record<string, unknown>>
): Promise<string> {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `tokenomix-test-${sessionId}-${Date.now()}.jsonl`);
  const event = JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: '2026-04-29T10:00:00.000Z',
    message: {
      role: 'user',
      content: messageContent,
    },
  });
  await fs.writeFile(tmpFile, `${event}\n`, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

describe('GET /api/sessions/:id — initialPrompt fields', () => {
  it('prompt under 500 chars: initialPrompt set, initialPromptTruncated false, jsonlPath set', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    const sessionId = 'sess-prompt-short';

    const promptText = 'Help me debug this issue';
    const tmpFile = await writeTempJsonl(sessionId, promptText);
    await store.ingestFile(tmpFile);

    rows.set(
      'req_ps1:msg_ps1',
      makeRow({ sessionId, project: '/projects/prompt-test', projectName: 'prompt-test' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    expect(body.initialPrompt).toBe(promptText);
    expect(body.initialPromptTruncated).toBe(false);
    expect(body.jsonlPath).toBe(tmpFile);
  });

  it('prompt over 500 chars: initialPrompt.length === 500, initialPromptTruncated true, jsonlPath set', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    const sessionId = 'sess-prompt-long';

    // 600 chars of text.
    const longPrompt = 'A'.repeat(600);
    const tmpFile = await writeTempJsonl(sessionId, longPrompt);
    await store.ingestFile(tmpFile);

    rows.set(
      'req_pl1:msg_pl1',
      makeRow({ sessionId, project: '/projects/prompt-long', projectName: 'prompt-long' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    expect(body.initialPrompt).not.toBeNull();
    expect(body.initialPrompt?.length).toBe(500);
    expect(body.initialPromptTruncated).toBe(true);
    expect(body.jsonlPath).toBe(tmpFile);
  });

  it('session with no qualifying user event: initialPrompt null, initialPromptTruncated false, jsonlPath null', async () => {
    // Only inject a TokenRow directly — no JSONL file with a user event.
    // The sessionInitialPrompts map will have no entry for this sessionId.
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    const sessionId = 'sess-no-prompt';

    rows.set(
      'req_np1:msg_np1',
      makeRow({ sessionId, project: '/projects/no-prompt', projectName: 'no-prompt' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    expect(body.initialPrompt).toBeNull();
    expect(body.initialPromptTruncated).toBe(false);
    expect(body.jsonlPath).toBeNull();
  });

  it('multi-block content: only text blocks are concatenated, tool_result blocks are skipped', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    const sessionId = 'sess-prompt-blocks';

    const contentBlocks = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_result', tool_use_id: 'tu_abc', is_error: false, content: 'some output' },
      { type: 'text', text: 'World' },
    ];
    const tmpFile = await writeTempJsonl(sessionId, contentBlocks);
    await store.ingestFile(tmpFile);

    rows.set(
      'req_pb1:msg_pb1',
      makeRow({ sessionId, project: '/projects/prompt-blocks', projectName: 'prompt-blocks' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionDetail;

    expect(body.initialPrompt).toBe('Hello\nWorld');
    expect(body.initialPromptTruncated).toBe(false);
    expect(body.jsonlPath).toBe(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// Tests for GET /api/sessions — firstTs field
// ---------------------------------------------------------------------------

/**
 * Write a minimal JSONL fixture with a single assistant event that has a usage
 * block. ingestFile() will parse this, produce a TokenRow, and call
 * recordSessionTimestamp() — populating sessionTimes for the given sessionId.
 */
async function writeTempAssistantJsonl(sessionId: string, timestampIso: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `tokenomix-asst-${sessionId}-${Date.now()}.jsonl`);
  const event = JSON.stringify({
    type: 'assistant',
    requestId: `req-${sessionId}`,
    sessionId,
    timestamp: timestampIso,
    cwd: '/projects/firstts-test',
    message: {
      id: `msg-${sessionId}`,
      model: 'claude-sonnet-4-6-20251120',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  await fs.writeFile(tmpFile, `${event}\n`, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

describe('GET /api/sessions — firstTs field', () => {
  it('firstTs is the ISO string matching the known epoch ms when sessionTimes is populated', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-firstts-populated';
    // Use a fixed, deterministic timestamp so the assertion is exact.
    const knownIso = '2026-04-15T14:00:00.000Z';
    const expectedFirstTs = new Date(knownIso).toISOString();

    const tmpFile = await writeTempAssistantJsonl(sessionId, knownIso);
    await store.ingestFile(tmpFile);

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.firstTs).toBe(expectedFirstTs);
  });

  it('firstTs is null when the session row was injected directly (sessionTimes not populated)', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-firstts-null';
    // Inject a row directly — bypasses ingestFileInternal and recordSessionTimestamp.
    rows.set(
      'req_ftn:msg_ftn',
      makeRow({ sessionId, project: '/projects/firstts-null', projectName: 'firstts-null' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.firstTs).toBeNull();
  });

  it('durationMs is a non-negative integer when sessionTimes is populated via ingestFile', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-duration-populated';
    // Use two timestamps so durationMs = lastTs - firstTs > 0.
    const firstIso = '2026-04-15T10:00:00.000Z';
    const lastIso = '2026-04-15T10:05:00.000Z';
    const expectedDurationMs = new Date(lastIso).getTime() - new Date(firstIso).getTime();

    // Write a single JSONL with two distinct assistant events (different requestId + message.id)
    // so each is a unique dedup key and both timestamps are recorded in sessionTimes.
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `tokenomix-duration-${sessionId}-${Date.now()}.jsonl`);
    const event1 = JSON.stringify({
      type: 'assistant',
      requestId: `req-dur-a-${sessionId}`,
      sessionId,
      timestamp: firstIso,
      cwd: '/projects/duration-test',
      message: {
        id: `msg-dur-a-${sessionId}`,
        model: 'claude-sonnet-4-6-20251120',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const event2 = JSON.stringify({
      type: 'assistant',
      requestId: `req-dur-b-${sessionId}`,
      sessionId,
      timestamp: lastIso,
      cwd: '/projects/duration-test',
      message: {
        id: `msg-dur-b-${sessionId}`,
        model: 'claude-sonnet-4-6-20251120',
        usage: {
          input_tokens: 80,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    await fs.writeFile(tmpFile, `${event1}\n${event2}\n`, 'utf-8');
    tempFiles.push(tmpFile);

    await store.ingestFile(tmpFile);

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.durationMs).toBe(expectedDurationMs);
    expect(typeof entry?.durationMs).toBe('number');
    expect((entry?.durationMs ?? -1) >= 0).toBe(true);
  });

  it('durationMs is null when the session row was injected directly (sessionTimes not populated)', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const sessionId = 'sess-duration-null';
    // Inject a row directly — bypasses ingestFileInternal and recordSessionTimestamp.
    rows.set(
      'req_dn:msg_dn',
      makeRow({ sessionId, project: '/projects/duration-null', projectName: 'duration-null' })
    );

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
    expect(entry?.durationMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests for POST /api/sessions/:id/reveal
// ---------------------------------------------------------------------------

/**
 * Build a minimal ChildProcess-like EventEmitter stub that satisfies the
 * spawn return type used by the reveal route.
 *
 * `outcome` controls what the stub emits after its listeners are registered:
 *   - 'close' (default): emits the 'close' event on the next microtask tick,
 *     simulating a successful spawn that exits immediately.
 *   - 'error': emits an 'error' event with an Error object, simulating a
 *     failed spawn (e.g. command not found).
 *
 * The emit is deferred with setImmediate so the route's `.on('error')` and
 * `.on('close')` handlers are registered before the event fires. This matches
 * the B2 implementation which awaits a Promise that resolves on 'close' and
 * rejects on 'error'.
 */
function makeSpawnStub(outcome: 'close' | 'error' = 'close') {
  const emitter = new EventEmitter() as EventEmitter & { unref: () => void };
  emitter.unref = vi.fn();

  // Defer emission so the route's listeners are attached first.
  setImmediate(() => {
    if (outcome === 'error') {
      emitter.emit('error', new Error('spawn ENOENT'));
    } else {
      emitter.emit('close', 0);
    }
  });

  return emitter;
}

describe('POST /api/sessions/:id/reveal', () => {
  // Reset the spawn mock after each test so call counts don't bleed between tests.
  afterEach(() => {
    vi.mocked(mockSpawn).mockReset();
  });

  it('returns 204 for a known session and calls spawn with the correct arguments (macOS)', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-reveal-ok';

    const tmpFile = await writeTempJsonl(sessionId, 'reveal me');
    await store.ingestFile(tmpFile);

    // Configure the mock to return an EventEmitter stub with .unref().
    const spawnStub = makeSpawnStub();
    vi.mocked(mockSpawn).mockReturnValue(
      spawnStub as unknown as ReturnType<typeof import('node:child_process').spawn>
    );

    // Override platform to darwin so the darwin branch is exercised.
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}/reveal`, LOCAL_ACTION_REQUEST);

    expect(res.status).toBe(204);

    // spawn must be called once with the right command and path as separate arg.
    expect(vi.mocked(mockSpawn)).toHaveBeenCalledOnce();
    const [cmd, args] = vi.mocked(mockSpawn).mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('open');
    expect(args).toEqual(['-R', tmpFile]);

    // .unref() must be called so the child doesn't keep the event loop alive.
    expect(spawnStub.unref).toHaveBeenCalledOnce();

    platformSpy.mockRestore();
  });

  it('returns 403 without the local action header', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);

    const res = await app.request('/api/sessions/anything/reveal', { method: 'POST' });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('local action header required');
    expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled();
  });

  it('returns 404 with { error } when session has no recorded JSONL path', async () => {
    const store = new IndexStore();
    // Do not ingest any file — sessionInitialPrompts will have no entry.

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/missing-session/reveal', LOCAL_ACTION_REQUEST);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('returns 400 when ID contains a path separator (foo%2Fbar)', async () => {
    const store = new IndexStore();

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/foo%2Fbar/reveal', LOCAL_ACTION_REQUEST);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('returns 500 with { error } body when spawn emits an error event', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-reveal-err';

    const tmpFile = await writeTempJsonl(sessionId, 'reveal me error');
    await store.ingestFile(tmpFile);

    // Stub emits 'error' instead of 'close' — simulates ENOENT / permission failure.
    const spawnStub = makeSpawnStub('error');
    vi.mocked(mockSpawn).mockReturnValue(
      spawnStub as unknown as ReturnType<typeof import('node:child_process').spawn>
    );

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/${sessionId}/reveal`, LOCAL_ACTION_REQUEST);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);

    // spawn was called once before the error was emitted.
    expect(vi.mocked(mockSpawn)).toHaveBeenCalledOnce();

    platformSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests for GET /api/sessions/active
// ---------------------------------------------------------------------------

/**
 * How recency works in these tests:
 *
 * "Active" tests need sessions whose lastTs falls within the windowMs cap
 * (max 86_400_000 ms / 24 h). We generate fixture timestamps dynamically from
 * Date.now() so they remain within the cap regardless of when the suite runs:
 *
 *   - recentIso(offsetMs) → ISO string for (Date.now() - offsetMs)
 *   - "active" fixture: offsetMs = 60_000 (1 min ago) → within any ≥60 s window
 *   - "old" fixture: offsetMs = 1 (1 ms ago) → only within a 1 ms window
 *     (we test with windowMs=1 to filter it out, meaning cutoff ≈ now)
 *
 * For "filters out" tests we still use ancient fixed timestamps (2026-04-15)
 * and windowMs=1 — those sessions are billions of ms in the past and always
 * excluded from a 1 ms window.
 *
 * For the sort/limit test we use three dynamic timestamps: 1 min, 2 min, and
 * 3 min ago — all within the 86_400_000 ms cap.
 */

/** ISO string for (Date.now() - offsetMs). */
function recentIso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/** A window large enough to include sessions from 1–3 min ago (5 min). */
const FIVE_MIN_MS = 300_000;

describe('GET /api/sessions/active', () => {
  it('returns sessions whose lastTs is within windowMs', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-active-within';

    // Session from 1 minute ago — within a 5 min window.
    const tmpFile = await writeTempAssistantJsonl(sessionId, recentIso(60_000));
    await store.ingestFile(tmpFile);

    const app = buildSessionsApp(store);
    const res = await app.request(`/api/sessions/active?windowMs=${FIVE_MIN_MS}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeDefined();
  });

  it('filters out sessions older than windowMs', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-active-old';

    // Session from 2026-04-15 — billions of ms in the past, outside any 1 ms window.
    const tmpFile = await writeTempAssistantJsonl(sessionId, '2026-04-15T10:00:00.000Z');
    await store.ingestFile(tmpFile);

    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    const entry = body.find((s) => s.sessionId === sessionId);
    expect(entry).toBeUndefined();
  });

  it('returns at most `limit` sessions, sorted by lastTs desc', async () => {
    const store = new IndexStore();

    // Three sessions: newest 1 min ago, mid 2 min ago, oldest 3 min ago.
    // All within the 5 min window.
    const sessions = [
      { id: 'sess-active-sort-old', ts: recentIso(3 * 60_000) },
      { id: 'sess-active-sort-new', ts: recentIso(1 * 60_000) },
      { id: 'sess-active-sort-mid', ts: recentIso(2 * 60_000) },
    ];

    for (const s of sessions) {
      const tmpFile = await writeTempAssistantJsonl(s.id, s.ts);
      await store.ingestFile(tmpFile);
    }

    const app = buildSessionsApp(store);

    // limit=2: should get the two most recent sessions, newest first.
    const res = await app.request(`/api/sessions/active?windowMs=${FIVE_MIN_MS}&limit=2`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];

    expect(body).toHaveLength(2);
    expect(body[0]?.sessionId).toBe('sess-active-sort-new');
    expect(body[1]?.sessionId).toBe('sess-active-sort-mid');
    // The oldest session is cut off by limit=2.
    const oldEntry = body.find((s) => s.sessionId === 'sess-active-sort-old');
    expect(oldEntry).toBeUndefined();
  });

  it('returns [] when no sessions are active', async () => {
    const store = new IndexStore();
    // No sessions ingested at all.
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=1000');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];
    expect(body).toEqual([]);
  });

  it('returns [] when sessions exist but all fall outside windowMs', async () => {
    const store = new IndexStore();
    const sessionId = 'sess-active-all-old';

    const tmpFile = await writeTempAssistantJsonl(sessionId, '2026-04-15T10:00:00.000Z');
    await store.ingestFile(tmpFile);

    const app = buildSessionsApp(store);
    // windowMs=1 → cutoff is ~now, all historical fixtures are excluded.
    const res = await app.request('/api/sessions/active?windowMs=1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];
    expect(body).toEqual([]);
  });

  // --- Parameter validation ---

  it('validates windowMs: rejects negative value', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=-1');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('validates windowMs: rejects zero', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=0');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates windowMs: rejects value exceeding 24 h (86_400_001)', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=86400001');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates windowMs: accepts boundary value of 86_400_000 (exactly 24 h)', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=86400000');

    expect(res.status).toBe(200);
  });

  it('validates windowMs: rejects non-integer (float string)', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=300000.5');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates windowMs: rejects non-numeric string', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?windowMs=abc');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates limit: rejects value greater than 100', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=101');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('validates limit: rejects zero', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=0');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates limit: rejects negative value', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=-5');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates limit: rejects non-integer (float string)', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=5.5');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates limit: rejects non-numeric string', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=ten');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('validates limit: accepts boundary value of 100', async () => {
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active?limit=100');

    expect(res.status).toBe(200);
  });

  it('returns default results with no query params', async () => {
    // Smoke test: no params → uses defaults (windowMs=300_000, limit=10).
    // With no sessions in store, result is [] and status is 200.
    const store = new IndexStore();
    const app = buildSessionsApp(store);
    const res = await app.request('/api/sessions/active');

    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionSummary[];
    expect(Array.isArray(body)).toBe(true);
  });
});
