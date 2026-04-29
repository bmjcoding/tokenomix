import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/** Theme preference values persisted to localStorage. */
export type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** The user's current explicit preference. */
  theme: Theme;
  /** The resolved mode actually applied to the document (never "system"). */
  resolvedTheme: 'light' | 'dark';
  /** Toggle between light, dark, and system. */
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'tokenomix:theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Resolve the effective appearance for a given preference + OS media query. */
function resolveTheme(preference: Theme): 'light' | 'dark' {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

/** Apply or remove the `.dark` class on the root `<html>` element. */
function applyClass(resolved: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

interface ThemeProviderProps {
  children: ReactNode;
  /**
   * Default preference before any localStorage value exists.
   * Falls back to 'system' so the OS preference is respected on first load.
   */
  defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = 'system' }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // Hydrate from localStorage on first render (client only).
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        return stored;
      }
    }
    return defaultTheme;
  });

  // Derive the resolved theme (never "system").
  const resolvedTheme = useMemo(() => resolveTheme(theme), [theme]);

  // Sync .dark class whenever resolvedTheme changes.
  useEffect(() => {
    applyClass(resolvedTheme);
  }, [resolvedTheme]);

  // Listen to OS preference changes when the user chose "system".
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      applyClass(resolveTheme('system'));
    };
    mq.addEventListener('change', handler);
    return () => {
      mq.removeEventListener('change', handler);
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * useTheme — access the current theme preference and resolved mode.
 *
 * Must be used within a <ThemeProvider> ancestor.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
