/**
 * JSONL streaming parser for Claude Code session files.
 *
 * Uses readline to stream line-by-line — never loads the full file into memory.
 * Validates each line against the shared Zod schema; malformed lines are skipped.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { RawUsageEventSchema } from '@tokenomix/shared';
import type { RawUsageEventParsed } from '@tokenomix/shared';

/**
 * Async generator that streams parsed JSONL events from a file.
 *
 * - Skips empty/blank lines silently.
 * - Skips lines that fail JSON.parse (malformed JSONL).
 * - Skips lines that fail Zod validation.
 * - Never throws; all errors produce a skip + log.
 */
export async function* parseJSONLFile(filePath: string): AsyncGenerator<RawUsageEventParsed> {
  let rl: ReturnType<typeof createInterface> | undefined;
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
        // Malformed JSON — log path (never raw line content) and skip.
        process.stderr.write(
          `${JSON.stringify({ event: 'parse-warn', path: filePath, reason: 'invalid-json' })}\n`
        );
        continue;
      }

      const result = RawUsageEventSchema.safeParse(raw);
      if (result.success) {
        yield result.data;
      } else {
        // Zod parse failure — log path and skip. Do NOT log raw line content.
        process.stderr.write(
          `${JSON.stringify({ event: 'parse-warn', path: filePath, reason: 'schema-mismatch' })}\n`
        );
      }
    }
  } catch {
    // File open failure (permissions, deleted file) — emit nothing.
  } finally {
    rl?.close();
  }
}
