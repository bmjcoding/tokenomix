/**
 * csvExport.ts — RFC 4180 CSV serializer and browser-download trigger.
 *
 * Exports two public functions:
 *   - exportSessionsCsv(sessions, filename?) — downloads a CSV of SessionSummary rows
 *   - exportDailySeriesCsv(series, filename?) — downloads a CSV of DailyBucket rows
 *
 * No third-party CSV library is used. RFC 4180 rules applied:
 *   - Comma delimiter
 *   - CRLF line endings (\r\n)
 *   - Any field whose value contains a comma, double-quote, CR, or LF is
 *     wrapped in double-quotes; internal double-quotes are escaped by doubling.
 *
 * Internal helpers (quoteField, serializeCsv, buildSessionsRows, buildDailySeriesRows)
 * are exported for direct unit-testing of the serialization logic without a
 * browser environment.
 */

import type { DailyBucket, SessionSummary } from '@tokenomix/shared';

// ---------------------------------------------------------------------------
// RFC 4180 helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Prefix-escape spreadsheet formula triggers per OWASP CSV injection guidance.
 * If the string starts with `=`, `+`, `-`, `@`, or TAB (`\t`), a single quote
 * (`'`) is prepended so spreadsheet applications (Excel, LibreOffice, Google
 * Sheets) treat the cell as text rather than evaluating it as a formula.
 */
export function escapeFormula(value: string): string {
  if (value.length > 0 && /^[=+\-@\t]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Quote a single CSV field value per RFC 4180.
 * Applies formula-injection escape first, then wraps in double-quotes when
 * the field contains a comma, double-quote, CR, or LF.
 * Internal double-quote characters are escaped by doubling.
 */
export function quoteField(value: string): string {
  const safe = escapeFormula(value);
  const needsQuoting = /[",\r\n]/.test(safe);
  if (!needsQuoting) {
    return safe;
  }
  // Escape internal double-quotes by doubling them.
  const escaped = safe.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Serialize an array of row arrays to an RFC 4180 CSV string.
 * Each inner array is one row; all cells are converted to string before quoting.
 */
export function serializeCsv(
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean>>
): string {
  return rows.map((row) => row.map((cell) => quoteField(String(cell))).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Row builders (exported for testing without DOM)
// ---------------------------------------------------------------------------

/** Column headers for session export. */
export const SESSIONS_HEADERS = [
  'Project',
  'ProjectName',
  'SessionId',
  'CostUSD',
  'InputTokens',
  'OutputTokens',
  'CacheCreation',
  'CacheRead',
  'Events',
  'IsSubagent',
] as const;

/** Column headers for daily series export. */
export const DAILY_SERIES_HEADERS = [
  'Date',
  'CostUSD',
  'InputTokens',
  'OutputTokens',
  'CacheCreationTokens',
  'CacheReadTokens',
] as const;

/**
 * Build all rows (header + data) for a session CSV.
 * Returns a 2D array suitable for passing to serializeCsv.
 */
export function buildSessionsRows(
  sessions: SessionSummary[]
): ReadonlyArray<ReadonlyArray<string | number | boolean>> {
  const dataRows = sessions.map(
    (s) =>
      [
        s.project,
        s.projectName,
        s.sessionId,
        s.costUsd,
        s.inputTokens,
        s.outputTokens,
        s.cacheCreationTokens,
        s.cacheReadTokens,
        s.events,
        s.isSubagent,
      ] as const
  );
  return [SESSIONS_HEADERS, ...dataRows];
}

/**
 * Build all rows (header + data) for a daily series CSV.
 * Returns a 2D array suitable for passing to serializeCsv.
 */
export function buildDailySeriesRows(
  series: DailyBucket[]
): ReadonlyArray<ReadonlyArray<string | number | boolean>> {
  const dataRows = series.map(
    (b) =>
      [
        b.date,
        b.costUsd,
        b.inputTokens,
        b.outputTokens,
        b.cacheCreationTokens,
        b.cacheReadTokens,
      ] as const
  );
  return [DAILY_SERIES_HEADERS, ...dataRows];
}

// ---------------------------------------------------------------------------
// Browser download trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a browser download for the given CSV content.
 * Creates a temporary <a> element, assigns a Blob URL, clicks it, then
 * revokes the URL. Works in jsdom (or with mocked globals) when
 * document.createElement and URL.createObjectURL are mocked in tests.
 */
function triggerDownload(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  // Some browsers require the element to be in the DOM before click().
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Public export functions
// ---------------------------------------------------------------------------

/**
 * Export an array of SessionSummary records as a downloadable CSV file.
 *
 * Columns (in order):
 *   Project, ProjectName, SessionId, CostUSD, InputTokens, OutputTokens,
 *   CacheCreation, CacheRead, Events, IsSubagent
 *
 * @param sessions - Array of SessionSummary objects from GET /api/sessions.
 * @param filename - Optional filename; defaults to "sessions.csv".
 */
export function exportSessionsCsv(sessions: SessionSummary[], filename = 'sessions.csv'): void {
  const csv = serializeCsv(buildSessionsRows(sessions));
  triggerDownload(csv, filename);
}

/**
 * Export an array of DailyBucket records as a downloadable CSV file.
 *
 * Columns (in order):
 *   Date, CostUSD, InputTokens, OutputTokens, CacheCreationTokens, CacheReadTokens
 *
 * @param series - Array of DailyBucket objects from MetricSummary.dailySeries.
 * @param filename - Optional filename; defaults to "daily-series.csv".
 */
export function exportDailySeriesCsv(series: DailyBucket[], filename = 'daily-series.csv'): void {
  const csv = serializeCsv(buildDailySeriesRows(series));
  triggerDownload(csv, filename);
}
