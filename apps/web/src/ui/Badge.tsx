/**
 * Badge — status pill primitive.
 *
 * Design decisions:
 * - Three variants only (constraint from subtask spec):
 *     default  → neutral gray surface, secondary text
 *     accent   → Chase-blue tinted fill, primary blue text (active states)
 *     muted    → low-emphasis label, no background
 * - rounded-full for pill shape
 * - px-2 py-0.5 text-xs font-medium per spec
 * - Every colour has a dark: counterpart (dark-mode rule enforced)
 * - Accepts className for caller composition
 * - Renders as <span> by default (inline, non-interactive)
 */

import type { HTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Inline class combiner
// ---------------------------------------------------------------------------

function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Variant map
// ---------------------------------------------------------------------------

const variantClasses = {
  /** Neutral — achromatic gray surface, secondary text. */
  default: 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400',
  /** Accent — Chase-blue tinted fill, primary blue text. */
  accent: 'bg-primary/10 dark:bg-primary-light/10 text-primary dark:text-primary-light',
  /** Muted — no background, muted text both modes. */
  muted: 'text-gray-500 dark:text-gray-500',
} as const;

export type BadgeVariant = keyof typeof variantClasses;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Visual variant.
   * - `default` (neutral gray) — period labels, model family tags
   * - `accent` (Chase blue) — active state, primary badges
   * - `muted` (low-emphasis) — secondary information labels
   * Defaults to `default`.
   */
  variant?: BadgeVariant;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Badge({ variant = 'default', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        // Base pill shape
        'inline-flex items-center rounded-full px-2 py-0.5',
        // Typography
        'text-xs font-medium',
        // Variant colour
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
