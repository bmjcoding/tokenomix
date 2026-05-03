/**
 * HeroPeriodSwitcher — segmented period picker (MTD | Prev Month | YTD | Custom)
 * with a calendar popover for arbitrary date-range selection.
 *
 * Design decisions:
 * - Reuses the existing SegmentedToggle primitive (accent='primary', size='md').
 * - Calendar icon button opens a react-day-picker popover in range mode.
 * - Clicking any named segment (MTD/Prev Month/YTD) selects that period and
 *   closes the popover.
 * - Clicking Custom OR the calendar icon opens the popover.
 * - The popover dismisses on: outside click, Escape, touchstart outside.
 * - Focus returns to the calendar icon button on popover close (explicit close).
 * - "Custom" segment label shows the active range when set (e.g. "Apr 1 – Apr 28").
 * - The component owns only ephemeral UI state: popoverOpen and the in-flight
 *   half-selected range. Parent owns canonical period + customRange.
 * - react-day-picker CSS variables are overridden via the .rdp-root wrapper to
 *   integrate with the design token palette.
 */

import { Calendar } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange as DayPickerDateRange } from 'react-day-picker';
import { DayPicker } from 'react-day-picker';
import type { DateRange, HeroPeriod } from '../lib/period-rollup.js';
import { periodDisplayLabel } from '../lib/period-rollup.js';
import { SegmentedToggle } from '../ui/SegmentedToggle.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeroPeriodSwitcherProps {
  period: HeroPeriod;
  customRange: DateRange | null;
  onPeriodChange: (next: HeroPeriod) => void;
  onCustomRangeChange: (next: DateRange) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format YYYY-MM-DD as a compact label for the Custom segment button. */
function customSegmentLabel(customRange: DateRange | null): string {
  if (customRange === null) return 'Custom';
  const label = periodDisplayLabel('custom', customRange);
  // Keep the label short: if same-year it's already "Apr 1 – Apr 28" (compact)
  return label;
}

/** Convert a YYYY-MM-DD string to a local Date (midnight). */
function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Convert a local Date to YYYY-MM-DD. */
function localDateToYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// rdp CSS override classes
// These override react-day-picker's default CSS variables so the calendar
// integrates with the project's design token palette.
// design-lint-disable dark-mode-pairs: rdp-root is react-day-picker's internal
// class — its CSS variable overrides are not Tailwind utilities and therefore
// cannot carry dark: pairs. Dark-mode color adjustment is handled via separate
// .dark .rdp-override selector below.
const rdpOverrideStyle = {
  '--rdp-accent-color': 'oklch(0.49 0.16 255)',
  '--rdp-accent-background-color': 'oklch(0.95 0.02 255)',
  '--rdp-day_button-border-radius': '0.5rem',
} as import('react').CSSProperties;

// ---------------------------------------------------------------------------
// Segment options
// ---------------------------------------------------------------------------

