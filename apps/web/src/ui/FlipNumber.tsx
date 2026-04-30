/**
 * FlipNumber — animated flip transition between numeric values.
 *
 * Wraps @number-flow/react. Use for live-updating counters in the hero or KPI
 * cards. When the `value` prop changes (e.g. on each SSE-driven MetricSummary
 * refresh), digits animate from their previous position to the new one using
 * the library's built-in slot-machine flip animation.
 *
 * Key behaviours:
 * - Animation is governed by the MotionPreferenceProvider context:
 *   - `'system'`  → `respectMotionPreference={true}` (OS pref decides;
 *                    existing default behaviour).
 *   - `'reduced'` → `animated={false}` — all transitions are instant
 *                    regardless of OS or NumberFlow defaults.
 *   - `'full'`    → `respectMotionPreference={false}` — always animates,
 *                    overriding any OS prefers-reduced-motion setting.
 *   Callers do NOT pass `respectMotionPreference`; it is computed internally.
 * - `format` accepts a `Format` object (Intl.NumberFormatOptions minus
 *   scientific/engineering notation) forwarded directly to NumberFlow.
 * - `className` forwards Tailwind utility classes to the NumberFlow root
 *   element so the existing text-sizing, font-weight, tabular-nums, and color
 *   utilities carry through without layout changes.
 * - The component renders as an inline element (NumberFlow renders
 *   <number-flow-react>, a custom element). Callers that previously used a
 *   block-level `<p>` may need to keep the `<p>` wrapper as a layout container
 *   and place FlipNumber inside it, or switch to `<span>` — see HeroSpend.tsx.
 * - HTML attributes (including aria-hidden, aria-label, role, etc.) are
 *   forwarded to the NumberFlow root element via rest spread.
 */

import NumberFlow, { type Format, type NumberFlowProps } from '@number-flow/react';
import { useMotionPreference } from '../providers/MotionPreferenceProvider.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type { Format };

export interface FlipNumberProps
  extends Omit<
    NumberFlowProps,
    'value' | 'format' | 'prefix' | 'locales' | 'respectMotionPreference'
  > {
  /** The numeric value to display (and animate to when it changes). */
  value: number;
  /**
   * Number format options forwarded to NumberFlow's internal Intl formatter.
   * Matches Intl.NumberFormatOptions except scientific/engineering notations
   * are excluded (NumberFlow cannot animate those).
   * Example: `{ style: 'currency', currency: 'USD', minimumFractionDigits: 2 }`.
   * Omit for plain integer locale grouping (e.g. "28,478,431").
   */
  format?: Format;
  /**
   * String rendered before the formatted number (e.g. a currency symbol when
   * not using Intl currency style). Optional — prefer `format.style='currency'`
   * where possible so NumberFlow can animate the digits including the prefix.
   */
  prefix?: string;
  /**
   * BCP 47 locale tag(s) passed to the Intl formatter.
   * Defaults to 'en-US'.
   */
  locales?: string | string[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FlipNumber({ value, format, prefix, locales = 'en-US', ...rest }: FlipNumberProps) {
  const { motionPreference } = useMotionPreference();

  const optionalProps: Record<string, unknown> = {};
  if (format !== undefined) optionalProps.format = format;
  if (prefix !== undefined) optionalProps.prefix = prefix;

  // Compute animation props based on user motion preference.
  // 'reduced' → instant: animated=false overrides all animation
  // 'full'    → always animate: respectMotionPreference=false ignores OS pref
  // 'system'  → defer to OS: respectMotionPreference=true (default behaviour)
  const motionProps: Record<string, unknown> = {};
  if (motionPreference === 'reduced') {
    motionProps.animated = false;
  } else if (motionPreference === 'full') {
    motionProps.respectMotionPreference = false;
  } else {
    // 'system'
    motionProps.respectMotionPreference = true;
  }

  return (
    <NumberFlow
      value={value}
      locales={locales}
      {...(motionProps as { animated?: boolean; respectMotionPreference?: boolean })}
      {...(optionalProps as { format?: Format; prefix?: string })}
      {...rest}
    />
  );
}
