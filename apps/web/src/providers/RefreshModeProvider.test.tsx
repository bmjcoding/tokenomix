// @vitest-environment jsdom
/**
 * RefreshModeProvider.test.tsx — Vitest unit tests for
 * RefreshModeProvider context and useRefreshMode hook.
 *
 * Runs in a jsdom environment so that localStorage and React context
 * are available. Uses renderHook from @testing-library/react.
 *
 * Coverage:
 *   1. Default mode is 'realtime' when localStorage is empty.
 *   2. Hydrates 'minute' or 'realtime' from localStorage when the key
 *      'tokenomix:refresh-mode' is preset before mount.
 *   3. setRefreshMode() updates state AND persists to localStorage;
 *      round-trip back to 'realtime'.
 *   4. useRefreshMode() throws when called outside a provider,
 *      with an error message matching /RefreshModeProvider/.
 */

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RefreshModeProvider, useRefreshMode } from './RefreshModeProvider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tokenomix:refresh-mode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps the hook under test in a RefreshModeProvider. */
function wrapper({ children }: { children: ReactNode }) {
  return <RefreshModeProvider>{children}</RefreshModeProvider>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Test 1 — Default mode is 'realtime' when localStorage is empty
// ---------------------------------------------------------------------------

describe('RefreshModeProvider — default mode', () => {
  it("returns 'realtime' when localStorage has no stored value", () => {
    const { result } = renderHook(() => useRefreshMode(), { wrapper });
    expect(result.current.refreshMode).toBe('realtime');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Hydrates from localStorage for each valid value
// ---------------------------------------------------------------------------

describe('RefreshModeProvider — localStorage hydration', () => {
  it.each([
    ['minute'],
    ['realtime'],
  ] as const)("hydrates refreshMode from localStorage when key is preset to '%s'", (storedValue) => {
    localStorage.setItem(STORAGE_KEY, storedValue);
    const { result } = renderHook(() => useRefreshMode(), { wrapper });
    expect(result.current.refreshMode).toBe(storedValue);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — setRefreshMode updates state AND persists to localStorage; round-trip
// ---------------------------------------------------------------------------

describe('RefreshModeProvider — setRefreshMode', () => {
  it('updates state and persists to localStorage; round-trips realtime -> minute -> realtime', () => {
    const { result } = renderHook(() => useRefreshMode(), { wrapper });

    // Start at default 'realtime'
    expect(result.current.refreshMode).toBe('realtime');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Switch to 'minute'
    act(() => {
      result.current.setRefreshMode('minute');
    });
    expect(result.current.refreshMode).toBe('minute');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('minute');

    // Round-trip back to 'realtime'
    act(() => {
      result.current.setRefreshMode('realtime');
    });
    expect(result.current.refreshMode).toBe('realtime');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('realtime');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — useRefreshMode throws outside the provider
// ---------------------------------------------------------------------------

describe('useRefreshMode — throws outside provider', () => {
  it('throws an error matching /RefreshModeProvider/ when used without a provider', () => {
    // Suppress React's console.error for the expected throw so test output is clean.
    const originalError = console.error;
    console.error = () => {};

    expect(() => {
      renderHook(() => useRefreshMode());
    }).toThrow(/RefreshModeProvider/);

    console.error = originalError;
  });
});
