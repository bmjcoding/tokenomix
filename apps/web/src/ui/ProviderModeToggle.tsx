import { Check, ChevronDown, Cpu, Layers } from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderMode } from '../lib/provider-modes.js';
import { ClaudeIcon, CodexIcon } from './BrandIcons.js';

interface ProviderOption {
  value: ProviderMode;
  label: string;
  Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

const DEFAULT_PROVIDER_OPTION: ProviderOption = {
  value: 'all',
  label: 'All providers',
  Icon: Layers,
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  DEFAULT_PROVIDER_OPTION,
  { value: 'claude-code', label: 'Claude Code', Icon: ClaudeIcon },
  { value: 'codex', label: 'OpenAI Codex', Icon: CodexIcon },
  { value: 'local-models', label: 'Local Models', Icon: Cpu },
];

const PANEL_WIDTH = 220;

interface PanelPosition {
  top: number;
  left: number;
}

interface ProviderModeToggleProps {
  value: ProviderMode;
  onChange: (next: ProviderMode) => void;
}

export function ProviderModeToggle({ value, onChange }: ProviderModeToggleProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const currentOption =
    PROVIDER_OPTIONS.find((option) => option.value === value) ?? DEFAULT_PROVIDER_OPTION;
  const CurrentIcon = currentOption.Icon;

  const computePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPosition({
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - PANEL_WIDTH),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    computePanelPosition();
    window.addEventListener('scroll', computePanelPosition, { passive: true, capture: true });
    window.addEventListener('resize', computePanelPosition, { passive: true });
    return () => {
      window.removeEventListener('scroll', computePanelPosition, { capture: true });
      window.removeEventListener('resize', computePanelPosition);
    };
  }, [open, computePanelPosition]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        !(event.target as Element).closest('[data-provider-mode-panel]')
      ) {
        setOpen(false);
        setFocusedIndex(-1);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    optionRefs.current[focusedIndex]?.focus();
  }, [focusedIndex, open]);

  function selectOption(next: ProviderMode): void {
    onChange(next);
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  }

  function toggleOpen(): void {
    setOpen((prev) => {
      if (!prev) {
        computePanelPosition();
        const idx = PROVIDER_OPTIONS.findIndex((option) => option.value === value);
        setFocusedIndex(idx >= 0 ? idx : 0);
      } else {
        setFocusedIndex(-1);
      }
      return !prev;
    });
  }

  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setFocusedIndex(-1);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocusedIndex((idx) => Math.min(idx + 1, PROVIDER_OPTIONS.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocusedIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && focusedIndex >= 0) {
      event.preventDefault();
      selectOption(PROVIDER_OPTIONS[focusedIndex]?.value ?? value);
    }
  }

  const panel =
    open && panelPosition
      ? createPortal(
          <div
            data-provider-mode-panel
            role="listbox"
            aria-label="Provider options"
            onKeyDown={handlePanelKeyDown}
            style={{ top: panelPosition.top, left: panelPosition.left, width: PANEL_WIDTH }}
            className="fixed z-50 rounded-lg border border-gray-200 bg-gray-50 py-1 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            tabIndex={-1}
          >
            {PROVIDER_OPTIONS.map((option, idx) => {
              const selected = option.value === value;
              const focused = idx === focusedIndex;
              const OptionIcon = option.Icon;
              return (
                <button
                  key={option.value}
                  ref={(el) => {
                    optionRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={focused ? 0 : -1}
                  onClick={() => selectOption(option.value)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={[
                    'flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                    selected
                      ? 'bg-gray-100 text-gray-950 dark:bg-gray-800 dark:text-white'
                      : focused
                        ? 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-100'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
                  ].join(' ')}
                >
                  <OptionIcon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate text-left">{option.label}</span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select provider"
        onClick={toggleOpen}
        className={[
          'inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2',
          'text-sm font-medium text-gray-900 transition-colors dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100',
          'hover:bg-gray-100 dark:hover:bg-gray-800',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white',
          'focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950',
        ].join(' ')}
      >
        <CurrentIcon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="max-w-[150px] truncate">{currentOption.label}</span>
        <ChevronDown
          className={['h-4 w-4 shrink-0 transition-transform', open ? 'rotate-180' : ''].join(' ')}
          aria-hidden
        />
      </button>
      {panel}
    </>
  );
}
