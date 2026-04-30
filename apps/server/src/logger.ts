/**
 * Shared structured logging utility for the tokenomix server.
 *
 * Extracted from parser.ts and index-store.ts to eliminate divergent copies.
 * This module has NO imports from parser.ts or index-store.ts — circular
 * dependency avoidance is the whole reason this module exists.
 *
 * Stream routing (POSIX convention):
 *   'error' | 'warn'  → stderr
 *   'info'            → stdout
 *   'debug'           → stdout, gated by TOKENOMIX_DEBUG === '1'
 */

import { formatLocalIso } from './time.js';

/**
 * Write a structured JSON log entry.
 *
 * - 'error' and 'warn' go to stderr (POSIX convention).
 * - 'info' goes to stdout.
 * - 'debug' goes to stdout, but only when TOKENOMIX_DEBUG === '1'.
 *
 * All entries include timestamp, level, service, and event fields.
 */
export function logEvent(
  level: 'info' | 'warn' | 'error' | 'debug',
  event: string,
  fields: Record<string, unknown>
): void {
  if (level === 'debug' && process.env.TOKENOMIX_DEBUG !== '1') return;
  const entry = JSON.stringify({
    timestamp: formatLocalIso(),
    level,
    service: 'tokenomix-server',
    event,
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${entry}\n`);
  } else {
    process.stdout.write(`${entry}\n`);
  }
}
