import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_SESSIONS_DIR, IndexStore } from '../index-store.js';

let fixtureDir: string;
const fixtureRoot = join(CODEX_SESSIONS_DIR, 'tokenomix-test');

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function tokenCountLine(
  timestamp: string,
  last: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  },
  total: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  }
): string {
  return line({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: last,
        total_token_usage: total,
        model_context_window: 258400,
      },
    },
  });
}

beforeEach(async () => {
  fixtureDir = join(fixtureRoot, `${process.pid}-${Date.now()}`);
  await mkdir(fixtureDir, { recursive: true });
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('Codex session ingest', () => {
  it('indexes Codex token_count rows with OpenAI pricing when the model is recognized', async () => {
    const filePath = join(fixtureDir, 'rollout-test.jsonl');
    const rawSessionId = '019def00-codex-test';

    await writeFile(
      filePath,
      [
        line({
          timestamp: '2026-05-03T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: rawSessionId, cwd: '/tmp/codex-project', model_provider: 'openai' },
        }),
        line({
          timestamp: '2026-05-03T12:00:00.010Z',
          type: 'turn_context',
          payload: { cwd: '/tmp/codex-project', model: 'gpt-5.5' },
        }),
        line({
          timestamp: '2026-05-03T12:00:00.020Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Summarize the repo' },
        }),
        line({
          timestamp: '2026-05-03T12:00:02.000Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1' },
        }),
        line({
          timestamp: '2026-05-03T12:00:02.500Z',
          type: 'response_item',
          payload: {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'Codex pricing' },
          },
        }),
        tokenCountLine(
          '2026-05-03T12:00:03.000Z',
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          },
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          }
        ),
        tokenCountLine(
          '2026-05-03T12:00:04.000Z',
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          },
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          }
        ),
        line({
          timestamp: '2026-05-03T12:00:05.000Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'apply_patch', call_id: 'call-2' },
        }),
        tokenCountLine(
          '2026-05-03T12:00:06.000Z',
          {
            input_tokens: 500,
            cached_input_tokens: 100,
            output_tokens: 25,
            reasoning_output_tokens: 5,
            total_tokens: 525,
          },
          {
            input_tokens: 1500,
            cached_input_tokens: 300,
            output_tokens: 75,
            reasoning_output_tokens: 15,
            total_tokens: 1575,
          }
        ),
      ].join('\n'),
      'utf-8'
    );

    const store = new IndexStore();
    await store.ingestFile(filePath);

    const codexMetrics = store.getMetrics({ provider: 'codex' });
    expect(codexMetrics.totalSessions).toBe(1);
    expect(codexMetrics.totalInputTokens).toBe(1200);
    expect(codexMetrics.totalOutputTokens).toBe(75);
    expect(codexMetrics.totalCacheReadTokens).toBe(300);
    expect(codexMetrics.totalCostUsd).toBe(0.0084);
    expect(codexMetrics.byModel[0]?.modelFamily).toBe('gpt');
    expect(codexMetrics.byTool.map((tool) => tool.toolName).sort()).toEqual([
      'apply_patch',
      'exec_command',
      'web_search',
    ]);
    expect(codexMetrics.pricingAudit.provider).toBe('openai_api');
    expect(codexMetrics.pricingAudit.catalog.pricingProvider).toBe('openai_api');
    expect(codexMetrics.pricingAudit.warnings.join('\n')).toContain(
      'static OpenAI API pricing and Codex rate card'
    );
    expect(codexMetrics.pricingAudit.warnings.join('\n')).toContain('Fast mode multipliers');
    expect(codexMetrics.pricingAudit.warnings.join('\n')).toContain(
      'web search call(s) are counted as tool usage but not separately priced'
    );

    const sessions = store.getSessions({ provider: 'codex' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(`codex:${rawSessionId}`);
    expect(sessions[0]?.sourceProvider).toBe('codex');
    expect(store.getSessionDetail(`codex:${rawSessionId}`)?.webSearchRequests).toBe(1);

    const claudeMetrics = store.getMetrics({ provider: 'claude-code' });
    expect(claudeMetrics.totalSessions).toBe(0);
  });

  it('leaves Codex research-preview models unpriced', async () => {
    const filePath = join(fixtureDir, 'spark-rollout-test.jsonl');

    await writeFile(
      filePath,
      [
        line({
          timestamp: '2026-05-03T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: '019def00-spark-test', cwd: '/tmp/codex-project' },
        }),
        line({
          timestamp: '2026-05-03T12:00:00.010Z',
          type: 'turn_context',
          payload: { cwd: '/tmp/codex-project', model: 'gpt-5.3-codex-spark' },
        }),
        tokenCountLine(
          '2026-05-03T12:00:03.000Z',
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          },
          {
            input_tokens: 1000,
            cached_input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
            total_tokens: 1050,
          }
        ),
      ].join('\n'),
      'utf-8'
    );

    const store = new IndexStore();
    await store.ingestFile(filePath);

    const codexMetrics = store.getMetrics({ provider: 'codex' });
    expect(codexMetrics.totalCostUsd).toBe(0);
    expect(codexMetrics.pricingAudit.warnings.join('\n')).toContain('no supported static price');
  });
});
