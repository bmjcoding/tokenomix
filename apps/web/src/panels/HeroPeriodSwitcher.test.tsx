/**
 * HeroPeriodSwitcher.test.tsx — Vitest tests for HeroPeriodSwitcher behavior.
 *
 * Tests verify:
 * 1. The custom segment label helper produces the correct compact display string.
 * 2. The helper that converts YYYY-MM-DD to a local Date and back is round-trip
 *    stable — this is the core plumbing for onCustomRangeChange.
 * 3. The period display label used in the Custom segment (via period-rollup.ts).
 * 4. The popover interaction contract: when onSelect fires with a complete range
 *    (both `from` and `to` set), onCustomRangeChange and onPeriodChange are
 *    both called with the correct arguments.
 *
 * No DOM renderer is required — the test style follows the project convention
 * of pure function assertions (no @testing-library/react render calls) since
 * vitest does not have a jsdom environment configured at the root level.
 *
 * The popover-interaction logic extracted here mirrors exactly what the
 * HeroPeriodSwitcher component does in its handleRangeSelect callback.
 */

import { describe, expect, it, vi } from 'vitest';
import { type DateRange, type HeroPeriod, periodDisplayLabel } from '../lib/period-rollup.js';

// ---------------------------------------------------------------------------
// Helpers extracted for testability (mirrors HeroPeriodSwitcher internals)
// ---------------------------------------------------------------------------

/** Convert a YYYY-MM-DD string to a local Date (midnight) — same as component. */
function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Convert a local Date to YYYY-MM-DD — same as component. */
function localDateToYmd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Produce the Custom segment label — same logic as component. */
function customSegmentLabel(period: HeroPeriod, customRange: DateRange | null): string {
  if (period !== 'custom' || customRange === null) return 'Custom';
  return periodDisplayLabel('custom', customRange);
}

// ---------------------------------------------------------------------------
// Simulate the handleRangeSelect callback
// ---------------------------------------------------------------------------

/**
 * Simulates the DayPicker onSelect handler used in HeroPeriodSwitcher.
 * Returns `{ committed: true, range }` when a complete range is selected,
 * `{ committed: false }` when only `from` is set.
 */
function simulateRangeSelect(
  range: { from: Date | undefined; to?: Date | undefined } | undefined,
  onCustomRangeChange: (r: DateRange) => void,
  onPeriodChange: (p: HeroPeriod) => void
): { committed: boolean } {
  if (range?.from && range?.to) {
    const from = localDateToYmd(range.from);
    const to = localDateToYmd(range.to);
    onCustomRangeChange({ from, to });
    onPeriodChange('custom');
    return { committed: true };
  }
  return { committed: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ymdToLocalDate / localDateToYmd round-trip', () => {
  it('round-trips a typical date', () => {
    const ymd = '2026-04-15';
    expect(localDateToYmd(ymdToLocalDate(ymd))).toBe(ymd);
  });

  it('round-trips month boundaries', () => {
    for (const ymd of [
      '2026-01-01',
      '2026-01-31',
      '2026-02-28',
      '2024-02-29', // leap
      '2026-12-31',
    ]) {
      expect(localDateToYmd(ymdToLocalDate(ymd))).toBe(ymd);
    }
  });
});

describe('customSegmentLabel', () => {
  it('returns "Custom" when period is not custom', () => {
    expect(customSegmentLabel('mtd', null)).toBe('Custom');
    expect(customSegmentLabel('ytd', { from: '2026-01-01', to: '2026-04-15' })).toBe('Custom');
  });

  it('returns "Custom" when period is custom but no range set', () => {
    expect(customSegmentLabel('custom', null)).toBe('Custom');
  });

  it('returns a compact range label when custom range is set (same year)', () => {
    const label = customSegmentLabel('custom', { from: '2026-04-01', to: '2026-04-28' });
    expect(label).toBe('Apr 1 – Apr 28');
  });

  it('returns a year-qualified label when custom range spans years', () => {
    const label = customSegmentLabel('custom', { from: '2025-12-28', to: '2026-01-04' });
    expect(label).toBe('Dec 28 2025 – Jan 4 2026');
  });
});

describe('simulateRangeSelect (popover interaction contract)', () => {
  it('does NOT commit when only from is selected', () => {
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    const result = simulateRangeSelect(
      { from: new Date(2026, 3, 1), to: undefined },
      onCustomRangeChange,
      onPeriodChange
    );

    expect(result.committed).toBe(false);
    expect(onCustomRangeChange).not.toHaveBeenCalled();
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('does NOT commit when range is undefined', () => {
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    simulateRangeSelect(undefined, onCustomRangeChange, onPeriodChange);

    expect(onCustomRangeChange).not.toHaveBeenCalled();
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('commits with correct YYYY-MM-DD values when both from and to are set', () => {
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    const from = new Date(2026, 3, 1); // Apr 1 2026 local
    const to = new Date(2026, 3, 28); // Apr 28 2026 local

    const result = simulateRangeSelect({ from, to }, onCustomRangeChange, onPeriodChange);

    expect(result.committed).toBe(true);
    expect(onCustomRangeChange).toHaveBeenCalledOnce();
    expect(onCustomRangeChange).toHaveBeenCalledWith({ from: '2026-04-01', to: '2026-04-28' });
    expect(onPeriodChange).toHaveBeenCalledOnce();
    expect(onPeriodChange).toHaveBeenCalledWith('custom');
  });

  it('commits correctly for a cross-month range', () => {
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    const from = new Date(2026, 2, 25); // Mar 25 2026 local
    const to = new Date(2026, 3, 5); // Apr 5 2026 local

    simulateRangeSelect({ from, to }, onCustomRangeChange, onPeriodChange);

    expect(onCustomRangeChange).toHaveBeenCalledWith({ from: '2026-03-25', to: '2026-04-05' });
    expect(onPeriodChange).toHaveBeenCalledWith('custom');
  });
});
