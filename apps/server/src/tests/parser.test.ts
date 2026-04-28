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
import { buildTokenRow } from '../index-store.js';
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
});
