/**
 * FloatingControls — collapsible settings panel anchored at bottom-left.
 *
 * Collapsed state: a single 40×40 round gear button. Expanded state: a
 * labeled-row card with three segmented toggles (Theme, Refresh, Motion).
 * The panel replaces the button at the same anchor — no stacking.
 *
 * Dismissal:
 *   - Click outside the panel root (pointerdown on document)
 *   - Press Escape
 *   - Click the X button inside the panel header
 *
 * Focus management:
 *   - Opening moves focus to the first interactive element inside the panel.
 *   - Closing returns focus to the gear button.
 */

import { Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import DarkModeToggle from './DarkModeToggle.js';
import MotionPreferenceToggle from './MotionPreferenceToggle.js';
import RefreshModeToggle from './RefreshModeToggle.js';

export default function FloatingControls() {
  const [expanded, setExpanded] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const gearButtonRef = useRef<HTMLButtonElement>(null);

  // Collapse on Escape
  useEffect(() => {
    if (!expanded) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  // Collapse on click outside
  useEffect(() => {
    if (!expanded) return;

    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    }

    // Use capture so we see the event before any child handler
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [expanded]);

  // Focus management: open → first interactive element inside panel
  useEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Defer one frame to let the panel render fully before querying
    const id = requestAnimationFrame(() => {
      const first = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  // Focus management: close → return focus to gear button
  function collapse() {
    setExpanded(false);
    // Schedule focus return after state update re-renders collapsed button
    requestAnimationFrame(() => {
      gearButtonRef.current?.focus();
    });
  }

  return (
    <div className="fixed bottom-6 left-6 z-[60]">
      {expanded ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Settings"
          aria-modal={false}
          className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white/90 p-3 shadow-lg backdrop-blur-sm dark:border-gray-700 dark:bg-gray-900/90"
        >
          {/* Panel header */}
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Settings</span>
            <button
              type="button"
              aria-label="Close settings"
              onClick={collapse}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-white"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          {/* Toggle rows */}
          <DarkModeToggle />
          <RefreshModeToggle />
          <MotionPreferenceToggle />
        </div>
      ) : (
        <button
          ref={gearButtonRef}
          type="button"
          aria-label="Open settings"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-lg backdrop-blur-sm transition-colors hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100 dark:focus-visible:ring-white"
        >
          <Settings size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