// We build segment options dynamically inside the component so the Custom
// label can show the active range. Options are typed as SegmentedToggle's
// generic constraint (T extends string → HeroPeriod).

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HeroPeriodSwitcher({
  period,
  customRange,
  onPeriodChange,
  onCustomRangeChange,
}: HeroPeriodSwitcherProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  // In-flight half-selected range (user has picked `from` but not yet `to`).
  const [pendingRange, setPendingRange] = useState<DayPickerDateRange | undefined>(undefined);

  const popoverRef = useRef<HTMLDivElement>(null);
  const calendarBtnRef = useRef<HTMLButtonElement>(null);
  // Track whether the popover was explicitly closed (button/Escape) so we can
  // return focus correctly.
  const explicitCloseRef = useRef(false);

  // Build segment options with a dynamic Custom label.
  const segmentOptions: Array<{ value: HeroPeriod; label: string }> = [
    { value: 'mtd', label: 'MTD' },
    { value: 'prev-month', label: 'Prev Month' },
    { value: 'ytd', label: 'YTD' },
    { value: 'custom', label: customSegmentLabel(period === 'custom' ? customRange : null) },
  ];

  // ── Open / close helpers ────────────────────────────────────────────────

  const openPopover = useCallback(() => {
    explicitCloseRef.current = false;
    setPopoverOpen(true);
    // Seed the pending range from the currently active custom range (if any).
    if (customRange !== null) {
      setPendingRange({
        from: ymdToLocalDate(customRange.from),
        to: ymdToLocalDate(customRange.to),
      });
    } else {
      setPendingRange(undefined);
    }
  }, [customRange]);

  const closePopover = useCallback((returnFocus: boolean) => {
    explicitCloseRef.current = returnFocus;
    setPopoverOpen(false);
    setPendingRange(undefined);
    if (returnFocus) {
      // Defer to allow the popover to unmount before returning focus.
      setTimeout(() => {
        calendarBtnRef.current?.focus();
      }, 0);
    }
  }, []);

  // ── Segment change ──────────────────────────────────────────────────────

  function handleSegmentChange(next: HeroPeriod) {
    if (next === 'custom') {
      // Toggle: if already custom + popover not open, open it.
      openPopover();
    } else {
      onPeriodChange(next);
      closePopover(false);
    }
  }

  // ── Calendar icon button ────────────────────────────────────────────────

  function handleCalendarBtnClick() {
    if (popoverOpen) {
      closePopover(true);
    } else {
      openPopover();
    }
  }

  function handleCalendarBtnKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleCalendarBtnClick();
    }
  }

  // ── DayPicker range selection ──────────────────────────────────────────

  function handleRangeSelect(range: DayPickerDateRange | undefined) {
    setPendingRange(range);
    if (range?.from && range?.to) {
      // Complete selection — commit and close.
      const from = localDateToYmd(range.from);
      const to = localDateToYmd(range.to);
      onCustomRangeChange({ from, to });
      onPeriodChange('custom');
      closePopover(true);
    }
  }

  // ── Click-outside + Escape dismissal ───────────────────────────────────

  useEffect(() => {
    if (!popoverOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        calendarBtnRef.current &&
        !calendarBtnRef.current.contains(event.target as Node)
      ) {
        closePopover(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        closePopover(true);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popoverOpen, closePopover]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="relative inline-flex items-center gap-2">
      {/* Segmented period switcher */}
      <SegmentedToggle<HeroPeriod>
        ariaLabel="Select time period"
        options={segmentOptions}
        value={period}
        onChange={handleSegmentChange}
        size="md"
        accent="primary"
      />

      {/* Calendar icon button — opens popover for custom range */}
      <button
        ref={calendarBtnRef}
        type="button"
        aria-label="Pick custom date range"
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        onClick={handleCalendarBtnClick}
        onKeyDown={handleCalendarBtnKeyDown}
        className={[
          'inline-flex h-9 w-9 items-center justify-center rounded-lg',
          'border transition-colors',
          popoverOpen
            ? 'border-primary bg-primary/10 text-primary dark:border-primary-light dark:bg-primary-light/10 dark:text-primary-light'
            : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400',
          'hover:bg-gray-100 dark:hover:bg-gray-700',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:focus-visible:ring-primary-light',
          'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      >
        <Calendar size={16} aria-hidden="true" />
      </button>

      {/* Calendar popover */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Pick a date range"
          aria-modal="true"
          className={[
            'absolute top-full right-0 z-50 mt-2',
            'rounded-xl border border-gray-200 dark:border-gray-700',
            'bg-white dark:bg-gray-900',
            'p-3 shadow-lg',
            'focus:outline-none',
          ].join(' ')}
          // Allow the popover to receive focus for focus-trap purposes.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={-1}
        >
          {/* react-day-picker in range mode */}
          {/* design-lint-disable dark-mode-pairs: rdpOverrideStyle uses CSS custom
              properties not Tailwind utilities — dark mode is handled separately
              via CSS in index.css. */}
          <div style={rdpOverrideStyle}>
            <DayPicker
              mode="range"
              selected={pendingRange}
              onSelect={handleRangeSelect}
              numberOfMonths={2}
            />
          </div>

          {/* Inline helper text */}
          <p
            className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400"
            aria-live="polite"
          >
            {pendingRange?.from && !pendingRange.to ? 'Select end date' : 'Select start date'}
          </p>
        </div>
      )}
    </div>
  );
}
