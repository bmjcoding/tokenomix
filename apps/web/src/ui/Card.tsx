/**
 * Card — surface primitive.
 *
 * Design decisions:
 * - rounded-2xl (--radius-card) to match existing dashboard card pattern
 * - border-only separation: no shadow beyond shadow-sm (and shadow-sm is not
 *   applied here — Card is a plain surface, not an elevated panel)
 * - bg-gray-50 / dark:bg-gray-900 as the canonical card surface
 * - p-5 default padding (can be overridden via className)
 * - `as` prop lets callers choose <section> or <article> semantics where
 *   meaningful, defaulting to <div>
 * - Accepts `className` for caller composition; forwarded via string join
 */

import type { ElementType, HTMLAttributes } from 'react';

// ---------------------------------------------------------------------------
// Inline class combiner (no external deps)
// ---------------------------------------------------------------------------

function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The HTML element to render as.
   * Use 'section' or 'article' when the card represents a document landmark.
   * Defaults to 'div'.
   */
  as?: 'div' | 'section' | 'article' | 'aside';
  /**
   * Extra Tailwind classes; merged with the base card classes.
   * Override padding by passing e.g. className="p-6".
   */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Card({ as, className, children, ...rest }: CardProps) {
  // Cast to a generic component — we control the narrow type union above so
  // this is safe and avoids complex ElementType generics.
  const Tag = (as ?? 'div') as ElementType;

  return (
    <Tag
      className={cx(
        // Surface colour — light and dark.
        // Per existing dashboard convention: raw gray-50/900 are used in place of the
        // semantic bg-surface/bg-surface-dark tokens because the numeric OKLCH
        // values are identical in this project's @theme block. This keeps Card
        // consistent with direct Tailwind class usage across the codebase while
        // avoiding an implicit dependency on the CSS variable indirection layer.
        'bg-gray-50 dark:bg-gray-900',
        // Border — the only visual separator; no shadow
        'border border-gray-200 dark:border-gray-800',
        // Radius — existing dashboard card rule: always rounded-2xl
        'rounded-2xl',
        // Default padding — callers can override by including p-* in className
        'p-5',
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
