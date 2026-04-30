/**
 * PeriodSwitcher — segmented-pill toggle for dashboard time period.
 *
 * Design decisions:
 * - Pure controlled component: no internal state. Callers manage `value`.
 * - `DashboardPeriod` type is exported for downstream consumers (AreaChartPanel,
 *   OverviewPage). These are client-only literals; they do not extend SinceOption.
 * - Active segment: blue fill with shadow; dark mode uses a lighter blue shade.
 * - Inactive segments: muted text with hover state, no fill.
 * - Plain <button> elements inside a shared rounded shell so segments sit flush
 *   without inter-button gaps (avoids external rounding artifacts from Button primitive).
 * - Outer group uses role="group" with aria-label per ARIA APG toggle button pattern;
 *   each button carries aria-pressed for state announcement.
 */

// ---------------------------------------------------------------------------
// Canonical type — imported by AreaChartPanel (subtask 7) and OverviewPage (subtask 9)
// ---------------------------------------------------------------------------

export type DashboardPeriod = '24h' | '7d' | '30d' | 'ytd';

// ---------------------------------------------------------------------------
// Option config
// ---------------------------------------------------------------------------

const PERIOD_OPTIONS: { value: DashboardPeriod; label: string }[] = [
  { value: '24h', label: '24HR' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: 'ytd', label: 'YTD' },
];

// ---------------------------------------------------------------------------
// PeriodSwitcher
// ---------------------------------------------------------------------------

interface PeriodSwitcherProps {
  value: DashboardPeriod;
  onChange: (next: DashboardPeriod) => void;
}

export function PeriodSwitcher({ value, onChange }: PeriodSwitcherProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: segmented UI control, not a form input — matches AreaChartPanel field-toggle convention; <fieldset> imposes default form styling. Future a11y pass may migrate both together.
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
    >
      {PERIOD_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={[
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-white shadow-sm dark:bg-primary-light dark:text-gray-950'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
