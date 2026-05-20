/**
 * Streaming parser for Codex session JSONL files.
 *
 * Codex stores session data under ~/.codex/sessions as records shaped like:
 *   { timestamp, type, payload }
 *
 * Token usage is emitted as event_msg payload.type === "token_count". The
 * parser yields one normalized usage event per advancing cumulative token total.
 * Duplicate token_count records with unchanged totals are skipped because Codex
 * emits a checkpoint at some turn boundaries before any new model call.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { logEvent } from './logger.js';

type CodexParseSkipReason = 'invalid-json' | 'file-open-error';

interface ParseCodexUsageRowsOptions {
  onSkip?: (reason: CodexParseSkipReason) => void;
}

interface CodexRawTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexUsageRowEvent {
  timestamp: string;
  sessionId: string;
  cwd: string;
  modelId: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
  toolUses?: Record<string, number>;
  toolErrors?: Record<string, number>;
  webSearchRequests?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mapToRecord(map: Map<string, number>): Record<string, number> | undefined {
  if (map.size === 0) return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of map) {
    result[key] = value;
  }
  return result;
}

function normalizeToolName(name: string): string {
  // Dynamic tools arrive as "namespace.function" or plain function names.
  // Keep names short enough to scan in the existing tool chips.
  const parts = name.split('.');
  return parts[parts.length - 1] || name;
}

function hasFailedToolPayload(payload: Record<string, unknown>): boolean {
  const status = stringField(payload, 'status')?.toLowerCase();
  if (status === 'failed' || status === 'error') return true;
  const exitCode = payload.exit_code;
  return typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0;
}

function parseUsage(raw: unknown): CodexUsageRowEvent['usage'] | null {
  const usage = asRecord(raw) as (CodexRawTokenUsage & Record<string, unknown>) | null;
  if (!usage) return null;

  const inputTokens = numberField(usage, 'input_tokens');
  const cachedInputTokens = numberField(usage, 'cached_input_tokens');
  const outputTokens = numberField(usage, 'output_tokens');
  const reasoningOutputTokens = numberField(usage, 'reasoning_output_tokens');
  const totalTokens = numberField(usage, 'total_tokens') || inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) return null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

export async function* parseCodexUsageRows(
  filePath: string,
  options: ParseCodexUsageRowsOptions = {}
): AsyncGenerator<CodexUsageRowEvent> {
  let rl: ReturnType<typeof createInterface> | undefined;
  let sessionId = '';
  let cwd = '';
  let modelId = '';
  let lastAcceptedTotal = 0;
  const toolUses = new Map<string, number>();
  const toolErrors = new Map<string, number>();
  const toolNameByCallId = new Map<string, string>();
  let webSearchRequests = 0;

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        options.onSkip?.('invalid-json');
        logEvent('warn', 'codex-parse-warn', { path: filePath, reason: 'invalid-json' });
        continue;
      }

      const record = asRecord(raw);
      if (!record) continue;
      const timestamp = stringField(record, 'timestamp');
      const payload = asRecord(record.payload);
      const recordType = stringField(record, 'type');
      if (!payload) continue;

      if (recordType === 'session_meta') {
        sessionId = stringField(payload, 'id') ?? sessionId;
        cwd = stringField(payload, 'cwd') ?? cwd;
        continue;
      }

      if (recordType === 'turn_context') {
        cwd = stringField(payload, 'cwd') ?? cwd;
        modelId = stringField(payload, 'model') ?? modelId;
        continue;
      }

      if (recordType === 'response_item') {
        const payloadType = stringField(payload, 'type');
        if (payloadType === 'web_search_call' && !hasFailedToolPayload(payload)) {
          increment(toolUses, 'web_search');
          webSearchRequests += 1;
          continue;
        }
        if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
          const toolName = stringField(payload, 'name');
          const callId = stringField(payload, 'call_id');
          if (toolName) {
            const normalized = normalizeToolName(toolName);
            increment(toolUses, normalized);
            if (callId) toolNameByCallId.set(callId, normalized);
          }
        }
        continue;
      }

      if (recordType !== 'event_msg') continue;

      const payloadType = stringField(payload, 'type');
      if (payloadType !== 'token_count') {
        if (payloadType === 'web_search_call' && !hasFailedToolPayload(payload)) {
          increment(toolUses, 'web_search');
          webSearchRequests += 1;
          continue;
        }

        const callId = stringField(payload, 'call_id');
        const toolName = callId ? toolNameByCallId.get(callId) : undefined;
        if (toolName && hasFailedToolPayload(payload)) {
          increment(toolErrors, toolName);
        }
        continue;
      }

      const info = asRecord(payload.info);
      const usage = parseUsage(info?.last_token_usage);
      const totalUsage = parseUsage(info?.total_token_usage);
      const cumulativeTotal = totalUsage?.totalTokens ?? usage?.totalTokens ?? 0;
      if (!timestamp || !usage || !sessionId || !modelId) continue;
      if (cumulativeTotal > 0 && cumulativeTotal <= lastAcceptedTotal) continue;

      if (cumulativeTotal > 0) lastAcceptedTotal = cumulativeTotal;

      const uses = mapToRecord(toolUses);
      const errors = mapToRecord(toolErrors);
      const webSearches = webSearchRequests;
      toolUses.clear();
      toolErrors.clear();
      webSearchRequests = 0;

      yield {
        timestamp,
        sessionId,
        cwd,
        modelId,
        usage,
        ...(uses ? { toolUses: uses } : {}),
        ...(errors ? { toolErrors: errors } : {}),
        ...(webSearches > 0 ? { webSearchRequests: webSearches } : {}),
      };
    }
  } catch {
    options.onSkip?.('file-open-error');
  } finally {
    rl?.close();
  }
}
