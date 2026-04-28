/**
 * Tests for the GET /api/turns route handler.
 *
 * Tests exercise the real route handler from apps/server/src/routes/turns.ts
 * via Hono's test client pattern (`app.request(url)`).
 *
 * The store is populated by injecting TokenRow objects directly into store.rows
 * (the same pattern used in index-store.test.ts) so tests do not depend on
 * filesystem fixtures.
 *
 * Contract under test (GET /api/turns):
 *   - Query params: since (optional), project (optional), limit (default 10, max 50)
 *   - Response: TurnBucket[] sorted by costUsd descending
 *   - TurnBucket fields: timestamp, sessionId, project, modelId, modelFamily,
 *     inputTokens, outputTokens, cacheReadTokens, costUsd, durationMs (number|null)
 *
 * Test cases:
 *   1. Empty store → returns []
 *   2. Store with 5 turns → returns 5 sorted by costUsd desc
 *   3. Store with 20 turns → default limit returns 10
 *   4. ?limit=3 → returns 3
 *   5. ?since=7d → filters out rows older than 7 days
 *   6. ?project=foo → filters by project substring
 *   7. Each TurnBucket has all required fields with correct types
 *   8. durationMs is a number when turnDurationMs is set, null when not set
 *   9. ?limit capped at 50 even when parameter exceeds 50
 */

import type { TokenRow, TurnBucket } from '@tokenomix/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store.js';
import { turnsRoute } from '../routes/turns.js';

// ---------------------------------------------------------------------------
// App factory — uses the REAL route (no inline reimplementation)
// ---------------------------------------------------------------------------

