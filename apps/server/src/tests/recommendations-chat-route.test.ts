/**
 * Tests for the local Claude Code recommendations chat route.
 */

import * as os from 'node:os';
import type { RecommendationChatStatus, TokenRow } from '@tokenomix/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initServerEnv, validateEnv } from '../env.js';
import { IndexStore } from '../index-store.js';
import type { ClaudeRecommendationRunner } from '../routes/recommendations-chat.js';
import {
  LocalClaudeRecommendationRunner,
  parseClaudeOutput,
  parseClaudeStreamLine,
  recommendationsChatRoute,
} from '../routes/recommendations-chat.js';

// ---------------------------------------------------------------------------
// Module-level mock for node:child_process — hoisted by Vitest before imports.
// Existing route tests inject a mock ClaudeRecommendationRunner and never reach
// spawn(); the mock has no effect on them. The cwd test below exercises
// LocalClaudeRecommendationRunner directly and inspects the captured spawn args.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Import the mocked spawn AFTER vi.mock so we get the mock version.
const { spawn: mockSpawn } = await import('node:child_process');

function makeRow(overrides: Partial<TokenRow>): TokenRow {
  return {
    date: '2026-04-27',
    hour: 10,
    minute: 0,
    sessionId: 'session-default',
    project: '/Users/private/work/bank-app',
    projectName: 'bank-app',
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

function buildApp(store: IndexStore, runner: ClaudeRecommendationRunner): Hono {
  const app = new Hono();
  app.route('/api/recommendations/chat', recommendationsChatRoute(store, runner));
  return app;
}

function makeRunner(
  overrides: Partial<ClaudeRecommendationRunner> = {}
): ClaudeRecommendationRunner {
  return {
    status: async () => readyStatus,
    ask: async () => ({
      answer: 'unused',
      durationMs: null,
      costUsd: null,
      sessionId: null,
      warning: null,
    }),
    stream: async function* () {
      yield { type: 'delta', text: 'streamed' };
      yield {
        type: 'done',
        result: {
          answer: 'streamed',
          durationMs: 10,
          costUsd: 0.001,
          sessionId: 'stream-session',
          warning: null,
        },
      };
    },
    ...overrides,
  };
}

const readyStatus: RecommendationChatStatus = {
  available: true,
  configured: true,
  providerDetails: 'managed_by_claude_code',
  version: 'Claude Code test',
  message: 'ready',
};

describe('recommendationsChatRoute', () => {
  it('parses Claude Code JSON event-array output', () => {
    const parsed = parseClaudeOutput(
      JSON.stringify([
        { type: 'system', session_id: 'session-id' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'assistant fallback' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'parsed answer',
          duration_ms: 123,
          total_cost_usd: 0.004,
          session_id: 'session-id',
        },
      ])
    );

    expect(parsed.answer).toBe('parsed answer');
    expect(parsed.durationMs).toBe(123);
    expect(parsed.costUsd).toBe(0.004);
    expect(parsed.sessionId).toBe('session-id');
    expect(parsed.warning).toBeNull();
  });

  it('keeps the answer from a Claude Code budget-cap result', () => {
    const parsed = parseClaudeOutput(
      JSON.stringify([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial but useful answer' }] },
        },
        {
          type: 'result',
          subtype: 'error_max_budget_usd',
          is_error: true,
          duration_ms: 456,
          total_cost_usd: 0.051,
          session_id: 'budget-session',
          errors: ['Reached maximum budget ($0.05)'],
        },
      ])
    );

    expect(parsed.answer).toBe('partial but useful answer');
    expect(parsed.warning).toContain('budget cap');
    expect(parsed.costUsd).toBe(0.051);
  });

  it('parses Claude Code stream deltas and result metadata', () => {
    const delta = parseClaudeStreamLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      })
    );
    const done = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'hello world',
        duration_ms: 42,
        total_cost_usd: 0.003,
        session_id: 'stream-session',
      })
    );

    expect(delta).toEqual({ type: 'delta', text: 'hello' });
    expect(done).toEqual({
      type: 'done',
      result: {
        answer: 'hello world',
        durationMs: 42,
        costUsd: 0.003,
        sessionId: 'stream-session',
        warning: null,
      },
    });
  });

  it('reports Claude Code status without provider details', async () => {
    const store = new IndexStore();
    const app = buildApp(store, makeRunner());

    const res = await app.request('/api/recommendations/chat/status');
    const body = (await res.json()) as RecommendationChatStatus;

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.providerDetails).toBe('managed_by_claude_code');
    expect(JSON.stringify(body)).not.toContain('litellm');
    expect(JSON.stringify(body)).not.toContain('bedrock-runtime');
  });

  it('builds a path-redacted metrics prompt and returns runner output', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    rows.set(
      'cache-heavy:msg1',
      makeRow({
        costUsd: 300,
        inputCostUsd: 10,
        outputCostUsd: 20,
        // M4 tier-aware savings factor: set cacheCreation1h so the formula uses
        // the 1h tier weight (0.5) instead of the fallback 0.2.
        //   factor = (0 × 0.2 + 2000 × 0.5) / 2000 = 0.5
        //   cacheImpact = 40 × 0.5 + 230 × 0.05 = 20 + 11.5 = 31.5 ≥ 25 → fires
        cacheCreation5m: 0,
        cacheCreation1h: 2000,
        cacheCreationCostUsd: 40,
        cacheReadCostUsd: 230,
      })
    );

    let capturedPrompt = '';
    const app = buildApp(
      store,
      makeRunner({
        ask: async (prompt) => {
          capturedPrompt = prompt;
          return {
            answer: 'Start with context-cache-pressure.',
            durationMs: 1234,
            costUsd: 0.01,
            sessionId: 'session-id',
            warning: null,
          };
        },
      })
    );

    const res = await app.request('/api/recommendations/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What should I do first?' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.answer).toContain('context-cache-pressure');
    expect(body.groundedOpportunityIds).toContain('context-cache-pressure');
    expect(capturedPrompt).toContain('bank-app');
    expect(capturedPrompt).not.toContain('/Users/private');
    expect(capturedPrompt).toContain('Impact estimates are non-additive');
  });

  it('rejects invalid chat requests', async () => {
    const store = new IndexStore();
    const app = buildApp(store, makeRunner());

    const res = await app.request('/api/recommendations/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 502 when the local Claude Code runner fails', async () => {
    const store = new IndexStore();
    const app = buildApp(
      store,
      makeRunner({
        ask: async () => {
          throw new Error('boom');
        },
      })
    );

    const res = await app.request('/api/recommendations/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Explain this.' }),
    });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain('Claude Code request failed');
  });

  it('streams deltas and sends full context only on the first chat turn', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    rows.set(
      'cache-heavy:msg1',
      makeRow({
        costUsd: 300,
        inputCostUsd: 10,
        outputCostUsd: 20,
        cacheCreationCostUsd: 40,
        cacheReadCostUsd: 230,
      })
    );

    const prompts: string[] = [];
    const app = buildApp(
      store,
      makeRunner({
        stream: async function* (prompt) {
          prompts.push(prompt);
          yield { type: 'delta', text: 'hello ' };
          yield { type: 'delta', text: 'world' };
          yield {
            type: 'done',
            result: {
              answer: 'hello world',
              durationMs: 25,
              costUsd: 0.002,
              sessionId: 'stream-session',
              warning: null,
            },
          };
        },
      })
    );

    const first = await app.request('/api/recommendations/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What should I do first?' }),
    });
    const firstBody = await first.text();
    const second = await app.request('/api/recommendations/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Tell me more.' }),
    });
    const secondBody = await second.text();

    expect(first.status).toBe(200);
    expect(firstBody).toContain('"type":"delta"');
    expect(firstBody).toContain('"type":"done"');
    expect(second.status).toBe(200);
    expect(secondBody).toContain('"sessionSeeded":true');
    expect(prompts[0]).toContain('bank-app');
    expect(prompts[0]).toContain('context');
    expect(prompts[1]).toContain('already supplied earlier');
    expect(prompts[1]).toContain('Tell me more.');
    expect(prompts[1]).not.toContain('bank-app');
  });

  it('retrieves session detail on follow-up without reseeding the baseline context', async () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    rows.set(
      'target:req1',
      makeRow({
        sessionId: 'session-target-1234567',
        costUsd: 60,
        inputTokens: 10_000,
        outputTokens: 4_000,
        cacheReadTokens: 900_000,
        inputCostUsd: 1,
        outputCostUsd: 3,
        cacheCreationCostUsd: 2,
        cacheReadCostUsd: 54,
        toolUses: { Bash: 3, Read: 2 },
        toolErrors: { Bash: 1 },
        turnDurationMs: 45_000,
      })
    );
    rows.set(
      'target:req2',
      makeRow({
        sessionId: 'session-target-1234567',
        hour: 11,
        costUsd: 40,
        inputTokens: 8_000,
        outputTokens: 2_500,
        cacheReadTokens: 500_000,
        inputCostUsd: 1,
        outputCostUsd: 2,
        cacheCreationCostUsd: 1,
        cacheReadCostUsd: 36,
        toolUses: { Bash: 1 },
        turnDurationMs: 20_000,
      })
    );

    const prompts: string[] = [];
    const app = buildApp(
      store,
      makeRunner({
        stream: async function* (prompt) {
          prompts.push(prompt);
          yield { type: 'delta', text: 'ok' };
          yield {
            type: 'done',
            result: {
              answer: 'ok',
              durationMs: 20,
              costUsd: 0.001,
              sessionId: 'stream-session',
              warning: null,
            },
          };
        },
      })
    );

    const first = await app.request('/api/recommendations/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What should I do first?' }),
    });
    await first.text();
    const second = await app.request('/api/recommendations/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Why was session-target-1234567 so expensive?' }),
    });
    await second.text();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('targeted-followup-retrieval');
    expect(prompts[1]).toContain('session-target-1234567');
    expect(prompts[1]).toContain('"matchedSessions"');
    expect(prompts[1]).toContain('"cacheRead"');
    expect(prompts[1]).not.toContain('baseline-plus-targeted-retrieval');
  });
});

