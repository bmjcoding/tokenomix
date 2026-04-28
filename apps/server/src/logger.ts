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
 */

/**
 * Write a structured JSON log entry.
 *
 * - 'error' and 'warn' go to stderr (POSIX convention).
 * - 'info' goes to stdout.
 *
 * All entries include timestamp, level, service, and event fields.
 */
export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown>
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
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