function buildTurnsApp(store: IndexStore): Hono {
  const app = new Hono();
  app.route('/api/turns', turnsRoute(store));
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

/** Fetch GET /api/turns with optional query string and parse JSON response. */
async function fetchTurns(
  app: Hono,
  query: Record<string, string | number> = {}
): Promise<TurnBucket[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    params.set(k, String(v));
  }
  const qs = params.toString();
  const url = `/api/turns${qs ? `?${qs}` : ''}`;
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return res.json() as Promise<TurnBucket[]>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/turns', () => {
  it('empty store returns []', async () => {
    const store = new IndexStore();
    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);
    expect(turns).toEqual([]);
  });

  it('5 turns are returned and sorted by costUsd descending', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    const costs = [0.005, 0.001, 0.01, 0.003, 0.007];
    costs.forEach((costUsd, i) => {
      rows.set(`req_${i}:msg_${i}`, makeRow({ costUsd, sessionId: `sess-${i}` }));
    });

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);

    expect(turns).toHaveLength(5);
    // Verify descending order.
    for (let i = 0; i < turns.length - 1; i++) {
      expect((turns[i] as TurnBucket).costUsd).toBeGreaterThanOrEqual(
        (turns[i + 1] as TurnBucket).costUsd
      );
    }
    expect((turns[0] as TurnBucket).costUsd).toBe(0.01);
    expect((turns[turns.length - 1] as TurnBucket).costUsd).toBe(0.001);
  });

  it('store with 20 turns — default limit returns 10', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    for (let i = 0; i < 20; i++) {
      rows.set(
        `req_20_${i}:msg_20_${i}`,
        makeRow({ costUsd: (i + 1) * 0.001, sessionId: `sess-20-${i}` })
      );
    }

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);

    expect(turns).toHaveLength(10);
    // The 10 most expensive turns (indices 10-19 → costs $0.011–$0.020).
    expect((turns[0] as TurnBucket).costUsd).toBe(0.02);
    expect((turns[9] as TurnBucket).costUsd).toBe(0.011);
  });

  it('?limit=3 returns exactly 3 turns', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    for (let i = 0; i < 10; i++) {
      rows.set(
        `req_lim_${i}:msg_lim_${i}`,
        makeRow({ costUsd: (i + 1) * 0.001, sessionId: `sess-lim-${i}` })
      );
    }

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app, { limit: 3 });

    expect(turns).toHaveLength(3);
    // Should be the 3 most expensive.
    expect((turns[0] as TurnBucket).costUsd).toBe(0.01);
    expect((turns[2] as TurnBucket).costUsd).toBe(0.008);
  });

  it('?since=7d filters out rows older than 7 days', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Recent row (today).
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Old row (15 days ago — outside 7d window).
    const oldDate = new Date(today.getTime() - 15 * 24 * 3600 * 1000);
    const oldStr = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}-${String(oldDate.getDate()).padStart(2, '0')}`;

    rows.set(
      'req_recent:msg_recent',
      makeRow({ date: todayStr, costUsd: 0.01, sessionId: 'sess-recent' })
    );
    rows.set('req_old:msg_old', makeRow({ date: oldStr, costUsd: 0.02, sessionId: 'sess-old' }));

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app, { since: '7d' });

    expect(turns).toHaveLength(1);
    expect((turns[0] as TurnBucket).sessionId).toBe('sess-recent');
  });

  it('?project=foo filters by project substring', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_foo:msg_foo',
      makeRow({ project: '/projects/foo-app', costUsd: 0.01, sessionId: 'sess-foo' })
    );
    rows.set(
      'req_bar:msg_bar',
      makeRow({ project: '/projects/bar-app', costUsd: 0.02, sessionId: 'sess-bar' })
    );
    rows.set(
      'req_foobar:msg_foobar',
      makeRow({ project: '/projects/foobar', costUsd: 0.03, sessionId: 'sess-foobar' })
    );

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app, { project: 'foo' });

    // 'foo' matches '/projects/foo-app' and '/projects/foobar', not 'bar-app'.
    expect(turns).toHaveLength(2);
    const projects = turns.map((t) => t.project);
    expect(projects).toContain('/projects/foo-app');
    expect(projects).toContain('/projects/foobar');
    expect(projects).not.toContain('/projects/bar-app');
  });

  it('each TurnBucket has all required fields with correct types', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_shape:msg_shape',
      makeRow({
        date: '2026-04-27',
        hour: 14,
        sessionId: 'sess-shape-001',
        project: '/projects/shape-test',
        modelId: 'claude-opus-4-7',
        modelFamily: 'opus',
        inputTokens: 500,
        outputTokens: 200,
        cacheReadTokens: 1000,
        costUsd: 0.0123,
        turnDurationMs: 3500,
      })
    );

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);

    expect(turns).toHaveLength(1);
    const turn = turns[0] as TurnBucket;

    // Required string fields.
    expect(typeof turn.timestamp).toBe('string');
    expect(turn.timestamp).toBe('2026-04-27T14:00:00');
    expect(typeof turn.sessionId).toBe('string');
    expect(turn.sessionId).toBe('sess-shape-001');
    expect(typeof turn.project).toBe('string');
    expect(turn.project).toBe('/projects/shape-test');
    expect(typeof turn.modelId).toBe('string');
    expect(turn.modelId).toBe('claude-opus-4-7');
    expect(typeof turn.modelFamily).toBe('string');
    expect(turn.modelFamily).toBe('opus');

    // Required number fields.
    expect(typeof turn.inputTokens).toBe('number');
    expect(turn.inputTokens).toBe(500);
    expect(typeof turn.outputTokens).toBe('number');
    expect(turn.outputTokens).toBe(200);
    expect(typeof turn.cacheReadTokens).toBe('number');
    expect(turn.cacheReadTokens).toBe(1000);
    expect(typeof turn.costUsd).toBe('number');
    expect(turn.costUsd).toBe(0.0123);

    // durationMs should be a number when turnDurationMs is set.
    expect(typeof turn.durationMs).toBe('number');
    expect(turn.durationMs).toBe(3500);
  });

  it('durationMs is null when turnDurationMs is not set on the row', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Row without turnDurationMs (undefined).
    rows.set('req_nodur:msg_nodur', makeRow({ costUsd: 0.005 }));

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);

    expect(turns).toHaveLength(1);
    const turn = turns[0] as TurnBucket;

    // durationMs must be null (not undefined, not a number) when no duration event.
    expect(turn.durationMs).toBeNull();
  });

  it('sessionId, project, modelId on returned TurnBucket match injected row values', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_match_1:msg_match_1',
      makeRow({
        sessionId: 'sess-aaa',
        project: '/proj/alpha',
        modelId: 'claude-sonnet-4-6',
        costUsd: 0.01,
      })
    );
    rows.set(
      'req_match_2:msg_match_2',
      makeRow({
        sessionId: 'sess-bbb',
        project: '/proj/beta',
        modelId: 'claude-haiku-4-5',
        costUsd: 0.005,
      })
    );

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app);

    expect(turns).toHaveLength(2);
    const top = turns[0] as TurnBucket;
    const second = turns[1] as TurnBucket;

    expect(top.sessionId).toBe('sess-aaa');
    expect(top.project).toBe('/proj/alpha');
    expect(top.modelId).toBe('claude-sonnet-4-6');
    expect(top.costUsd).toBe(0.01);

    expect(second.sessionId).toBe('sess-bbb');
    expect(second.project).toBe('/proj/beta');
    expect(second.modelId).toBe('claude-haiku-4-5');
    expect(second.costUsd).toBe(0.005);
  });

  it('?limit capped at 50 even when parameter exceeds 50', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    for (let i = 0; i < 120; i++) {
      rows.set(
        `req_cap_${i}:msg_cap_${i}`,
        makeRow({ costUsd: (i + 1) * 0.0001, sessionId: `sess-cap-${i}` })
      );
    }

    const app = buildTurnsApp(store);
    const turns = await fetchTurns(app, { limit: 200 });

    // Cap at 50 (production route enforces Math.min(limit, 50)).
    expect(turns).toHaveLength(50);
  });
});
