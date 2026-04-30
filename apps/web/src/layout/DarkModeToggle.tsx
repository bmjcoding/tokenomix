/**
 * DarkModeToggle — labeled segmented-pill for theme selection.
 *
 * Replaces the cycling icon button with an explicit three-option segmented control
 * so users can see all choices at a glance: Light, Dark, System. The label "Theme"
 * sits to the left in a fixed-width span so all three rows in FloatingControls align.
 */

import { type Theme, useTheme } from '../providers/ThemeProvider.js';
import { SegmentedToggle } from '../ui/SegmentedToggle.js';

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

export default function DarkModeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs font-medium text-gray-600 dark:text-gray-400">Theme</span>
      <SegmentedToggle<Theme>
        ariaLabel="Colour theme"
        options={THEME_OPTIONS}
        value={theme}
        onChange={setTheme}
        size="sm"
        accent="achromatic"
      />
    </div>
  );
}
