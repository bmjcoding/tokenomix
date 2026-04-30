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
 * - Outer container uses role="radiogroup" with aria-label per WAI-ARIA APG radio group
 *   pattern; each button carries role="radio" + aria-checked for state announcement.
 * - Roving tabindex: active option has tabIndex=0, others tabIndex=-1. Arrow keys move
 *   focus within the group (ArrowRight/ArrowDown → next; ArrowLeft/ArrowUp → prev;
 *   Home → first; End → last). Wraps at boundaries.
 * - Pipe dividers interleaved between non-active adjacent segments for visual separation.
 *   Divider is hidden whenever either neighbour is active so the blue pill stands out.
 */

import { Fragment, useRef } from 'react';

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
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
    const last = PERIOD_OPTIONS.length - 1;
    let nextIdx: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIdx = currentIdx === last ? 0 : currentIdx + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIdx = currentIdx === 0 ? last : currentIdx - 1;
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextOpt = PERIOD_OPTIONS[nextIdx];
    if (nextOpt) {
      onChange(nextOpt.value);
      buttonRefs.current.get(nextOpt.value)?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
    >
      {PERIOD_OPTIONS.map((opt, idx) => {
        const active = opt.value === value;
        const next = PERIOD_OPTIONS[idx + 1];
        const showDivider = next !== undefined && !active && next.value !== value;
        return (
          <Fragment key={opt.value}>
            {/* biome-ignore lint/a11y/useSemanticElements: roving-tabindex radio group — <input type="radio"> requires a <form>/<fieldset> and resets pill styling; <button role="radio"> is the standard APG pattern for custom segmented controls */}
            <button
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(opt.value)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              ref={(el) => {
                if (el) {
                  buttonRefs.current.set(opt.value, el);
                } else {
                  buttonRefs.current.delete(opt.value);
                }
              }}
              className={[
                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-white shadow-sm dark:bg-primary-light dark:text-gray-950'
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200',
              ].join(' ')}
            >
              {opt.label}
            </button>
            {showDivider && (
              <span
                aria-hidden="true"
                className="select-none px-1 text-gray-300 dark:text-gray-600"
              >
                |
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
