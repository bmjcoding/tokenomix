/**
 * PeriodSwitcher — segmented-pill toggle for dashboard time period.
 *
 * Design decisions:
 * - Pure controlled component: no internal state. Callers manage `value`.
 * - `DashboardPeriod` type is exported for downstream consumers (AreaChartPanel,
 *   OverviewPage). These are client-only literals; they do not extend SinceOption.
 * - Active segment: brand-blue `bg-primary text-white` (dark: `bg-primary-light text-gray-950`).
 *   This is intentional — in-content data toggles (PeriodSwitcher, AreaChartPanel field toggle)
 *   use the primary accent to signal interactive data affordances. The floating settings panel
 *   (Theme, Refresh, Motion) uses `accent="achromatic"` to avoid competing with these.
 * - Dividers: ALWAYS shown between adjacent options — the earlier conditional-hide predicate
 *   (`!active && next.value !== value`) caused the divider adjacent to the active pill to
 *   disappear, giving the impression the pill was "covering" them. Always-visible dividers
 *   pair correctly with the primary active background.
 * - Delegates keyboard nav and ARIA to `SegmentedToggle` primitive.
 */

import { SegmentedToggle } from '../ui/SegmentedToggle.js';

// ---------------------------------------------------------------------------
// Canonical type — imported by AreaChartPanel and OverviewPage
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
    <SegmentedToggle<DashboardPeriod>
      ariaLabel="Time range"
      options={PERIOD_OPTIONS}
      value={value}
      onChange={onChange}
      accent="primary"
    />
  );
}
