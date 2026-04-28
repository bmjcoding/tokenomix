/**
 * Section — layout wrapper with title and optional action slot.
 *
 * Design decisions:
 * - Semantic <section> wrapper; title rendered as <h2> (section heading level)
 * - Header row: title left-aligned, action slot right-aligned
 * - Title: text-base font-semibold text-gray-950 dark:text-white (per spec)
 * - Children rendered in a CSS grid with configurable cols and gap
 * - `cols` prop maps to Tailwind grid-cols-* classes; supports 1-4 responsive
 *   breakpoints for common dashboard layouts
 * - `gap` prop: sm | md | lg → gap-3 | gap-4 | gap-6
 * - Accepts `className` on the outer <section> for caller composition
 * - Does NOT render a Card surface — callers wrap content in <Card> as needed
 */

import { type HTMLAttributes, type ReactNode, useId } from 'react';

// ---------------------------------------------------------------------------
// Inline class combiner
// ---------------------------------------------------------------------------

function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Configuration maps
// ---------------------------------------------------------------------------

const gapClasses = {
  sm: 'gap-3',
  md: 'gap-4',
  lg: 'gap-6',
} as const;

/**
 * Column presets.
 * Values are Tailwind responsive grid-cols-* class strings.
 * Using explicit strings avoids JIT purging issues with dynamic construction.
 */
const colsClasses = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
} as const;

export type SectionGap = keyof typeof gapClasses;
export type SectionCols = keyof typeof colsClasses;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /**
   * Section heading text (rendered as <h2>).
   * Required for accessibility — screen readers use this as the landmark label.
   */
  title: string;
  /**
   * Optional slot rendered right-aligned in the header row.
   * Accepts Button(s), a toggle, or any React node.
   */
  action?: ReactNode;
  /**
   * Number of columns for the children grid.
   * Responsive presets — see `colsClasses` above.
   * Defaults to 1 (single column).
   */
  cols?: SectionCols;
  /**
   * Gap between grid cells.
   * - `sm` (gap-3)  — tight, for compact panels
   * - `md` (gap-4)  — default
   * - `lg` (gap-6)  — spacious, for major page sections
   */
  gap?: SectionGap;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Section({
  title,
  action,
  cols = 1,
  gap = 'md',
  className,
  children,
  ...rest
}: SectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cx('space-y-4', className)} {...rest}>
      {/* ── Header row ────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-base font-semibold text-gray-950 dark:text-white">
          {title}
        </h2>
        {action !== undefined && <div className="flex items-center gap-2 shrink-0">{action}</div>}
      </header>

      {/* ── Content grid ──────────────────────────────────────────────── */}
      <div className={cx('grid', colsClasses[cols], gapClasses[gap])}>{children}</div>
    </section>
  );
}
