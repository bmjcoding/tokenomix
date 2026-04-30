import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../providers/ThemeProvider.js';

export default function DarkModeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={[
        'fixed bottom-6 left-6 z-[60]',
        'rounded-full w-10 h-10',
        'bg-white dark:bg-gray-700',
        'border border-gray-200 dark:border-gray-600',
        // design-lint-disable shadow-weight
        'shadow-lg backdrop-blur-sm',
        'flex items-center justify-center transition-colors',
        // design-lint-disable dark-mode-pairs
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-2',
      ].join(' ')}
    >
      {isDark ? (
        <Sun size={18} aria-hidden="true" className="text-gray-100" />
      ) : (
        <Moon size={18} aria-hidden="true" className="text-gray-700" />
      )}
    </button>
  );
}
