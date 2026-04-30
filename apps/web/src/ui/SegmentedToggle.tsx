/**
 * SegmentedToggle — reusable segmented-pill radiogroup primitive.
 *
 * Design decisions:
 * - Generic over option value type `T extends string` for type-safe usage.
 * - `role="radiogroup"` + per-option `role="radio"` with `aria-checked` per WAI-ARIA APG.
 * - Roving tabindex: active option tabIndex=0, others -1. Arrow keys move focus within the
 *   group (ArrowRight/Down → next, ArrowLeft/Up → prev, Home → first, End → last). Wraps.
 * - `accent` prop controls active-state colour:
 *   - `'primary'` (default): `bg-primary text-white dark:bg-primary-light dark:text-gray-950` —
 *     brand-blue, used for in-content data toggles (PeriodSwitcher, AreaChartPanel field toggle).
 *   - `'achromatic'`: `bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-950` —
 *     grayscale, used for floating settings controls (Theme, Refresh, Motion) so they do not
 *     compete with primary-coloured affordances elsewhere on the page.
 * - Dividers: ALWAYS rendered between adjacent options regardless of active state. The earlier
 *   conditional-hide logic caused the dividers to disappear when an active pill was adjacent,
 *   making the group look broken. Always-visible dividers work correctly with both accent modes.
 */

import { Fragment, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedToggleProps<T extends string> {
  /** Accessible label for the `role="radiogroup"` wrapper. */
  ariaLabel: string;
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Visual density. `md` is default. */
  size?: 'sm' | 'md';
  /**
   * Active-state colour mode.
   *
   * - `'primary'` (default): brand-blue active pill — use for in-content data toggles.
   * - `'achromatic'`: grayscale active pill — use for floating settings controls.
   */
  accent?: 'primary' | 'achromatic';
}

// ---------------------------------------------------------------------------
// Size tokens
// ---------------------------------------------------------------------------

const SIZE_CLASSES = {
  md: 'px-3 py-1.5 text-sm font-medium',
  sm: 'px-2 py-1 text-xs font-medium',
} as const;

// ---------------------------------------------------------------------------
// Active-state class maps
// ---------------------------------------------------------------------------

const ACTIVE_CLASSES = {
  primary: 'bg-primary text-white shadow-sm dark:bg-primary-light dark:text-gray-950',
  achromatic: 'bg-gray-900 text-white shadow-sm dark:bg-gray-100 dark:text-gray-950',
} as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SegmentedToggle<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  size = 'md',
  accent = 'primary',
}: SegmentedToggleProps<T>) {
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const sizeClass = SIZE_CLASSES[size];
  const activeClass = ACTIVE_CLASSES[accent];

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIdx: number) => {
    const last = options.length - 1;
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
    const nextOpt = options[nextIdx];
    if (nextOpt) {
      onChange(nextOpt.value);
      buttonRefs.current.get(nextOpt.value)?.focus();
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
    >
      {options.map((opt, idx) => {
        const active = opt.value === value;
        const isLast = idx === options.length - 1;

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
                'rounded-lg transition-colors',
                sizeClass,
                active
                  ? activeClass
                  : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200',
              ].join(' ')}
            >
              {opt.label}
            </button>
            {/* Always render dividers between adjacent options — no conditional hide. */}
            {!isLast && (
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
