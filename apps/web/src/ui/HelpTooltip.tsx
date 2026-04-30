/**
 * HelpTooltip - small hover/focus explanation affordance.
 *
 * Used on dense dashboard metrics where the number needs interpretation. The
 * content is hidden until hover/focus so cards stay scan-friendly while still
 * answering "why is this here?" for users who do not know the optimization
 * model yet.
 */

import { HelpCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';

interface HelpTooltipProps {
  label: string;
  children: ReactNode;
  align?: 'left' | 'right';
}

export function HelpTooltip({ label, children, align = 'left' }: HelpTooltipProps) {
  const id = useId();

  return (
    <span className="relative inline-flex group/help">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className={[
          'inline-flex h-5 w-5 items-center justify-center rounded-full',
          'text-gray-400 dark:text-gray-500',
          'hover:text-gray-700 dark:hover:text-gray-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
          'focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      >
        <HelpCircle size={13} aria-hidden="true" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={[
          `pointer-events-none absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-50 mt-2 w-80 max-w-[min(20rem,calc(100vw-3rem))]`,
          'rounded-lg border border-gray-200 dark:border-gray-700',
          'bg-white dark:bg-gray-950 px-3 py-2 text-left',
          'text-xs font-normal normal-case leading-relaxed tracking-normal',
          'text-gray-700 dark:text-gray-200 shadow-sm',
          'opacity-0 transition-opacity duration-150',
          'group-hover/help:opacity-100 group-focus-within/help:opacity-100',
        ].join(' ')}
      >
        {children}
      </span>
    </span>
  );
}
