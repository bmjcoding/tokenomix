import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexStore, LOCAL_MODELS_DIR } from '../index-store.js';

let fixtureDir: string;
const fixtureRoot = join(LOCAL_MODELS_DIR, 'tokenomix-test');

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

beforeEach(async () => {
  fixtureDir = join(fixtureRoot, `${process.pid}-${Date.now()}`);
  await mkdir(fixtureDir, { recursive: true });
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('Local model ingest', () => {
  it('indexes Ollama and LM Studio telemetry as local-model counterfactual usage', async () => {
    const filePath = join(fixtureDir, 'local-usage.jsonl');

    await writeFile(
      filePath,
      [
        line({
          model: 'qwen3:8b',
          created_at: '2026-05-03T13:00:00.000Z',
          done: true,
          total_duration: 5_000_000_000,
          load_duration: 1_000_000_000,
          prompt_eval_count: 1000,
          prompt_eval_duration: 500_000_000,
          eval_count: 100,
          eval_duration: 2_000_000_000,
        }),
        line({
          timestamp: '2026-05-03T13:01:00.000Z',
          runtime: 'lm-studio',
          session_id: 'local-session-1',
          cwd: '/tmp/local-model-project',
          model: 'google/gemma-4-9b',
          output: [
            { type: 'tool_call', tool: 'search' },
            { type: 'invalid_tool_call', tool_name: 'browser' },
          ],
          stats: {
            input_tokens: 200,
            total_output_tokens: 80,
            reasoning_output_tokens: 12,
            tokens_per_second: 20,
            time_to_first_token_seconds: 0.75,
            model_load_time_seconds: 2.5,
          },
        }),
        line({
          type: 'step_finish',
          timestamp: 1_777_817_320_000,
          sessionID: 'opencode-local-1',
          model: 'ollama/qwen3-coder:30b',
          part: {
            type: 'step-finish',
            tokens: {
              input: 500,
              output: 50,
              reasoning: 10,
              cache: { read: 100 },
            },
          },
        }),
      ].join('\n'),
      'utf-8'
    );

    const store = new IndexStore();
    await store.ingestFile(filePath);

    const metrics = store.getMetrics({ provider: 'local-models' });
    expect(metrics.totalSessions).toBe(3);
    expect(metrics.totalInputTokens).toBe(1600);
    expect(metrics.totalOutputTokens).toBe(230);
    expect(metrics.totalCacheReadTokens).toBe(100);
    expect(metrics.totalCostUsd).toBe(0.00828);
    expect(metrics.localEquivalentClaudeCostUsd).toBe(0.00828);
    expect(metrics.localEquivalentCodexCostUsd).toBeCloseTo(0.01495, 8);
    expect(metrics.pricingAudit.provider).toBe('local_equivalent');
    expect(metrics.pricingAudit.catalog.costBasis).toBe(
      'counterfactual_local_model_usage_static_public_catalogs'
    );
    expect(metrics.pricingAudit.warnings.join('\n')).toContain('counterfactual Claude Sonnet');
    expect(metrics.byModel.map((bucket) => bucket.modelFamily).sort()).toEqual(['gemma', 'qwen']);
    expect(metrics.byTool.map((tool) => tool.toolName).sort()).toEqual(['browser', 'search']);

    const sessions = store.getSessions({ provider: 'local-models' });
    expect(sessions.every((session) => session.sourceProvider === 'local-models')).toBe(true);

    const detail = store.getSessionDetail('local:local-session-1');
    expect(detail?.sourceProvider).toBe('local-models');
    expect(detail?.turns[0]?.localRuntime).toBe('lm-studio');
    expect(detail?.turns[0]?.tokensPerSecond).toBe(20);
    expect(detail?.turns[0]?.timeToFirstTokenMs).toBe(750);
    expect(detail?.turns[0]?.loadDurationMs).toBe(2500);
    expect(detail?.turns[0]?.equivalentCodexCostUsd).toBe(0.0034);

    const turns = store.getTurns({ provider: 'local-models' }, 10);
    const ollamaTurn = turns.find((turn) => turn.localRuntime === 'ollama');
    expect(ollamaTurn?.durationMs).toBe(5000);
    expect(ollamaTurn?.promptEvalDurationMs).toBe(500);
    expect(ollamaTurn?.evalDurationMs).toBe(2000);
    expect(ollamaTurn?.loadDurationMs).toBe(1000);
    expect(ollamaTurn?.tokensPerSecond).toBe(50);

    const opencodeTurn = turns.find((turn) => turn.localRuntime === 'opencode');
    expect(opencodeTurn?.sessionId).toBe('local:opencode-local-1');
    expect(opencodeTurn?.inputTokens).toBe(400);
    expect(opencodeTurn?.cacheReadTokens).toBe(100);
  });

  it('accepts OpenAI-compatible local usage with numeric created timestamps and cached token details', async () => {
    const filePath = join(fixtureDir, 'openai-compatible.jsonl');

    await writeFile(
      filePath,
      [
        line({
          id: 'chatcmpl-local-1',
          created: 1_777_817_200,
          model: 'llama.cpp/qwen3-14b',
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 250 },
            completion_tokens_details: { reasoning_tokens: 20 },
          },
        }),
        line({
          id: 'chatcmpl-local-2',
          created: 1_777_817_200,
          model: 'llama.cpp/qwen3-14b',
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 250 },
          },
        }),
      ].join('\n'),
      'utf-8'
    );

    const store = new IndexStore();
    await store.ingestFile(filePath);
    await store.ingestFile(filePath);

    const metrics = store.getMetrics({ provider: 'local-models' });
    expect(metrics.totalSessions).toBe(1);
    expect(metrics.totalInputTokens).toBe(1500);
    expect(metrics.totalOutputTokens).toBe(200);
    expect(metrics.totalCacheReadTokens).toBe(500);
    expect(metrics.totalCostUsd).toBe(0.00765);

    const turns = store.getTurns({ provider: 'local-models' }, 10);
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.timestamp.startsWith('2026-05-03'))).toBe(true);
  });
});