// ---------------------------------------------------------------------------
// H1 fix: chatbot subprocess cwd — verify spawn uses os.tmpdir(), not process.cwd()
//
// LocalClaudeRecommendationRunner.ask() calls runCommand() which calls spawn()
// with `cwd: CHAT_SUBPROCESS_CWD` (a path under os.tmpdir()). This prevents
// Claude Code from writing session JSONL files to the user's watched project
// directory, which would inflate reported costs.
// ---------------------------------------------------------------------------

describe('LocalClaudeRecommendationRunner — subprocess cwd isolation (H1)', () => {
  beforeEach(() => {
    // Initialize serverEnv so LocalClaudeRecommendationRunner constructor does not throw.
    const result = validateEnv({});
    if (!result.success) throw new Error('validateEnv failed in test setup');
    initServerEnv(result.env);

    // Reset spawn mock call count between tests.
    vi.mocked(mockSpawn).mockReset();
  });

  afterEach(() => {
    vi.mocked(mockSpawn).mockReset();
  });

  it('spawns with cwd inside os.tmpdir(), NOT process.cwd()', async () => {
    // Build a minimal ChildProcess stub that satisfies runCommand():
    //   - .stdout/.stderr EventEmitters for data listeners
    //   - .on('close', handler) so the Promise resolves
    //   - .kill() so the timeout handler doesn't throw
    //
    // The spawn mock uses mockImplementation so the 'close' event is emitted
    // AFTER spawn() returns the stub (i.e., after runCommand's listeners attach).
    const { EventEmitter } = await import('node:events');

    class ChildProcessStub extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      kill = vi.fn();
    }

    vi.mocked(mockSpawn).mockImplementation(() => {
      const stub = new ChildProcessStub();
      // Defer 'close' to the next microtask/macrotask so all .on() listeners
      // are attached before the event fires.
      setImmediate(() => stub.emit('close', 0));
      return stub as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const runner = new LocalClaudeRecommendationRunner({ timeoutMs: 5_000 });

    // ask() calls resolveClaudeCommand() → spawn(). TOKENOMIX_CLAUDE_COMMAND is
    // unset, so it resolves to 'claude' (plain basename fallback). The empty
    // stdout causes parseClaudeOutput to fail — catch that; spawn args are all we care about.
    await runner.ask('test prompt').catch(() => {
      // Expected: empty stdout → claude_exit_0 error. Ignored here.
    });

    // spawn must have been called exactly once.
    expect(vi.mocked(mockSpawn)).toHaveBeenCalledOnce();

    // Extract the spawn options (third argument).
    const spawnCall = vi.mocked(mockSpawn).mock.calls[0];
    const spawnOptions = spawnCall?.[2] as { cwd?: string } | undefined;

    // cwd must be set and must be inside os.tmpdir().
    const cwd = spawnOptions?.cwd;
    expect(cwd).toBeDefined();
    if (cwd === undefined) return; // narrow for TypeScript — expect above already guards

    expect(cwd.startsWith(os.tmpdir())).toBe(true);

    // cwd must NOT equal process.cwd() — the critical H1 invariant.
    expect(cwd).not.toBe(process.cwd());
  }, 10_000);
});
