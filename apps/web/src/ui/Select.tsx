/**
 * Select — custom popover-based select primitive.
 *
 * Design decisions:
 * - Native <select> cannot be styled when its menu is open (macOS renders the
 *   system picker). This component replaces it with a button-triggered popover
 *   that uses the same design tokens as Card and Button.
 * - Trigger: rounded-lg border, gray-50/900 surface — matches Card surface.
 * - Popover: absolute-positioned panel with same border/radius/surface as trigger.
 * - Keyboard: ArrowDown/Up navigate options; Enter selects; Escape closes.
 * - Click outside: pointerdown listener on document to close.
 * - ARIA: trigger is role="combobox", panel is role="listbox", options are
 *   role="option" with aria-selected.
 * - Every color utility has a dark: counterpart.
 * - Border-radius family: always lg (never sm, never md).
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Optional width class, e.g. 'w-40'. Defaults to 'w-40'. */
  widthClass?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  widthClass = 'w-40',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    options.findIndex((o) => o.value === value)
  );

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  // Sync activeIndex when value changes externally
  useEffect(() => {
    setActiveIndex(options.findIndex((o) => o.value === value));
  }, [value, options]);

  // Close on outside pointerdown
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: PointerEvent) {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [open]);

  // Focus the active option when the panel opens
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      const clampedIdx = idx >= 0 ? idx : 0;
      setActiveIndex(clampedIdx);
      // Defer to allow the DOM to settle after mount
      requestAnimationFrame(() => {
        optionRefs.current[clampedIdx]?.focus();
      });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTriggerClick() {
    setOpen((prev) => !prev);
  }

  function handleOptionClick(optValue: T) {
    onChange(optValue);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(activeIndex + 1, options.length - 1);
      setActiveIndex(next);
      optionRefs.current[next]?.focus();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(activeIndex - 1, 0);
      setActiveIndex(prev);
      optionRefs.current[prev]?.focus();
      return;
    }

    if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  function handleOptionKeyDown(e: React.KeyboardEvent, optValue: T) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOptionClick(optValue);
    } else {
      handleKeyDown(e);
    }
  }

  return (
    <div className={['relative', widthClass, className].filter(Boolean).join(' ')}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-controls="select-panel"
        onClick={handleTriggerClick}
        onKeyDown={handleKeyDown}
        className={[
          'inline-flex w-full items-center justify-between gap-2',
          'rounded-lg border border-gray-200 dark:border-gray-800',
          'bg-gray-50 dark:bg-gray-900',
          'px-3 py-2',
          'text-sm text-gray-900 dark:text-gray-100',
          // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
          'hover:bg-gray-100 dark:hover:bg-gray-800',
          // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
          'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
          'transition-colors',
        ].join(' ')}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown
          className={[
            'h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400 transition-transform duration-150',
            open ? 'rotate-180' : '',
          ].join(' ')}
          aria-hidden="true"
        />
      </button>

      {/* Popover panel */}
      {open && (
        <div
          ref={panelRef}
          id="select-panel"
          role="listbox"
          aria-label={ariaLabel}
          className={[
            'absolute left-0 top-full z-30 mt-1 min-w-full',
            'rounded-lg border border-gray-200 dark:border-gray-800',
            'bg-gray-50 dark:bg-gray-900',
            'shadow-sm',
            'py-1',
          ].join(' ')}
        >
          {options.map((option, idx) => {
            const isSelected = option.value === value;
            const isActive = idx === activeIndex;
            return (
              <button
                key={option.value}
                ref={(el) => { optionRefs.current[idx] = el; }}
                type="button"
                role="option"
                aria-selected={isSelected}
                tabIndex={isActive ? 0 : -1}
                onClick={() => handleOptionClick(option.value)}
                onKeyDown={(e) => handleOptionKeyDown(e, option.value)}
                className={[
                  'flex w-full items-center px-3 py-2',
                  'text-sm transition-colors',
                  // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                  'hover:bg-gray-100 dark:hover:bg-gray-800',
                  'focus:outline-none',
                  // design-lint-disable dark-mode-pairs: compound modifier prefix (focus:) hides the dark pairing from naive line scan
                  'focus:bg-gray-100 dark:focus:bg-gray-800',
                  isSelected
                    ? 'font-medium text-gray-950 dark:text-white'
                    : 'text-gray-700 dark:text-gray-300',
                ].join(' ')}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
