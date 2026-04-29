/**
 * Tabs — accessible, hash-synced tabbed navigation primitive.
 *
 * Design decisions:
 * - Headless-ish uncontrolled component with optional hash sync.
 * - Tab triggers: semantic <button role="tab" aria-selected> inside
 *   role="tablist". Active indicator is a bottom border (border-b-2), not a
 *   filled background — keeps the chrome light and non-button-y.
 * - Active tab: border-b-2 border-gray-950 dark:border-white
 * - Inactive tabs: muted gray text, no border indicator.
 * - Content panel: <div role="tabpanel" aria-labelledby="…">
 * - Keyboard: ArrowLeft/ArrowRight cycles focus through tabs; Enter/Space
 *   activates the focused tab (native button behavior covers Enter/Space).
 * - Hash sync (default on): reads window.location.hash on mount; writes hash
 *   on tab change via history.replaceState (not pushState); listens for
 *   hashchange events to sync if the user navigates externally.
 * - Only the active tab's content is mounted (render-only-when-active strategy)
 *   so off-tab panels don't fire their useQuery hooks.
 * - No external dependencies.
 */

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TabItem {
  key: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultKey?: string;
  /**
   * When true (default), reads and writes window.location.hash so the active
   * tab is deep-linkable. Uses history.replaceState — not pushState — so tab
   * changes do not create back-button history entries.
   */
  syncWithHash?: boolean;
  className?: string;
  /**
   * Accessible label for the tab list (role="tablist"). Defaults to
   * "Dashboard sections" for backward compatibility with existing usages.
   * Pass a contextual value (e.g. "Session detail sections") when the Tabs
   * instance appears outside the main dashboard.
   */
  ariaLabel?: string;
}

// ---------------------------------------------------------------------------
// Inline class combiner
// ---------------------------------------------------------------------------

function cx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs({ items, defaultKey, syncWithHash = true, className, ariaLabel = 'Dashboard sections' }: TabsProps) {
  const baseId = useId();

  // ── Initial active key resolution ──────────────────────────────────────────
  // Read hash on first render; fall back to defaultKey; fall back to first item.
  function resolveInitialKey(): string {
    if (syncWithHash && typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1); // strip leading '#'
      if (hash && items.some((item) => item.key === hash)) {
        return hash;
      }
    }
    if (defaultKey && items.some((item) => item.key === defaultKey)) {
      return defaultKey;
    }
    return items[0]?.key ?? '';
  }

  const [activeKey, setActiveKey] = useState<string>(resolveInitialKey);

  // Track button refs for keyboard focus management.
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // ── Hash sync ───────────────────────────────────────────────────────────────
  const handleTabChange = useCallback(
    (key: string) => {
      setActiveKey(key);
      if (syncWithHash && typeof window !== 'undefined') {
        history.replaceState(null, '', `#${key}`);
      }
    },
    [syncWithHash]
  );

  // Listen for external hashchange (browser back/forward, in-page links).
  useEffect(() => {
    if (!syncWithHash || typeof window === 'undefined') return;

    function onHashChange() {
      const hash = window.location.hash.slice(1);
      if (hash && items.some((item) => item.key === hash)) {
        setActiveKey(hash);
      }
    }

    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [syncWithHash, items]);

  // ── Keyboard navigation ─────────────────────────────────────────────────────
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentKey: string) {
    const keys = items.map((item) => item.key);
    const currentIndex = keys.indexOf(currentKey);
    if (currentIndex === -1) return;

    let targetIndex: number | null = null;

    if (event.key === 'ArrowRight') {
      targetIndex = (currentIndex + 1) % keys.length;
    } else if (event.key === 'ArrowLeft') {
      targetIndex = (currentIndex - 1 + keys.length) % keys.length;
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = keys.length - 1;
    }

    if (targetIndex !== null) {
      event.preventDefault();
      const targetKey = keys[targetIndex];
      if (targetKey !== undefined) {
        // Move focus and activate the tab.
        const btn = buttonRefs.current.get(targetKey);
        btn?.focus();
        handleTabChange(targetKey);
      }
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activeItem = items.find((item) => item.key === activeKey) ?? items[0];

  return (
    <div className={cx('w-full', className)}>
      {/* ── Tab list ──────────────────────────────────────────────────────── */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex items-end gap-0 border-b border-gray-200 dark:border-gray-800"
      >
        {items.map((item) => {
          const isActive = item.key === activeKey;
          const tabId = `${baseId}-tab-${item.key}`;
          const panelId = `${baseId}-panel-${item.key}`;

          return (
            <button
              key={item.key}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={panelId}
              tabIndex={isActive ? 0 : -1}
              ref={(el) => {
                if (el) {
                  buttonRefs.current.set(item.key, el);
                } else {
                  buttonRefs.current.delete(item.key);
                }
              }}
              onClick={() => handleTabChange(item.key)}
              onKeyDown={(e) => handleKeyDown(e, item.key)}
              className={cx(
                // Base layout
                'relative px-4 py-2.5 text-sm font-medium transition-colors',
                // Bottom border — creates the underline indicator via negative margin
                // so the border sits flush with the tablist border.
                '-mb-px border-b-2',
                // Focus ring — consistent with rest of design system
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
                'focus-visible:ring-gray-950 dark:focus-visible:ring-white',
                'dark:focus-visible:ring-offset-gray-950',
                isActive
                  ? // Active state: dark underline, full-opacity text
                    [
                      'border-gray-950 dark:border-white',
                      'text-gray-950 dark:text-white',
                    ].join(' ')
                  : // Inactive state: transparent underline, muted text with hover
                    [
                      'border-transparent',
                      'text-gray-500 dark:text-gray-400',
                      // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                      'hover:text-gray-700 dark:hover:text-gray-300',
                      // design-lint-disable dark-mode-pairs: compound modifier prefix (hover:) hides the dark pairing from naive line scan
                      'hover:border-gray-300 dark:hover:border-gray-600',
                    ].join(' ')
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {/* ── Tab panel ──────────────────────────────────────────────────────── */}
      {activeItem !== undefined && (
        <div
          id={`${baseId}-panel-${activeItem.key}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${activeItem.key}`}
          tabIndex={0}
          // design-lint-disable dark-mode-pairs: compound modifier prefix (focus-visible:) hides the dark pairing from naive line scan
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950"
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
