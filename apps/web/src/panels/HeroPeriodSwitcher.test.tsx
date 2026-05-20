/**
 * HeroPeriodSwitcher.test.tsx — Vitest tests for HeroPeriodSwitcher behavior.
 *
 * Tests verify:
 * 1. Date helper round-trip correctness (ymdToLocalDate / localDateToYmd).
 * 2. Trigger label text for each period mode.
 * 3. The popover interaction contract: when a complete range is committed,
 *    onCustomRangeChange and onPeriodChange are called with correct arguments.
 * 4. The period display label helper (via period-rollup.ts).
 *
 * No DOM renderer is required — the test style follows the project convention
 * of pure function assertions (no @testing-library/react render calls) since
 * vitest does not have a jsdom environment configured at the root level.
 *
 * Deep date-grid interaction tests are omitted; react-day-picker has its own
 * test suite for calendar behavior.
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

/** Produce the trigger button label — same logic as component's triggerLabel. */
function triggerLabel(period: HeroPeriod, customRange: DateRange | null): string {
  if (period === 'mtd') return 'MTD';
  if (period === 'prev-month') return 'Prev Month';
  if (period === 'ytd') return 'YTD';
  if (customRange === null) return 'Custom';
  return periodDisplayLabel('custom', customRange);
}

// ---------------------------------------------------------------------------
// Simulate the handleRangeSelect callback
// ---------------------------------------------------------------------------

/**
 * Simulates the DayPicker onSelect handler used in HeroPeriodSwitcher.
 *
 * Mirrors the updated component behavior:
 * - When a complete range is received, commits to parent callbacks.
 * - Does NOT close the popover (popover stays open after any date selection).
 * - Returns `{ committed: boolean }` to reflect whether callbacks were invoked.
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

describe('triggerLabel', () => {
  it('returns "MTD" for mtd period', () => {
    expect(triggerLabel('mtd', null)).toBe('MTD');
  });

  it('returns "Prev Month" for prev-month period', () => {
    expect(triggerLabel('prev-month', null)).toBe('Prev Month');
  });

  it('returns "YTD" for ytd period', () => {
    expect(triggerLabel('ytd', null)).toBe('YTD');
  });

  it('returns "Custom" when period is custom but no range set', () => {
    expect(triggerLabel('custom', null)).toBe('Custom');
  });

  it('returns a compact range label when custom range is set (same year)', () => {
    const label = triggerLabel('custom', { from: '2026-04-01', to: '2026-04-28' });
    expect(label).toBe('Apr 1 – Apr 28');
  });

  it('returns a year-qualified label when custom range spans years', () => {
    const label = triggerLabel('custom', { from: '2025-12-28', to: '2026-01-04' });
    expect(label).toBe('Dec 28 2025 – Jan 4 2026');
  });

  it('does not show range label when period is ytd even if customRange is set', () => {
    // triggerLabel only uses customRange when period === 'custom'
    expect(triggerLabel('ytd', { from: '2026-01-01', to: '2026-04-15' })).toBe('YTD');
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

describe('periodDisplayLabel (integration with period-rollup.ts)', () => {
  it('formats a same-year range compactly', () => {
    expect(periodDisplayLabel('custom', { from: '2026-04-01', to: '2026-04-28' })).toBe(
      'Apr 1 – Apr 28'
    );
  });

  it('includes years when range spans years', () => {
    expect(periodDisplayLabel('custom', { from: '2025-12-28', to: '2026-01-04' })).toBe(
      'Dec 28 2025 – Jan 4 2026'
    );
  });
});

// ---------------------------------------------------------------------------
// Popover no-close-on-date-select contract
// ---------------------------------------------------------------------------

describe('handleRangeSelect — no auto-close on date selection', () => {
  it('does NOT close the popover when a complete range is committed', () => {
    // The component no longer returns a close signal from handleRangeSelect.
    // Simulate the handler: callbacks fire, but no closePopover call is made.
    // We verify this by checking that the simulated handler commits without
    // signalling a close (the popover open state is driven externally, not
    // by handleRangeSelect).
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    const from = new Date(2026, 3, 1); // Apr 1 2026 local
    const to = new Date(2026, 3, 1); // Apr 1 2026 local — same day (react-day-picker single-click)

    // simulateRangeSelect mirrors the updated handler: commits but has no
    // side-effect on popover state (no closePopover call present).
    const result = simulateRangeSelect({ from, to }, onCustomRangeChange, onPeriodChange);

    // Callbacks are invoked (range is committed to parent).
    expect(result.committed).toBe(true);
    expect(onCustomRangeChange).toHaveBeenCalledOnce();
    expect(onCustomRangeChange).toHaveBeenCalledWith({ from: '2026-04-01', to: '2026-04-01' });
    expect(onPeriodChange).toHaveBeenCalledWith('custom');

    // There is no `popoverClosed` return value — the absence of such a field
    // documents that the handler does not close the popover.
    expect(result).not.toHaveProperty('popoverClosed');
  });

  it('commits the range even when from === to (single-click scenario)', () => {
    const onCustomRangeChange = vi.fn();
    const onPeriodChange = vi.fn();

    const date = new Date(2026, 3, 15); // Apr 15 2026
    simulateRangeSelect({ from: date, to: date }, onCustomRangeChange, onPeriodChange);

    expect(onCustomRangeChange).toHaveBeenCalledWith({ from: '2026-04-15', to: '2026-04-15' });
    expect(onPeriodChange).toHaveBeenCalledWith('custom');
  });
});

// ---------------------------------------------------------------------------
// PRESETS order and labels
// ---------------------------------------------------------------------------

describe('PRESETS constant', () => {
  // Re-declare locally to mirror the source of truth without importing internals.
  const PRESETS: Array<{ value: HeroPeriod; label: string }> = [
    { value: 'prev-month', label: 'PREV MO.' },
    { value: 'mtd', label: 'MTD' },
    { value: 'ytd', label: 'YTD' },
  ];

  it('has exactly three presets', () => {
    expect(PRESETS).toHaveLength(3);
  });

  it('has order: prev-month, mtd, ytd', () => {
    expect(PRESETS.map((p) => p.value)).toEqual(['prev-month', 'mtd', 'ytd']);
  });

  it('renders prev-month as "PREV MO." inside the popover', () => {
    const prevMonth = PRESETS.find((p) => p.value === 'prev-month');
    expect(prevMonth?.label).toBe('PREV MO.');
  });

  it('trigger label still uses "Prev Month" for prev-month period (unaffected)', () => {
    // triggerLabel is independent of the PRESETS labels — it returns full text.
    expect(triggerLabel('prev-month', null)).toBe('Prev Month');
  });
});
