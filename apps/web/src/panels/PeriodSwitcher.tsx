/**
 * PeriodSwitcher — pill-style segmented toggle for dashboard time period.
 *
 * Design decisions:
 * - Pure controlled component: no internal state. Callers manage `value`.
 * - `DashboardPeriod` type is exported for downstream consumers (AreaChartPanel,
 *   OverviewPage). These are client-only literals; they do not extend SinceOption.
 * - Active pill: primary variant Button (bg-primary, white text).
 * - Inactive pills: ghost variant Button (text-only, hover surface).
 * - Button variant / size follows the existing Button primitive to stay
 *   consistent with the 7d/30d/all toggle in AreaChartPanel.
 * - Outer group uses role="group" with aria-label per ARIA APG toggle button pattern.
 */

import { Button } from '../ui/Button.js';

// ---------------------------------------------------------------------------
// Canonical type — imported by AreaChartPanel (subtask 7) and OverviewPage (subtask 9)
// ---------------------------------------------------------------------------

export type DashboardPeriod = '24h' | '7d' | '30d' | 'ytd';

// ---------------------------------------------------------------------------
// Option config
// ---------------------------------------------------------------------------

const PERIOD_OPTIONS: { value: DashboardPeriod; label: string }[] = [
  { value: '24h', label: '24Hr' },
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
    // biome-ignore lint/a11y/useSemanticElements: role=group with aria-label is the canonical toolbar buttongroup pattern per ARIA APG; <fieldset> would impose default browser visual styling
    <div className="flex items-center gap-1" role="group" aria-label="Time period">
      {PERIOD_OPTIONS.map((opt) => (
        <Button
          key={opt.value}
          variant={value === opt.value ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}
