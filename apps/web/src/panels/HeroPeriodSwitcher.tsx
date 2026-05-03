/**
 * HeroPeriodSwitcher — single calendar pill trigger + popover date-range picker.
 *
 * Design decisions:
 * - Single pill button trigger showing active period label + calendar icon.
 * - Popover contains:
 *   1. Custom header row (prev/next month chevrons + "Month YYYY" label).
 *   2. Quick preset pills (MTD, Prev Month, YTD) — selecting a preset commits
 *      and closes the popover immediately.
 *   3. react-day-picker in range mode with comprehensive classNames overrides
 *      for full dark-mode correctness (no external CSS imported).
 *   4. Helper text footer.
 * - DayPicker's built-in nav and caption are hidden; we drive displayed month
 *   via the `month` prop + `onMonthChange`.
 * - Future dates are disabled.
 * - Outside-click (mousedown + touchstart), Escape key, and range commit all
 *   close the popover and return focus to the trigger button.
 * - When period === 'custom' and customRange === null (e.g., period was set to
 *   custom by some other means before a range was ever picked), the displayed
 *   month initialises to the current month on open.
 */

import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Fragment, type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { DateRange as DayPickerDateRange } from 'react-day-picker';
import { DayPicker } from 'react-day-picker';
import type { DateRange, HeroPeriod } from '../lib/period-rollup.js';
import { periodDisplayLabel } from '../lib/period-rollup.js';

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

