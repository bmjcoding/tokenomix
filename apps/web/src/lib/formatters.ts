/**
 * Shared formatting helpers for dashboard panels.
 *
 * All helpers are pure functions with no side effects and no imports.
 * Import from here rather than duplicating formatters across panels.
 */

/**
 * Converts a millisecond count to a compact human-readable duration string.
 *
 * Scale:
 *   < 1 000 ms      → "Xms"      (e.g. "750ms")
 *   < 60 000 ms     → "Xs"       (e.g. "42s")
 *   < 3 600 000 ms  → "Xm Ys"    (seconds omitted when zero; e.g. "14m 32s", "5m")
 *   ≥ 3 600 000 ms  → "Xh Ym"    (minutes omitted when zero; e.g. "2h 15m", "3h")
 *
 * A 90-second duration renders "1m 30s" across all panels that use this helper.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    return `${Math.floor(ms / 1_000)}s`;
  }
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Formats a duration that may be null (e.g. from an optional TurnBucket field).
 * Returns an em-dash for null values.
 */
export function formatDurationNullable(ms: number | null): string {
  if (ms === null) return '—';
  return formatDuration(ms);
}

/**
 * Adaptive USD currency formatter.
 *
 * Scale:
 *   ≥ 1.00  → "$1.23"    (2 decimal places)
 *   ≥ 0.01  → "$0.23"    (2 decimal places)
 *   < 0.01  → "$0.0023"  (4 decimal places — preserves sub-cent values)
 *
 * This prevents micro-dollar values like $0.0023 from rounding to "$0.00".
 */
export function formatCurrency(usd: number): string {
  if (usd >= 0.01) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usd);
  }
  // Sub-cent: show 4 decimal places to preserve signal
  return `$${usd.toFixed(4)}`;
}

/**
 * Formats an integer token count using locale-aware thousands separators.
 * Example: 1234567 → "1,234,567"
 */
export function formatTokens(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/**
 * Computes percentage delta: ((curr - prev) / prev) * 100.
 * Returns null when prev is 0 to avoid Infinity/NaN — callers should render
 * null as an em-dash rather than a percentage.
 */
export function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}
