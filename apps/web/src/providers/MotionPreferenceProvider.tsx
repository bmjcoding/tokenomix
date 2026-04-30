import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

/** Motion preference values persisted to localStorage. */
export type MotionPreference = 'system' | 'reduced' | 'full';

interface MotionPreferenceContextValue {
  /** The user's current explicit motion preference. */
  motionPreference: MotionPreference;
  /** Update the motion preference and persist to localStorage. */
  setMotionPreference: (preference: MotionPreference) => void;
}

const STORAGE_KEY = 'tokenomix:motion';
const MotionPreferenceContext = createContext<MotionPreferenceContextValue | null>(null);

interface MotionPreferenceProviderProps {
  children: ReactNode;
  /**
   * Default preference before any localStorage value exists.
   * Falls back to 'system' so the OS preference is respected on first load.
   */
  defaultPreference?: MotionPreference;
}

export function MotionPreferenceProvider({
  children,
  defaultPreference = 'system',
}: MotionPreferenceProviderProps) {
  const [motionPreference, setMotionPreferenceState] = useState<MotionPreference>(() => {
    // Hydrate from localStorage on first render (client only).
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'system' || stored === 'reduced' || stored === 'full') {
        return stored;
      }
    }
    return defaultPreference;
  });

  const setMotionPreference = useCallback((next: MotionPreference) => {
    localStorage.setItem(STORAGE_KEY, next);
    setMotionPreferenceState(next);
  }, []);

  const value = useMemo(
    () => ({ motionPreference, setMotionPreference }),
    [motionPreference, setMotionPreference]
  );

  return (
    <MotionPreferenceContext.Provider value={value}>
      {children}
    </MotionPreferenceContext.Provider>
  );
}

/**
 * useMotionPreference — access the current motion preference.
 *
 * Must be used within a <MotionPreferenceProvider> ancestor.
 */
export function useMotionPreference(): MotionPreferenceContextValue {
  const ctx = useContext(MotionPreferenceContext);
  if (!ctx) {
    throw new Error('useMotionPreference must be used within a MotionPreferenceProvider');
  }
  return ctx;
}
