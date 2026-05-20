import { useCallback, useEffect, useState } from 'react';
import type { ProviderMode } from './provider-modes.js';

const STORAGE_KEY = 'tokenomix:provider-mode';
const CHANGE_EVENT = 'tokenomix:provider-mode-change';

function isProviderMode(value: string | null): value is ProviderMode {
  return (
    value === 'all' || value === 'claude-code' || value === 'codex' || value === 'local-models'
  );
}

function readStoredProviderMode(): ProviderMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isProviderMode(stored)) return stored;
  } catch {
    // localStorage may be unavailable in tests or private browsing.
  }
  return 'all';
}

export function useProviderMode(): {
  providerMode: ProviderMode;
  setProviderMode: (next: ProviderMode) => void;
} {
  const [providerMode, setProviderModeState] = useState<ProviderMode>(readStoredProviderMode);

  const setProviderMode = useCallback((next: ProviderMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore persistence failures; the in-memory state still updates.
    }
    setProviderModeState(next);
    window.dispatchEvent(new CustomEvent<ProviderMode>(CHANGE_EVENT, { detail: next }));
  }, []);

  useEffect(() => {
    function handleProviderModeChange(event: Event): void {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === 'string' && isProviderMode(detail)) {
        setProviderModeState(detail);
      }
    }

    function handleStorage(event: StorageEvent): void {
      if (event.key !== STORAGE_KEY) return;
      setProviderModeState(isProviderMode(event.newValue) ? event.newValue : 'all');
    }

    window.addEventListener(CHANGE_EVENT, handleProviderModeChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleProviderModeChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return { providerMode, setProviderMode };
}
