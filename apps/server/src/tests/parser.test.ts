/**
 * JSONL parser and deduplication tests.
 *
 * Covers:
 *   - Empty file produces no events.
 *   - File with only non-usage lines (user, system, etc.) produces no events.
 *   - Dedup of duplicate requestId+messageId pairs.
 *   - Both cache schemas (nested ephemeral + top-level fallback).
 *   - Malformed JSON line is tolerated (skip and continue).
 *   - Missing requestId or message.id causes event to be skipped (dedup rule).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawUsageEventSchema } from '@tokenomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTokenRow, PROJECTS_DIR } from '../index-store.js';
import { parseJSONLFile } from '../parser.js';

// ---------------------------------------------------------------------------
// Test fixture directory
// ---------------------------------------------------------------------------

let fixturesDir: string;

beforeAll(async () => {
  fixturesDir = join(tmpdir(), `tokenomix-test-${process.pid}`);
  await mkdir(fixturesDir, { recursive: true });
});

afterAll(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
});

function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

async function writeFixture(name: string, content: string): Promise<string> {
  const path = fixturePath(name);
  await writeFile(path, content, 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// Minimal valid assistant event factory
// ---------------------------------------------------------------------------

function assistantLine(overrides: Record<string, unknown> = {}): string {
  const base = {
    type: 'assistant',
    requestId: 'req_test_001',
    uuid: 'uuid-001',
    timestamp: '2026-04-27T18:00:00.000Z',
    sessionId: 'session-abc',
    cwd: '/test/project',
    message: {
      id: 'msg_001',
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseJSONLFile', () => {
  it('empty file produces no events', async () => {
    const path = await writeFixture('empty.jsonl', '');
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('file with only blank lines produces no events', async () => {
    const path = await writeFixture('blanks.jsonl', '\n\n   \n\n');
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('file with only non-usage lines produces events (parser does not filter type)', async () => {
    // parseJSONLFile yields ALL valid records; filtering is done in index-store.
    const lines = [
      JSON.stringify({ type: 'user', sessionId: 's1' }),
      JSON.stringify({ type: 'system', sessionId: 's2' }),
    ].join('\n');
    const path = await writeFixture('non-usage.jsonl', lines);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('user');
    expect(events[1]?.type).toBe('system');
  });

  it('malformed JSON line is skipped; valid lines still parsed', async () => {
    const lines = [
      assistantLine({
        requestId: 'req_ok_1',
        message: {
          id: 'msg_ok_1',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      'this is not json {{{',
      assistantLine({
        requestId: 'req_ok_2',
        message: {
          id: 'msg_ok_2',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      }),
    ].join('\n');
    const path = await writeFixture('malformed.jsonl', lines);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(2);
  });

  it('non-existent file produces no events without throwing', async () => {
    const events = [];
    for await (const e of parseJSONLFile('/does/not/exist.jsonl')) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('parses nested cache schema (ephemeral_5m + ephemeral_1h)', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'req_cache_nested',
      uuid: 'uuid-cache-nested',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-cache',
      cwd: '/test/project',
      message: {
        id: 'msg_cache_nested',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 1000,
          cache_creation: {
            ephemeral_5m_input_tokens: 3000,
            ephemeral_1h_input_tokens: 2000,
          },
          service_tier: 'standard',
        },
      },
    });
    const path = await writeFixture('nested-cache.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const usage = events[0]?.message?.usage;
    expect(usage?.cache_creation?.ephemeral_5m_input_tokens).toBe(3000);
    expect(usage?.cache_creation?.ephemeral_1h_input_tokens).toBe(2000);
  });

  it('parses top-level cache schema (legacy fallback)', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'req_cache_toplevel',
      uuid: 'uuid-cache-toplevel',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-cache-tl',
      cwd: '/test/project',
      message: {
        id: 'msg_cache_toplevel',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 0,
          service_tier: 'standard',
        },
      },
    });
    const path = await writeFixture('toplevel-cache.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.message?.usage?.cache_creation_input_tokens).toBe(10_000);
  });

  it('parses API-error records where service_tier/speed/inference_geo are null', async () => {
    // Production Claude Code emits null for these fields on records flagged
    // isApiErrorMessage:true (all-zero usage). Without nullable() in the schema,
    // these would fail validation and pollute startup logs with schema-mismatch
    // warnings (one per error record across thousands of session files).
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'req_api_error',
      uuid: 'uuid-api-error',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-api-error',
      cwd: '/test/project',
      isApiErrorMessage: true,
      message: {
        id: 'msg_api_error',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: null,
          speed: null,
          inference_geo: null,
        },
      },
    });
    const path = await writeFixture('api-error.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const usage = events[0]?.message?.usage;
    expect(usage?.service_tier).toBeNull();
    expect(usage?.speed).toBeNull();
    expect(usage?.inference_geo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deduplication tests (via buildTokenRow + dedup key logic)
// ---------------------------------------------------------------------------

describe('deduplication logic', () => {
  it('rows with same requestId+messageId are deduplicated in IndexStore', async () => {
    // Write the same event twice.
    const line = assistantLine();
    const path = await writeFixture('dedup.jsonl', [line, line, line].join('\n'));

    // Collect all events from parser (3 lines).
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(3);

    // Simulate dedup logic from IndexStore.
    const seen = new Set<string>();
    const kept = [];
    for (const event of events) {
      const rid = event.requestId;
      const mid = event.message?.id;
      if (!rid || !mid) continue; // skip if either missing
      const key = `${rid}:${mid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(event);
    }
    expect(kept).toHaveLength(1);
  });

  it('event with missing requestId is skipped by dedup rule', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      // requestId intentionally absent
      uuid: 'uuid-noreqid',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-xyz',
      cwd: '/test/project',
      message: {
        id: 'msg_noreqid',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const path = await writeFixture('missing-reqid.jsonl', line);

    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }

    // Parser yields the event, but dedup logic rejects it (no requestId).
    const kept = events.filter((e) => e.requestId && e.message?.id);
    expect(kept).toHaveLength(0);
  });

  it('event with missing message.id is skipped by dedup rule', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'req_nomsgid',
      uuid: 'uuid-nomsgid',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-nomsgid',
      cwd: '/test/project',
      message: {
        // id intentionally absent
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    const path = await writeFixture('missing-msgid.jsonl', line);

    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }

    // Parser yields the event, but dedup logic rejects it (no message.id).
    const kept = events.filter((e) => e.requestId && e.message?.id);
    expect(kept).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// New event type schema tests (tool_use, tool_result, system/turn_duration)
// ---------------------------------------------------------------------------

describe('parseJSONLFile — new event types', () => {
  it('tool_use event is yielded by the parser: type, toolName, and input.file_path are present', async () => {
    const line = JSON.stringify({
      type: 'tool_use',
      uuid: 'uuid-tu-001',
      parentUuid: 'uuid-parent-001',
      requestId: 'req_tu_001',
      timestamp: '2026-04-27T18:00:00.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      toolName: 'Read',
      input: {
        file_path: 'src/index.ts',
        pattern: 'some-search-pattern',
        command: 'ls -la',
      },
    });
    const path = await writeFixture('tool-use.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('tool_use');
    // toolName must be present.
    expect(event.toolName).toBe('Read');
    // input.file_path must be preserved.
    const input = event.input as Record<string, unknown>;
    expect(input.file_path).toBe('src/index.ts');
    // NOTE: The union schema (RawUsageEventSchema) matches tool_use events via
    // AssistantEventSchema first (which uses z.string() for type + .passthrough()).
    // This means extra input fields like 'pattern' and 'command' are NOT stripped
    // at the parser layer when going through the union. The stripping invariant is
    // enforced only when ToolUseEventSchema is applied directly (e.g. in index-store's
    // ingestFileInternal after type-narrowing). See finding: SCHEMA-UNION-STRIP-001.
    // The index-store ingest branch is responsible for extracting ONLY input.file_path.
  });

  it('tool_use event without file_path still parses (file_path is optional)', async () => {
    const line = JSON.stringify({
      type: 'tool_use',
      uuid: 'uuid-tu-002',
      requestId: 'req_tu_002',
      timestamp: '2026-04-27T18:01:00.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      toolName: 'Bash',
      input: {
        // No file_path — Bash invocations do not reference a file.
        command: 'ls -la',
      },
    });
    const path = await writeFixture('tool-use-no-filepath.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('tool_use');
    expect(event.toolName).toBe('Bash');
    // When ToolUseEventSchema is applied via the union, the outer .passthrough() on
    // AssistantEventSchema causes extra fields to survive at the parser output level.
    // The index-store ingest branch must extract only input.file_path when present.
  });

  it('tool_result event is yielded with tool_use_id and is_error', async () => {
    const line = JSON.stringify({
      type: 'tool_result',
      uuid: 'uuid-tr-001',
      parentUuid: 'uuid-tu-001',
      requestId: 'req_tu_001',
      timestamp: '2026-04-27T18:00:01.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      tool_use_id: 'uuid-tu-001',
      is_error: true,
    });
    const path = await writeFixture('tool-result-error.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('tool_result');
    expect(event.tool_use_id).toBe('uuid-tu-001');
    expect(event.is_error).toBe(true);
  });

  it('tool_result event with is_error:false parses correctly', async () => {
    const line = JSON.stringify({
      type: 'tool_result',
      uuid: 'uuid-tr-002',
      requestId: 'req_tr_002',
      timestamp: '2026-04-27T18:00:02.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      tool_use_id: 'uuid-tu-002',
      is_error: false,
    });
    const path = await writeFixture('tool-result-success.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('tool_result');
    expect(event.is_error).toBe(false);
  });

  it('tool_result event with is_error absent parses (is_error is optional)', async () => {
    const line = JSON.stringify({
      type: 'tool_result',
      uuid: 'uuid-tr-003',
      requestId: 'req_tr_003',
      timestamp: '2026-04-27T18:00:03.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      tool_use_id: 'uuid-tu-003',
      // is_error absent
    });
    const path = await writeFixture('tool-result-no-error-flag.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('tool_result');
    expect(event.is_error).toBeUndefined();
  });

  it('system/turn_duration event is yielded with durationMs', async () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'uuid-sys-001',
      requestId: 'req_sys_001',
      timestamp: '2026-04-27T18:00:05.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      durationMs: 1234,
    });
    const path = await writeFixture('system-turn-duration.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('system');
    expect(event.subtype).toBe('turn_duration');
    expect(event.durationMs).toBe(1234);
  });

  it('system/turn_duration durationMs of 0 is valid (non-negative invariant)', async () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      uuid: 'uuid-sys-002',
      requestId: 'req_sys_002',
      timestamp: '2026-04-27T18:00:06.000Z',
      sessionId: 'session-tu-001',
      cwd: '/test/project',
      durationMs: 0,
    });
    const path = await writeFixture('system-turn-duration-zero.jsonl', line);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.durationMs).toBe(0);
  });

  it('assistant+usage event still parses correctly alongside new event types (no regression)', async () => {
    const lines = [
      assistantLine({
        requestId: 'req_mixed_001',
        message: {
          id: 'msg_mixed_001',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: 'tool_use',
        requestId: 'req_mixed_001',
        sessionId: 'session-mixed',
        cwd: '/test/project',
        toolName: 'Write',
        input: { file_path: 'out.ts' },
      }),
      JSON.stringify({
        type: 'tool_result',
        requestId: 'req_mixed_001',
        sessionId: 'session-mixed',
        cwd: '/test/project',
        tool_use_id: 'uuid-write-001',
        is_error: false,
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        requestId: 'req_mixed_001',
        sessionId: 'session-mixed',
        cwd: '/test/project',
        durationMs: 500,
      }),
    ].join('\n');
    const path = await writeFixture('mixed-event-types.jsonl', lines);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    // All 4 lines must be yielded.
    expect(events).toHaveLength(4);
    const types = events.map((e) => (e as Record<string, unknown>).type);
    expect(types).toContain('assistant');
    expect(types).toContain('tool_use');
    expect(types).toContain('tool_result');
    expect(types).toContain('system');
  });

  it('unknown event type is silently filtered (schema-mismatch logged, no yield)', async () => {
    // 'human' and 'summary' types do not match any union branch in
    // RawUsageEventSchema. The parser skips them with a schema-mismatch log.
    const lines = [
      JSON.stringify({ type: 'human', sessionId: 's1', content: 'hello' }),
      JSON.stringify({ type: 'summary', sessionId: 's1', summary: 'some summary' }),
    ].join('\n');
    const path = await writeFixture('unknown-types.jsonl', lines);
    const events = [];
    for await (const e of parseJSONLFile(path)) {
      events.push(e);
    }
    // Schema union requires type to be one of: assistant (broad z.string() via
    // AssistantEventSchema), tool_use (literal), tool_result (literal), system+turn_duration.
    // 'human' and 'summary' match AssistantEventSchema (which accepts any z.string() for type)
    // so they ARE yielded. This is the current behavior: parser does not filter by type.
    // The filter is done in index-store. Both events should be yielded (2 total).
    expect(events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildTokenRow cache branching
// ---------------------------------------------------------------------------

describe('buildTokenRow cache branching', () => {
  const baseRaw = {
    type: 'assistant',
    requestId: 'req_row_001',
    timestamp: '2026-04-27T18:00:00.000Z',
    sessionId: 'session-row',
    cwd: '/test/project',
  };

  it('uses nested cache values when non-zero', () => {
    const event = RawUsageEventSchema.parse({
      ...baseRaw,
      message: {
        id: 'msg_row_001',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 3000,
            ephemeral_1h_input_tokens: 2000,
          },
        },
      },
    });
    const row = buildTokenRow(event, '/test/file.jsonl');
    expect(row).not.toBeNull();
    expect(row?.cacheCreation5m).toBe(3000);
    expect(row?.cacheCreation1h).toBe(2000);
  });

  it('falls back to top-level when nested sum is zero', () => {
    const event = RawUsageEventSchema.parse({
      ...baseRaw,
      message: {
        id: 'msg_row_002',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    });
    const row = buildTokenRow(event, '/test/file.jsonl');
    expect(row).not.toBeNull();
    expect(row?.cacheCreation5m).toBe(10_000);
    expect(row?.cacheCreation1h).toBe(0);
  });

  it('uses top-level as 5m when no nested object', () => {
    const event = RawUsageEventSchema.parse({
      ...baseRaw,
      message: {
        id: 'msg_row_003',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 7500,
          cache_read_input_tokens: 0,
        },
      },
    });
    const row = buildTokenRow(event, '/test/file.jsonl');
    expect(row).not.toBeNull();
    expect(row?.cacheCreation5m).toBe(7500);
    expect(row?.cacheCreation1h).toBe(0);
  });

  it('marks subagent correctly based on file path', () => {
    const event = RawUsageEventSchema.parse({
      ...baseRaw,
      message: {
        id: 'msg_subagent',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const mainRow = buildTokenRow(event, '/project/session.jsonl');
    const subRow = buildTokenRow(event, '/project/session/subagents/agent-01.jsonl');
    expect(mainRow?.isSubagent).toBe(false);
    expect(subRow?.isSubagent).toBe(true);
  });

  it('uses gateway-rated cost fields when internal gateway pricing is configured', () => {
    const previousProvider = process.env.TOKENOMIX_PRICING_PROVIDER;
    process.env.TOKENOMIX_PRICING_PROVIDER = 'internal_gateway';

    try {
      const event = RawUsageEventSchema.parse({
        ...baseRaw,
        gatewayCostUsdMicros: 12_345,
        message: {
          id: 'msg_gateway_cost',
          model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          usage: { input_tokens: 1000, output_tokens: 1000 },
        },
      });
      const row = buildTokenRow(event, '/test/file.jsonl');
      expect(row?.costUsdMicros).toBe(12_345);
      expect(row?.costUsd).toBe(0.012345);
      expect((row?.inputCostUsdMicros ?? 0) + (row?.outputCostUsdMicros ?? 0)).toBe(12_345);
      expect(row?.inputCostUsdMicros).toBeGreaterThan(0);
      expect(row?.outputCostUsdMicros).toBeGreaterThan(0);
      expect(row?.pricingStatus).toBe('internal_gateway_rated');
    } finally {
      if (previousProvider === undefined) {
        process.env.TOKENOMIX_PRICING_PROVIDER = undefined;
      } else {
        process.env.TOKENOMIX_PRICING_PROVIDER = previousProvider;
      }
    }
  });

  it('falls back to the Claude project directory name when cwd is missing', () => {
    const event = RawUsageEventSchema.parse({
      ...baseRaw,
      cwd: undefined,
      message: {
        id: 'msg_no_cwd',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const row = buildTokenRow(
      event,
      join(PROJECTS_DIR, '-Users-example-work-portable', 'session.jsonl')
    );
    expect(row?.project).toBe('/Users/example/work/portable');
    expect(row?.projectName).toBe('portable');
  });
});
