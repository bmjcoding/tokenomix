import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, FileText, History, LayoutDashboard, Moon, Sun } from 'lucide-react';
import { useTheme } from '../providers/ThemeProvider.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Overview',
    icon: <LayoutDashboard size={16} aria-hidden="true" />,
  },
  {
    to: '/sessions',
    label: 'Sessions',
    icon: <History size={16} aria-hidden="true" />,
  },
  {
    to: '/models',
    label: 'Models',
    icon: <Bot size={16} aria-hidden="true" />,
  },
  {
    to: '/report',
    label: 'Report',
    icon: <FileText size={16} aria-hidden="true" />,
  },
];

// design-lint-disable dark-mode-pairs
const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950';
// design-lint-disable dark-mode-pairs
const focusRingTight =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 dark:focus-visible:ring-white focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-950';

const navActive =
  'bg-primary/10 text-primary dark:bg-primary-light/10 dark:text-primary-light font-medium';

// design-lint-disable dark-mode-pairs
const navInactive = 'text-gray-600 dark:text-gray-400 hover:bg-gray-600/5 dark:hover:bg-gray-200/5';

export function Sidebar() {
  const { theme, setTheme } = useTheme();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  function isActive(to: string): boolean {
    if (to === '/') {
      return currentPath === '/';
    }
    return currentPath.startsWith(to);
  }

  function toggleTheme() {
    if (theme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  }

  // design-lint-disable dark-mode-pairs
  const themeToggleCls = `flex items-center gap-2 w-full px-3 py-1.5 text-sm rounded-lg transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 ${focusRingTight}`;

  return (
    <aside
      className="hidden lg:flex flex-col fixed inset-y-0 left-0 w-72 bg-white dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 z-20"
      aria-label="Main navigation"
    >
      {/* App header */}
      <div className="flex items-center h-12 px-5 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <span className="text-sm font-bold font-mono tracking-tight text-gray-950 dark:text-white">
          tokenomix
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <span className="block px-3 py-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-1">
          Dashboard
        </span>
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.to);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${focusRing} ${active ? navActive : navInactive}`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Theme toggle at the bottom */}
      <div className="shrink-0 px-3 py-3 border-t border-gray-200 dark:border-gray-800">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className={themeToggleCls}
        >
          {theme === 'dark' ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
          <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </div>
    </aside>
  );
}
