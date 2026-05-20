/**
 * Streaming parser for local-model telemetry JSONL.
 *
 * Tokenomix watches JSONL files under ~/.tokenomix/local-models. Each line can
 * be a normalized Tokenomix usage record, an Ollama final response chunk, or an
 * LM Studio response with a stats object.
 */

import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { logEvent } from './logger.js';

export type LocalModelParseSkipReason = 'invalid-json' | 'schema-mismatch' | 'file-open-error';

interface ParseLocalModelUsageRowsOptions {
  onSkip?: (reason: LocalModelParseSkipReason) => void;
}

export interface LocalModelUsageRowEvent {
  sourceLine: number;
  timestamp: string;
  sessionId: string;
  cwd: string;
  modelId: string;
  runtime: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
  metrics: {
    durationMs?: number;
    timeToFirstTokenMs?: number;
    promptEvalDurationMs?: number;
    evalDurationMs?: number;
    loadDurationMs?: number;
    tokensPerSecond?: number;
  };
  toolUses?: Record<string, number>;
  toolErrors?: Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}

function timestampField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const trimmed = value.trim();
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
        return epochToIso(numeric);
      }
      return trimmed;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return epochToIso(value);
    }
  }
  return undefined;
}

function epochToIso(value: number): string {
  // OpenAI-compatible APIs use Unix seconds in `created`; browser/runtime logs
  // often use epoch milliseconds. Values beyond year-2001 milliseconds are
  // treated as ms, otherwise as seconds.
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function tokenCount(record: Record<string, unknown>, keys: readonly string[]): number {
  const value = firstNumber(record, keys);
  return value !== undefined && value > 0 ? Math.floor(value) : 0;
}

function cachedInputTokenCount(record: Record<string, unknown>): number {
  const flat = tokenCount(record, [
    'cachedInputTokens',
    'cached_input_tokens',
    'cache_read_input_tokens',
    'cached_tokens',
    'cache_read_tokens',
  ]);
  if (flat > 0) return flat;
  const cache = asRecord(record.cache);
  if (cache) {
    const read = tokenCount(cache, ['read', 'cached', 'cached_tokens', 'cache_read_tokens']);
    if (read > 0) return read;
  }
  const details = asRecord(record.prompt_tokens_details) ?? asRecord(record.promptTokensDetails);
  return details ? tokenCount(details, ['cached_tokens', 'cachedTokens']) : 0;
}

function reasoningOutputTokenCount(record: Record<string, unknown>): number {
  const flat = tokenCount(record, [
    'reasoningOutputTokens',
    'reasoning_output_tokens',
    'reasoning',
  ]);
  if (flat > 0) return flat;
  const details =
    asRecord(record.completion_tokens_details) ?? asRecord(record.completionTokensDetails);
  return details ? tokenCount(details, ['reasoning_tokens', 'reasoningTokens']) : 0;
}

function msFromMs(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const value = firstNumber(record, keys);
  return value !== undefined && value >= 0 ? value : undefined;
}

function msFromSeconds(
  record: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  const value = firstNumber(record, keys);
  return value !== undefined && value >= 0 ? value * 1000 : undefined;
}

function msFromNanoseconds(
  record: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  const value = firstNumber(record, keys);
  return value !== undefined && value >= 0 ? value / 1_000_000 : undefined;
}

function tokensPerSecond(
  outputTokens: number,
  metricsSource: Record<string, unknown>,
  evalDurationMs: number | undefined
): number | undefined {
  const explicit = firstNumber(metricsSource, [
    'tokensPerSecond',
    'tokens_per_second',
    'evalTokensPerSecond',
    'eval_tokens_per_second',
  ]);
  if (explicit !== undefined && explicit >= 0) return explicit;
  if (outputTokens > 0 && evalDurationMs !== undefined && evalDurationMs > 0) {
    return outputTokens / (evalDurationMs / 1000);
  }
  return undefined;
}

function increment(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function recordFromCountMap(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const result: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(record)) {
    const count = finiteNumber(rawCount);
    if (count !== undefined && count > 0) result[key] = Math.floor(count);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseOutputTools(body: Record<string, unknown>): {
  toolUses?: Record<string, number>;
  toolErrors?: Record<string, number>;
} {
  const explicitUses = recordFromCountMap(body.toolUses ?? body.tool_uses);
  const explicitErrors = recordFromCountMap(body.toolErrors ?? body.tool_errors);
  if (explicitUses || explicitErrors) {
    return {
      ...(explicitUses ? { toolUses: explicitUses } : {}),
      ...(explicitErrors ? { toolErrors: explicitErrors } : {}),
    };
  }

  const output = Array.isArray(body.output) ? body.output : [];
  const uses = new Map<string, number>();
  const errors = new Map<string, number>();
  for (const item of output) {
    const rec = asRecord(item);
    if (!rec) continue;
    const type = stringField(rec, 'type');
    if (type === 'tool_call') {
      const toolName = firstString(rec, ['tool', 'name']);
      if (toolName) increment(uses, toolName);
    } else if (type === 'invalid_tool_call') {
      const toolName = firstString(rec, ['tool_name', 'tool', 'name']) ?? 'invalid_tool_call';
      increment(uses, toolName);
      increment(errors, toolName);
    }
  }

  const toolUses = Object.fromEntries(uses);
  const toolErrors = Object.fromEntries(errors);
  return {
    ...(Object.keys(toolUses).length > 0 ? { toolUses } : {}),
    ...(Object.keys(toolErrors).length > 0 ? { toolErrors } : {}),
  };
}

function defaultSessionId(runtime: string, filePath: string): string {
  return `${runtime}:${basename(filePath).replace(/\.jsonl$/i, '')}`;
}

function inferRuntime(
  body: Record<string, unknown>,
  usageSource: Record<string, unknown>,
  metricsSource: Record<string, unknown>
): string {
  const explicit = firstString(body, ['runtime', 'source', 'provider', 'adapter']);
  if (explicit) return explicit.toLowerCase();
  if (
    stringField(body, 'type') === 'step_finish' ||
    stringField(asRecord(body.part) ?? {}, 'type') === 'step-finish'
  ) {
    return 'opencode';
  }
  if (
    usageSource.prompt_eval_count !== undefined ||
    metricsSource.total_duration !== undefined ||
    metricsSource.eval_duration !== undefined
  ) {
    return 'ollama';
  }
  if (body.stats !== undefined || metricsSource.time_to_first_token_seconds !== undefined) {
    return 'lm-studio';
  }
  return 'local-model';
}

function opencodeTokenSource(body: Record<string, unknown>): Record<string, unknown> | null {
  if (
    stringField(body, 'type') !== 'step_finish' &&
    stringField(asRecord(body.part) ?? {}, 'type') !== 'step-finish'
  ) {
    return null;
  }
  const part = asRecord(body.part);
  return part ? asRecord(part.tokens) : null;
}

function parseUsageEvent(
  rawRecord: Record<string, unknown>,
  filePath: string,
  sourceLine: number
): LocalModelUsageRowEvent | null {
  const payload = asRecord(rawRecord.payload);
  const body = payload ?? rawRecord;
  const opencodeTokens = opencodeTokenSource(body);
  const usageSource =
    asRecord(body.usage) ??
    asRecord(body.stats) ??
    asRecord(body.metrics) ??
    opencodeTokens ??
    body;
  const metricsSource = asRecord(body.metrics) ?? asRecord(body.stats) ?? body;
  const part = asRecord(body.part);

  const timestamp =
    timestampField(body, ['timestamp', 'created_at', 'createdAt', 'created', 'time']) ??
    timestampField(rawRecord, ['timestamp', 'created_at', 'createdAt', 'created', 'time']);
  const modelId =
    firstString(body, ['model', 'modelId', 'model_id', 'model_instance_id']) ??
    (part ? firstString(part, ['model', 'modelId', 'model_id', 'model_instance_id']) : undefined);
  if (!timestamp || !modelId) return null;

  const inputTokens = tokenCount(usageSource, [
    'input',
    'inputTokens',
    'input_tokens',
    'prompt_tokens',
    'promptTokens',
    'prompt_eval_count',
  ]);
  const outputTokens = tokenCount(usageSource, [
    'output',
    'outputTokens',
    'output_tokens',
    'completion_tokens',
    'completionTokens',
    'total_output_tokens',
    'eval_count',
  ]);
  const cachedInputTokens = cachedInputTokenCount(usageSource);
  const reasoningOutputTokens = reasoningOutputTokenCount(usageSource);
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) return null;

  const runtime = inferRuntime(body, usageSource, metricsSource);
  const evalDurationMs =
    msFromMs(metricsSource, ['evalDurationMs', 'eval_duration_ms']) ??
    msFromNanoseconds(metricsSource, ['eval_duration']);
  const promptEvalDurationMs =
    msFromMs(metricsSource, ['promptEvalDurationMs', 'prompt_eval_duration_ms']) ??
    msFromNanoseconds(metricsSource, ['prompt_eval_duration']);
  const loadDurationMs =
    msFromMs(metricsSource, ['loadDurationMs', 'load_duration_ms', 'modelLoadTimeMs']) ??
    msFromSeconds(metricsSource, ['model_load_time_seconds']) ??
    msFromNanoseconds(metricsSource, ['load_duration']);
  const durationMs =
    msFromMs(metricsSource, [
      'durationMs',
      'duration_ms',
      'totalDurationMs',
      'total_duration_ms',
    ]) ??
    msFromSeconds(metricsSource, ['duration_seconds', 'total_duration_seconds']) ??
    msFromNanoseconds(metricsSource, ['total_duration']) ??
    (promptEvalDurationMs !== undefined || evalDurationMs !== undefined
      ? (promptEvalDurationMs ?? 0) + (evalDurationMs ?? 0)
      : undefined);
  const timeToFirstTokenMs =
    msFromMs(metricsSource, ['timeToFirstTokenMs', 'time_to_first_token_ms']) ??
    msFromSeconds(metricsSource, ['time_to_first_token_seconds']);

  const tools = parseOutputTools(body);
  const sessionId =
    firstString(body, [
      'sessionId',
      'sessionID',
      'session_id',
      'conversationId',
      'conversation_id',
    ]) ??
    (part
      ? firstString(part, [
          'sessionId',
          'sessionID',
          'session_id',
          'conversationId',
          'conversation_id',
        ])
      : undefined) ??
    defaultSessionId(runtime, filePath);
  const generationTokensPerSecond = tokensPerSecond(outputTokens, metricsSource, evalDurationMs);

  return {
    sourceLine,
    timestamp,
    sessionId,
    cwd: firstString(body, ['cwd', 'project', 'projectPath', 'project_path']) ?? '',
    modelId,
    runtime,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    },
    metrics: {
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(promptEvalDurationMs !== undefined ? { promptEvalDurationMs } : {}),
      ...(evalDurationMs !== undefined ? { evalDurationMs } : {}),
      ...(loadDurationMs !== undefined ? { loadDurationMs } : {}),
      ...(generationTokensPerSecond !== undefined
        ? { tokensPerSecond: generationTokensPerSecond }
        : {}),
    },
    ...tools,
  };
}

export async function* parseLocalModelUsageRows(
  filePath: string,
  options: ParseLocalModelUsageRowsOptions = {}
): AsyncGenerator<LocalModelUsageRowEvent> {
  let rl: ReturnType<typeof createInterface> | undefined;

  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    let sourceLine = 0;
    for await (const line of rl) {
      sourceLine += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        options.onSkip?.('invalid-json');
        logEvent('warn', 'local-model-parse-warn', { path: filePath, reason: 'invalid-json' });
        continue;
      }

      const record = asRecord(raw);
      const event = record ? parseUsageEvent(record, filePath, sourceLine) : null;
      if (!event) {
        options.onSkip?.('schema-mismatch');
        continue;
      }
      yield event;
    }
  } catch {
    options.onSkip?.('file-open-error');
    logEvent('warn', 'local-model-parse-warn', { path: filePath, reason: 'file-open-error' });
  } finally {
    rl?.close();
  }
}
