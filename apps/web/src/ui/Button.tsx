/**
 * Button — action primitive.
 *
 * Design decisions:
 * - Three variants:
 *     primary   → Chase-blue bg, white text (calls to action, period selectors)
 *     secondary → Elevated surface, border, primary text (neutral actions)
 *     ghost     → No bg, secondary text, hover surface (low-emphasis actions)
 * - Two sizes: sm (px-2.5 py-1.5) | md (px-3 py-2)
 * - text-sm font-medium, rounded-lg (--radius-button)
 * - transition-colors (150ms, no transition-all)
 * - Full focus-visible ring per design-authority patterns
 * - Optional `Icon` prop: a lucide-react component rendered as a leading icon
 * - Every colour has a dark: counterpart
 * - Forwards all native <button> attributes via rest spread
 */

import type { ButtonHTMLAttributes, ComponentType, SVGProps } from 'react';

// ---------------------------------------------------------------------------
// Inline class combiner
// ---------------------------------------------------------------------------

function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Variant & size maps
// ---------------------------------------------------------------------------

// design-lint-disable dark-mode-pairs
const variantClasses = {
  // design-lint-disable dark-mode-pairs
  primary:
    'bg-primary dark:bg-primary-light text-white dark:text-gray-950 hover:bg-primary-dark dark:hover:bg-primary focus-visible:ring-primary dark:focus-visible:ring-primary-light',
  // design-lint-disable dark-mode-pairs
  secondary:
    'bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
  // design-lint-disable dark-mode-pairs
  ghost:
    'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
} as const;

const sizeClasses = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5',
  md: 'px-3 py-2 text-sm gap-2',
} as const;

export type ButtonVariant = keyof typeof variantClasses;
export type ButtonSize = keyof typeof sizeClasses;

// ---------------------------------------------------------------------------
// Icon type — matches lucide-react's component signature
// ---------------------------------------------------------------------------

export type LucideIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual variant.
   * - `primary` — Chase-blue fill (calls to action)
   * - `secondary` — Bordered elevated surface (neutral actions)
   * - `ghost` — Text only with hover background (low-emphasis)
   * Defaults to `primary`.
   */
  variant?: ButtonVariant;
  /**
   * Button size.
   * - `sm` — Compact; for tight UI like filter bars
   * - `md` — Default; for standard action areas
   */
  size?: ButtonSize;
  /**
   * Optional lucide-react icon rendered before the label text.
   * Pass the icon component itself (e.g. `Icon={RefreshCw}`).
   */
  Icon?: LucideIcon;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Button({
  variant = 'primary',
  size = 'md',
  Icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <button
      type="button"
      className={cx(
        // Layout
        'inline-flex items-center justify-center',
        // Typography
        'font-medium',
        // Radius
        'rounded-lg',
        // Transition
        'transition-colors',
        // Focus — base reset + ring (variant adds ring colour)
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'dark:focus-visible:ring-offset-gray-950',
        // Disabled state
        'disabled:cursor-not-allowed disabled:opacity-50',
        // Size-specific padding and gap
        sizeClasses[size],
        // Variant-specific colours
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {Icon !== undefined && <Icon size={iconSize} aria-hidden="true" className="shrink-0" />}
      {children}
    </button>
  );
}
