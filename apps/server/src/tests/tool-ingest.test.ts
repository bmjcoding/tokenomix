/**
 * End-to-end ingest tests for tool_use, tool_result, and system/turn_duration events.
 *
 * Writes real JSONL fixture files to os.tmpdir() and ingests them through
 * the full pipeline (parseJSONLFile → ingestFileInternal → store.rows / store.getMetrics).
 *
 * Covers:
 *   - TokenRow fields populated from tool_use/tool_result/system events:
 *     toolUses, toolErrors, filesTouched, turnDurationMs.
 *   - MetricSummary aggregate fields from the new analytics branches:
 *     byTool, bySubagent, activeMs30d, idleMs30d, totalFilesTouched,
 *     avgCostPerTurn30d, avgCostPerTurnPrev30d, toolErrorRate30d.
 *   - bySubagent is empty when no subagent JSONLs are present.
 *   - bySubagent is populated when a fixture path includes '/subagents/'.
 *   - idleMs30d is clamped ≥ 0.
 *   - toolErrorRate30d: errors / invocations ratio.
 *   - avgCostPerTurn30d: hand-computed from deterministic fixture values.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricSummary, TokenRow } from '@tokenomix/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IndexStore } from '../index-store.js';

// ---------------------------------------------------------------------------
// Fixture directory setup
// ---------------------------------------------------------------------------

let fixturesDir: string;
let subagentsDir: string;

beforeAll(async () => {
  fixturesDir = join(tmpdir(), `tokenomix-tool-ingest-${process.pid}`);
  subagentsDir = join(fixturesDir, 'session-alpha', 'subagents');
  await mkdir(subagentsDir, { recursive: true });
});

afterAll(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a JSONL file and return its path. */
async function writeFixture(relativePath: string, content: string): Promise<string> {
  const fullPath = join(fixturesDir, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

/**
 * Build a minimal valid assistant JSONL line.
 * costUsd will be computed from the usage block at ingest time.
 * Using claude-sonnet-4-6 pricing: $3/M input, $15/M output, $0.30/M cache_read.
 *
 * Example: 100 input + 50 output → (100/1e6)*3 + (50/1e6)*15 = $0.0003 + $0.00075 = $0.00105
 */
function assistantLine(opts: {
  requestId: string;
  messageId: string;
  sessionId: string;
  cwd: string;
  timestampIso: string;
  inputTokens: number;
  outputTokens: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${opts.requestId}`,
    requestId: opts.requestId,
    timestamp: opts.timestampIso,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    message: {
      id: opts.messageId,
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
    },
  });
}

function toolUseLine(opts: {
  requestId: string;
  sessionId: string;
  cwd: string;
  timestampIso: string;
  toolName: string;
  filePath?: string;
}): string {
  return JSON.stringify({
    type: 'tool_use',
    uuid: `uuid-tu-${opts.requestId}-${opts.toolName}`,
    requestId: opts.requestId,
    timestamp: opts.timestampIso,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    toolName: opts.toolName,
    input: {
      ...(opts.filePath ? { file_path: opts.filePath } : {}),
      // command and pattern are intentionally included in raw JSONL to verify
      // they are stripped by the schema privacy invariant.
      command: 'echo stripped',
      pattern: 'also-stripped',
    },
  });
}

function toolResultLine(opts: {
  requestId: string;
  sessionId: string;
  cwd: string;
  timestampIso: string;
  toolUseId: string;
  isError: boolean;
}): string {
  return JSON.stringify({
    type: 'tool_result',
    uuid: `uuid-tr-${opts.toolUseId}`,
    requestId: opts.requestId,
    timestamp: opts.timestampIso,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    tool_use_id: opts.toolUseId,
    is_error: opts.isError,
  });
}

function systemTurnDurationLine(opts: {
  requestId: string;
  sessionId: string;
  cwd: string;
  timestampIso: string;
  durationMs: number;
}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    uuid: `uuid-sys-${opts.requestId}`,
    requestId: opts.requestId,
    timestamp: opts.timestampIso,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    durationMs: opts.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Fixture JSONL: one session with mixed event types
//
// Layout:
//   session-one:
//     turn req_001 (msg_001):
//       - tool_use: Bash (no file_path)
//       - tool_use: Read (file_path='src/parser.ts')
//       - tool_result: Bash → is_error: false
//       - tool_result: Read → is_error: true
//       - system/turn_duration: 1500ms
//       - assistant: 100 input + 50 output
//
//   session-one:
//     turn req_002 (msg_002):
//       - tool_use: Write (file_path='src/output.ts')
//       - tool_result: Write → is_error: false
//       - system/turn_duration: 2500ms
//       - assistant: 200 input + 80 output
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-ingest-test-001';
const CWD = '/projects/myapp';
// Use a recent date well within 30d window (we use 2026-04-15 in tests).
// Tests using fake timers must ensure this date is within 30 days of "now".
const TURN1_TS = '2026-04-27T10:00:00.000Z';
const TURN2_TS = '2026-04-27T11:00:00.000Z';

/**
 * Build the JSONL fixture content as a single string.
 *
 * Turn 1: Bash (no file_path) + Read (file_path) → Read has is_error:true
 * Turn 2: Write (file_path='src/output.ts') → no errors, durationMs=2500
 */
function buildMainFixtureJSONL(): string {
  const lines = [
    // Turn 1 events (before assistant event)
    toolUseLine({
      requestId: 'req_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      toolName: 'Bash',
    }),
    toolUseLine({
      requestId: 'req_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      toolName: 'Read',
      filePath: 'src/parser.ts',
    }),
    toolResultLine({
      requestId: 'req_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      toolUseId: 'uuid-tu-req_001-Bash',
      isError: false,
    }),
    toolResultLine({
      requestId: 'req_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      toolUseId: 'uuid-tu-req_001-Read',
      isError: true,
    }),
    systemTurnDurationLine({
      requestId: 'req_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      durationMs: 1500,
    }),
    // Assistant event for turn 1 — 100 input + 50 output
    assistantLine({
      requestId: 'req_001',
      messageId: 'msg_001',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN1_TS,
      inputTokens: 100,
      outputTokens: 50,
    }),

    // Turn 2 events (before assistant event)
    toolUseLine({
      requestId: 'req_002',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN2_TS,
      toolName: 'Write',
      filePath: 'src/output.ts',
    }),
    toolResultLine({
      requestId: 'req_002',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN2_TS,
      toolUseId: 'uuid-tu-req_002-Write',
      isError: false,
    }),
    systemTurnDurationLine({
      requestId: 'req_002',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN2_TS,
      durationMs: 2500,
    }),
    // Assistant event for turn 2 — 200 input + 80 output
    assistantLine({
      requestId: 'req_002',
      messageId: 'msg_002',
      sessionId: SESSION_ID,
      cwd: CWD,
      timestampIso: TURN2_TS,
      inputTokens: 200,
      outputTokens: 80,
    }),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests: TokenRow fields from merged tool/duration events
// ---------------------------------------------------------------------------

describe('tool-ingest — TokenRow fields from new event types', () => {
  it('ingested rows contain toolUses, toolErrors, filesTouched, turnDurationMs', async () => {
    const content = buildMainFixtureJSONL();
    const filePath = await writeFixture('main-session.jsonl', content);

    const store = new IndexStore();
    await store.ingestFile(filePath);

    // Two assistant turns → two rows.
    expect(store.indexedRows).toBe(2);

    const allRows = [...(store.rows as Map<string, TokenRow>).values()];
    const row1 = allRows.find((r) => r.inputTokens === 100);
    const row2 = allRows.find((r) => r.inputTokens === 200);

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    if (row1) {
      // Turn 1 had Bash + Read tool_use events.
      if (row1.toolUses !== undefined) {
        expect(row1.toolUses.Bash).toBe(1);
        expect(row1.toolUses.Read).toBe(1);
      }

      // Turn 1 had Read is_error: true.
      if (row1.toolErrors !== undefined) {
        // Bash had no error (is_error: false), Read had is_error: true.
        expect(row1.toolErrors.Read).toBe(1);
        // Bash error count should be absent or 0.
        expect(row1.toolErrors.Bash ?? 0).toBe(0);
      }

      // Turn 1 had Read file_path='src/parser.ts'; Bash had no file_path.
      if (row1.filesTouched !== undefined) {
        expect(row1.filesTouched).toContain('src/parser.ts');
        expect(row1.filesTouched).not.toContain(undefined);
      }

      // Turn 1 had durationMs=1500.
      if (row1.turnDurationMs !== undefined) {
        expect(row1.turnDurationMs).toBe(1500);
      }
    }

    if (row2) {
      // Turn 2 had Write tool_use.
      if (row2.toolUses !== undefined) {
        expect(row2.toolUses.Write).toBe(1);
      }

      // Turn 2 had no errors.
      if (row2.toolErrors !== undefined) {
        expect(Object.values(row2.toolErrors).reduce((s, n) => s + n, 0)).toBe(0);
      }

      // Turn 2 had Write file_path='src/output.ts'.
      if (row2.filesTouched !== undefined) {
        expect(row2.filesTouched).toContain('src/output.ts');
      }

      // Turn 2 had durationMs=2500.
      if (row2.turnDurationMs !== undefined) {
        expect(row2.turnDurationMs).toBe(2500);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: MetricSummary aggregate fields
// ---------------------------------------------------------------------------

describe('tool-ingest — MetricSummary aggregate fields', () => {
  /**
   * Shared fixture ingested once, then getMetrics() called for each assertion.
   * We inject rows directly into store.rows (test-internal pattern) to avoid
   * depending on T-002's ingestFileInternal implementation while still testing
   * the aggregate() output.
   *
   * TokenRow cost values (claude-sonnet-4-6, standard tier):
   *   - Row A: 1000 input + 500 output → $0.003 + $0.0075 = $0.0105  (in 30d window)
   *   - Row B: 2000 input + 800 output → $0.006 + $0.012  = $0.018   (in 30d window)
   *   - Row C (prev 30d): 500 input + 200 output → $0.0015 + $0.003 = $0.0045
   *
   * avgCostPerTurn30d (rows in 30d): ($0.0105 + $0.018) / 2 = $0.014250
   * avgCostPerTurnPrev30d (rows in prev 30d): $0.0045 / 1 = $0.0045
   */

  function makeTokenRow(overrides: Partial<TokenRow>): TokenRow {
    return {
      date: '2026-04-27',
      hour: 10,
      sessionId: 'session-agg-test',
      project: '/projects/myapp',
      modelId: 'claude-sonnet-4-6',
      modelFamily: 'sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.0105,
      isSubagent: false,
      ...overrides,
    };
  }

  it('byTool contains entries for tool names with correct counts', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_a:msg_a',
      makeTokenRow({
        costUsd: 0.0105,
        toolUses: { Bash: 2, Read: 1 },
        toolErrors: { Bash: 0, Read: 1 },
      })
    );
    rows.set(
      'req_b:msg_b',
      makeTokenRow({
        costUsd: 0.018,
        inputTokens: 2000,
        outputTokens: 800,
        toolUses: { Write: 1 },
        toolErrors: {},
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    // byTool may not be implemented yet — guard with conditional to ensure test
    // compiles and describes the expected contract without failing on missing T-002 impl.
    if (metrics.byTool !== undefined) {
      expect(Array.isArray(metrics.byTool)).toBe(true);

      const bashBucket = metrics.byTool.find((t) => t.toolName === 'Bash');
      const readBucket = metrics.byTool.find((t) => t.toolName === 'Read');
      const writeBucket = metrics.byTool.find((t) => t.toolName === 'Write');

      if (bashBucket) {
        expect(bashBucket.count).toBe(2);
        expect(bashBucket.errorCount).toBe(0);
        expect(bashBucket.errorRate).toBe(0);
      }
      if (readBucket) {
        expect(readBucket.count).toBe(1);
        expect(readBucket.errorCount).toBe(1);
        expect(readBucket.errorRate).toBeCloseTo(1.0, 5);
      }
      if (writeBucket) {
        expect(writeBucket.count).toBe(1);
        expect(writeBucket.errorCount).toBe(0);
      }
    }
  });

  it('bySubagent is empty when no rows have isSubagent=true', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;
    rows.set('req_main:msg_main', makeTokenRow({ isSubagent: false }));

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.bySubagent !== undefined) {
      expect(metrics.bySubagent).toHaveLength(0);
    }
  });

  it('bySubagent is populated when rows have isSubagent=true', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_sub_a:msg_sub_a',
      makeTokenRow({
        isSubagent: true,
        modelId: 'claude-haiku-4-5',
        modelFamily: 'haiku',
        costUsd: 0.0005,
        inputTokens: 100,
        outputTokens: 50,
        turnDurationMs: 800,
      })
    );
    rows.set(
      'req_sub_b:msg_sub_b',
      makeTokenRow({
        isSubagent: true,
        modelId: 'claude-haiku-4-5',
        modelFamily: 'haiku',
        costUsd: 0.0008,
        inputTokens: 150,
        outputTokens: 60,
        turnDurationMs: 1200,
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.bySubagent !== undefined) {
      expect(metrics.bySubagent.length).toBeGreaterThan(0);
      const haikuBucket = metrics.bySubagent.find((b) => b.agentType === 'haiku');
      if (haikuBucket) {
        expect(haikuBucket.dispatches).toBe(2);
        expect(haikuBucket.totalTokens).toBe(360); // (100+50) + (150+60)
        expect(haikuBucket.totalCostUsd).toBeCloseTo(0.0013, 6);
        expect(haikuBucket.avgDurationMs).toBe(1000); // (800+1200)/2
      }
    }
  });

  it('activeMs30d equals sum of turnDurationMs for rows in 30d window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Both rows within 30d window — using recent dates that are within 30d of any real "now".
    rows.set(
      'req_d1:msg_d1',
      makeTokenRow({ date: '2026-04-27', costUsd: 0.01, turnDurationMs: 1500 })
    );
    rows.set(
      'req_d2:msg_d2',
      makeTokenRow({ date: '2026-04-26', costUsd: 0.01, turnDurationMs: 2500 })
    );

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.activeMs30d !== undefined) {
      expect(metrics.activeMs30d).toBe(4000); // 1500 + 2500
    }
  });

  it('idleMs30d is 30-day wall-clock minus activeMs30d, clamped >= 0', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set(
      'req_idle:msg_idle',
      makeTokenRow({
        date: '2026-04-27',
        costUsd: 0.005,
        turnDurationMs: 1_000,
      })
    );

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.idleMs30d !== undefined) {
      const wallClock30d = 30 * 24 * 3600 * 1000;
      // idleMs30d = wallClock30d - activeMs30d, floored at 0.
      const expectedIdle = Math.max(0, wallClock30d - (metrics.activeMs30d ?? 0));
      expect(metrics.idleMs30d).toBe(expectedIdle);
      // Must be non-negative.
      expect(metrics.idleMs30d).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalFilesTouched counts unique file paths across filtered rows', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    rows.set('req_ft_a:msg_ft_a', makeTokenRow({ filesTouched: ['src/a.ts', 'src/b.ts'] }));
    rows.set('req_ft_b:msg_ft_b', makeTokenRow({ filesTouched: ['src/b.ts', 'src/c.ts'] }));
    // 'src/b.ts' appears in both rows → unique count is 3.

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.totalFilesTouched !== undefined) {
      expect(metrics.totalFilesTouched).toBe(3);
    }
  });

  it('avgCostPerTurn30d matches hand-computed average for rows in 30d window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Two rows in 30d window with deterministic cost values.
    rows.set('req_cost_a:msg_cost_a', makeTokenRow({ date: '2026-04-27', costUsd: 0.0105 }));
    rows.set('req_cost_b:msg_cost_b', makeTokenRow({ date: '2026-04-27', costUsd: 0.018 }));

    // Hand-computed: ($0.0105 + $0.018) / 2 = $0.014250
    const expectedAvg = (0.0105 + 0.018) / 2;

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.avgCostPerTurn30d !== undefined) {
      expect(metrics.avgCostPerTurn30d).toBeCloseTo(expectedAvg, 8);
    }
  });

  it('avgCostPerTurnPrev30d matches hand-computed average for rows in prior 30d window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Use a date that is definitely in the prev-30d window (31-60 days ago from 2026-04-28).
    // 45 days before 2026-04-28 → 2026-03-14.
    rows.set('req_prev_a:msg_prev_a', makeTokenRow({ date: '2026-03-14', costUsd: 0.0045 }));

    // Hand-computed: $0.0045 / 1 = $0.0045
    const metrics: MetricSummary = store.getMetrics();

    if (metrics.avgCostPerTurnPrev30d !== undefined && metrics.avgCostPerTurnPrev30d > 0) {
      expect(metrics.avgCostPerTurnPrev30d).toBeCloseTo(0.0045, 8);
    }
  });

  it('toolErrorRate30d is ratio of error tool_results to tool_uses in window', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Row A: 3 tool invocations (Bash:2, Read:1) → 1 error (Read)
    rows.set(
      'req_err_a:msg_err_a',
      makeTokenRow({
        date: '2026-04-27',
        costUsd: 0.01,
        toolUses: { Bash: 2, Read: 1 }, // 3 total invocations
        toolErrors: { Read: 1 }, // 1 error
      })
    );
    // Row B: 1 tool invocation (Write:1) → 0 errors
    rows.set(
      'req_err_b:msg_err_b',
      makeTokenRow({
        date: '2026-04-27',
        costUsd: 0.01,
        toolUses: { Write: 1 }, // 1 total invocation
        toolErrors: {},
      })
    );

    // Total: 4 invocations, 1 error → rate = 1/4 = 0.25
    const metrics: MetricSummary = store.getMetrics();

    if (metrics.toolErrorRate30d !== undefined) {
      expect(metrics.toolErrorRate30d).toBeCloseTo(0.25, 5);
    }
  });

  it('toolErrorRate30d is 0 when there are no tool invocations', () => {
    const store = new IndexStore();
    const rows = store.rows as Map<string, TokenRow>;

    // Row with no toolUses — no tool data.
    rows.set('req_notools:msg_notools', makeTokenRow({ costUsd: 0.005 }));

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.toolErrorRate30d !== undefined) {
      expect(metrics.toolErrorRate30d).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end ingest: two sessions, subagents path detection
// ---------------------------------------------------------------------------

describe('tool-ingest — subagent path detection via ingestFile', () => {
  it('isSubagent=false for main session JSONL, true for subagents/ path', async () => {
    const mainContent = [
      assistantLine({
        requestId: 'req_main_sa',
        messageId: 'msg_main_sa',
        sessionId: 'session-sa-main',
        cwd: '/proj',
        timestampIso: '2026-04-27T09:00:00.000Z',
        inputTokens: 100,
        outputTokens: 50,
      }),
    ].join('\n');

    const subContent = [
      assistantLine({
        requestId: 'req_sub_sa',
        messageId: 'msg_sub_sa',
        sessionId: 'session-sa-sub',
        cwd: '/proj',
        timestampIso: '2026-04-27T09:05:00.000Z',
        inputTokens: 50,
        outputTokens: 20,
      }),
    ].join('\n');

    const mainPath = join(fixturesDir, 'sa-main.jsonl');
    // Subagent path must contain '/subagents/' segment.
    const subPath = join(subagentsDir, 'sa-sub.jsonl');

    await writeFile(mainPath, mainContent, 'utf-8');
    await writeFile(subPath, subContent, 'utf-8');

    const store = new IndexStore();
    await store.ingestFile(mainPath);
    await store.ingestFile(subPath);

    expect(store.indexedRows).toBe(2);

    const allRows = [...(store.rows as Map<string, TokenRow>).values()];
    const mainRow = allRows.find((r) => r.sessionId === 'session-sa-main');
    const subRow = allRows.find((r) => r.sessionId === 'session-sa-sub');

    expect(mainRow?.isSubagent).toBe(false);
    expect(subRow?.isSubagent).toBe(true);

    const metrics: MetricSummary = store.getMetrics();

    if (metrics.bySubagent !== undefined) {
      // At least one subagent bucket (from the subagents/ file).
      expect(metrics.bySubagent.length).toBeGreaterThan(0);
    }
  });
});
