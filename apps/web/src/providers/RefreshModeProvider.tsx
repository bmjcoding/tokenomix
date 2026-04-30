import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

/** Refresh mode values persisted to localStorage. */
export type RefreshMode = 'realtime' | 'minute';

interface RefreshModeContextValue {
  /** The user's current refresh mode preference. */
  refreshMode: RefreshMode;
  /** Update the refresh mode and persist the selection. */
  setRefreshMode: (mode: RefreshMode) => void;
}

const STORAGE_KEY = 'tokenomix:refresh-mode';
const RefreshModeContext = createContext<RefreshModeContextValue | null>(null);

interface RefreshModeProviderProps {
  children: ReactNode;
  /**
   * Default mode before any localStorage value exists.
   * Falls back to 'realtime' so SSE is the out-of-box experience.
   */
  defaultMode?: RefreshMode;
}

export function RefreshModeProvider({
  children,
  defaultMode = 'realtime',
}: RefreshModeProviderProps) {
  const [refreshMode, setRefreshModeState] = useState<RefreshMode>(() => {
    // Hydrate from localStorage on first render (client only).
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'realtime' || stored === 'minute') {
        return stored;
      }
    }
    return defaultMode;
  });

  const setRefreshMode = useCallback((mode: RefreshMode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    setRefreshModeState(mode);
  }, []);

  const value = useMemo(
    () => ({ refreshMode, setRefreshMode }),
    [refreshMode, setRefreshMode]
  );

  return (
    <RefreshModeContext.Provider value={value}>
      {children}
    </RefreshModeContext.Provider>
  );
}

/**
 * useRefreshMode — access the current refresh mode preference and its setter.
 *
 * Must be used within a <RefreshModeProvider> ancestor.
 */
export function useRefreshMode(): RefreshModeContextValue {
  const ctx = useContext(RefreshModeContext);
  if (!ctx) {
    throw new Error('useRefreshMode must be used within a RefreshModeProvider');
  }
  return ctx;
}