/** Produce the trigger button label for the active period. */
function triggerLabel(period: HeroPeriod, customRange: DateRange | null): string {
  if (period === 'mtd') return 'MTD';
  if (period === 'prev-month') return 'Prev Month';
  if (period === 'ytd') return 'YTD';
  // custom
  if (customRange === null) return 'Custom';
  return periodDisplayLabel('custom', customRange);
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

/** Format a Date as "Month YYYY" for the popover header. */
function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Class name constants
//
// Extracted at module scope so design-lint-disable comments can appear on the
// line directly preceding each constant (the linter skips the line following
// a disable comment). These strings carry both light and dark color pairs on
// the same physical line.
//
// Where the linter fires despite correct pairing: hover-state light classes
// are paired with dark:hover: counterparts, but the grep looks for bare
// dark:bg-/dark:ring- prefixes, not the hover-prefixed forms. Those cases are
// suppressed with the per-line disable below; the dark-mode intent is intact.
// ---------------------------------------------------------------------------

// design-lint-disable dark-mode-pairs
const DAY_BASE =
  'flex h-9 w-9 items-center justify-center rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer';

const rdpClassNames: Partial<Record<string, string>> = {
  // Layout wrappers
  root: 'w-full',
  months: 'w-full',
  month: 'w-full',
  // Hide built-in caption + nav — we render our own header above the grid
  month_caption: 'hidden',
  nav: 'hidden',
  month_grid: 'w-full border-collapse',
  // Week header
  weekdays: 'flex w-full mb-1',
  weekday: 'flex-1 text-center text-xs font-medium text-gray-500 dark:text-gray-500 py-1',
  // Week rows
  weeks: 'w-full',
  week: 'flex w-full',
  // Day cell container (<td>)
  day: 'flex-1 flex items-center justify-center p-0',
  // Clickable day button base
  day_button: DAY_BASE,
  // Modifier states — all on single lines so light+dark pairs coexist.
  today:
    'ring-1 ring-primary/40 dark:ring-primary-light/40 text-gray-900 dark:text-white rounded-lg',
  selected:
    'bg-primary text-white dark:bg-primary-light dark:text-gray-950 hover:bg-primary dark:hover:bg-primary-light',
  range_start:
    'bg-primary text-white rounded-l-lg rounded-r-none dark:bg-primary-light dark:text-gray-950 hover:bg-primary dark:hover:bg-primary-light',
  range_middle:
    'bg-primary/15 text-gray-900 dark:bg-primary-light/15 dark:text-gray-100 rounded-none hover:bg-primary/25 dark:hover:bg-primary-light/25',
  range_end:
    'bg-primary text-white rounded-r-lg rounded-l-none dark:bg-primary-light dark:text-gray-950 hover:bg-primary dark:hover:bg-primary-light',
  outside: 'text-gray-400 dark:text-gray-700 hover:text-gray-500 dark:hover:text-gray-600',
  disabled:
    'text-gray-300 dark:text-gray-800 cursor-not-allowed hover:bg-transparent hover:text-gray-300 dark:hover:text-gray-800',
  hidden: 'invisible',
  focused: 'outline-none ring-2 ring-primary/60 dark:ring-primary-light/60',
};

// design-lint-disable dark-mode-pairs
const NAV_BTN_CLS =
  'inline-flex h-6 w-6 items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:focus-visible:ring-primary-light';

// design-lint-disable dark-mode-pairs
const PRESET_INACTIVE_CLS =
  'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white';

// design-lint-disable dark-mode-pairs
// focus-visible:ring-gray-900 is paired with dark:focus-visible:ring-white/70.
// "white" is not a COLOR_NAMES token so the linter would need "dark:ring-gray-" to
// match; the actual dark token uses white/opacity instead of a gray step.
const TRIGGER_FOCUS_CLS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-900 dark:focus-visible:ring-white/70';

// Weekday short labels (2-letter, Sun-first)
const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// Preset definitions — order: PREV MO. | MTD | YTD
const PRESETS: Array<{ value: HeroPeriod; label: string }> = [
  { value: 'prev-month', label: 'PREV MO.' },
  { value: 'mtd', label: 'MTD' },
  { value: 'ytd', label: 'YTD' },
];

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
  // The month currently displayed in the calendar.
  const [displayedMonth, setDisplayedMonth] = useState<Date>(() => new Date());

  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // ── Open / close helpers ────────────────────────────────────────────────

  const openPopover = useCallback(() => {
    // Initialise displayed month: use start of custom range if set, else current month.
    const initMonth =
      period === 'custom' && customRange !== null ? ymdToLocalDate(customRange.from) : new Date();
    setDisplayedMonth(new Date(initMonth.getFullYear(), initMonth.getMonth(), 1));

    // Seed pending range from active custom range if set.
    if (period === 'custom' && customRange !== null) {
      setPendingRange({
        from: ymdToLocalDate(customRange.from),
        to: ymdToLocalDate(customRange.to),
      });
    } else {
      setPendingRange(undefined);
    }

    setPopoverOpen(true);
  }, [period, customRange]);

  const closePopover = useCallback((returnFocus: boolean) => {
    setPopoverOpen(false);
    setPendingRange(undefined);
    if (returnFocus) {
      setTimeout(() => {
        triggerRef.current?.focus();
      }, 0);
    }
  }, []);

  // ── Trigger button click ─────────────────────────────────────────────────

  function handleTriggerClick() {
    if (popoverOpen) {
      closePopover(true);
    } else {
      openPopover();
    }
  }

  function handleTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleTriggerClick();
    }
  }

  // ── Preset selection ─────────────────────────────────────────────────────

  function handlePresetClick(preset: HeroPeriod) {
    onPeriodChange(preset);
    closePopover(true);
  }

  // ── Month navigation ─────────────────────────────────────────────────────

  function handlePrevMonth() {
    setDisplayedMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  }

  function handleNextMonth() {
    setDisplayedMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  }

  // ── DayPicker range selection ────────────────────────────────────────────

  function handleRangeSelect(range: DayPickerDateRange | undefined) {
    setPendingRange(range);
    if (range?.from && range?.to) {
      // Commit on every complete-range update so the trigger label stays in sync.
      // Do NOT close the popover — the user explicitly dismisses via outside-click,
      // Escape, or by clicking the trigger again. This lets them adjust the range
      // freely without the popover dying on the first click (react-day-picker in
      // range mode auto-fills to=from on a single click).
      onCustomRangeChange({
        from: localDateToYmd(range.from),
        to: localDateToYmd(range.to),
      });
      onPeriodChange('custom');
    }
  }

  // ── Click-outside + Escape dismissal ────────────────────────────────────

  useEffect(() => {
    if (!popoverOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
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

  // ── Helper text ──────────────────────────────────────────────────────────

  function helperText(): string {
    if (!pendingRange?.from) return 'Pick a start date';
    if (!pendingRange.to) return 'Pick an end date';
    return '';
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const activeLabel = triggerLabel(period, customRange);
  const today = new Date();
  const disabledMatcher = { after: today };

  return (
    <div className="relative inline-flex">
      {/* Single pill trigger button */}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Pick date range"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        className={[
          'inline-flex items-center gap-2 h-10 px-3 rounded-xl border transition-colors shadow-sm backdrop-blur-md',
          TRIGGER_FOCUS_CLS,
          popoverOpen
            ? 'border-primary text-gray-900 dark:text-gray-100 bg-white dark:bg-black/35'
            : 'border-gray-200 dark:border-white/10 bg-white dark:bg-black/35 text-gray-700 dark:text-gray-400 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-900 dark:hover:bg-white/[0.06] dark:hover:border-white/20 dark:hover:text-gray-100',
        ].join(' ')}
      >
        <Calendar size={15} aria-hidden="true" className="shrink-0" />
        <span className="text-sm font-medium">{activeLabel}</span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={[
            'shrink-0 transition-transform text-gray-400 dark:text-gray-500',
            popoverOpen ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      {/* Popover */}
      {popoverOpen && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Pick a date range"
          aria-modal="true"
          tabIndex={-1}
          className="absolute top-full right-0 z-50 mt-2 w-[320px] rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-gray-950 shadow-sm backdrop-blur-md p-3 focus:outline-none"
        >
          {/* Header row — custom month nav */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              aria-label="Previous month"
              onClick={handlePrevMonth}
              className={NAV_BTN_CLS}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>

            <span className="text-sm font-semibold text-gray-900 dark:text-white select-none">
              {formatMonthYear(displayedMonth)}
            </span>

            <button
              type="button"
              aria-label="Next month"
              onClick={handleNextMonth}
              className={NAV_BTN_CLS}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>

          {/* Quick preset pills */}
          <div className="flex items-stretch mb-2">
            {PRESETS.map(({ value, label }, idx) => {
              const isActive = period === value;
              const isLast = idx === PRESETS.length - 1;
              return (
                <Fragment key={value}>
                  <button
                    type="button"
                    onClick={() => handlePresetClick(value)}
                    className={[
                      'flex-1 h-7 rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary dark:focus-visible:ring-primary-light',
                      isActive
                        ? 'bg-primary text-white dark:bg-primary-light dark:text-gray-950'
                        : PRESET_INACTIVE_CLS,
                    ].join(' ')}
                  >
                    {label}
                  </button>
                  {!isLast && (
                    <span
                      aria-hidden="true"
                      className="select-none flex items-center px-1 text-gray-300 dark:text-gray-600"
                    >
                      |
                    </span>
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200 dark:border-white/10 my-2" />

          {/* Calendar grid */}
          <DayPicker
            mode="range"
            selected={pendingRange}
            onSelect={handleRangeSelect}
            numberOfMonths={1}
            month={displayedMonth}
            onMonthChange={setDisplayedMonth}
            disabled={disabledMatcher}
            formatters={{
              formatWeekdayName: (_date, options) => {
                const idx = _date.getDay();
                const lbl = WEEKDAY_LABELS[idx] ?? '';
                void options;
                return lbl;
              },
            }}
            classNames={rdpClassNames}
          />

          {/* Helper text */}
          {helperText() && (
            <p
              className="mt-2 text-center text-xs text-gray-500 dark:text-gray-500"
              aria-live="polite"
            >
              {helperText()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
