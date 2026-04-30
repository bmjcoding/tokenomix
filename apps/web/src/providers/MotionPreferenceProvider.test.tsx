// @vitest-environment jsdom
/**
 * MotionPreferenceProvider.test.tsx — Vitest unit tests for
 * MotionPreferenceProvider context and useMotionPreference hook.
 *
 * Runs in a jsdom environment so that localStorage and React context
 * are available. Uses renderHook from @testing-library/react.
 *
 * Coverage:
 *   1. Default mode is 'system' when localStorage is empty.
 *   2. Hydrates each of 'system' | 'reduced' | 'full' from localStorage
 *      when the key 'tokenomix:motion' is preset before mount.
 *   3. setMotionPreference() cycles through all three values and persists
 *      each to localStorage.
 *   4. useMotionPreference() throws when called outside a provider,
 *      with an error message matching /MotionPreferenceProvider/.
 */

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MotionPreferenceProvider, useMotionPreference } from './MotionPreferenceProvider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tokenomix:motion';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps the hook under test in a MotionPreferenceProvider. */
function wrapper({ children }: { children: ReactNode }) {
  return <MotionPreferenceProvider>{children}</MotionPreferenceProvider>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Test 1 — Default mode is 'system' when localStorage is empty
// ---------------------------------------------------------------------------

describe('MotionPreferenceProvider — default mode', () => {
  it("returns 'system' when localStorage has no stored value", () => {
    const { result } = renderHook(() => useMotionPreference(), { wrapper });
    expect(result.current.motionPreference).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Hydrates from localStorage for each valid value
// ---------------------------------------------------------------------------

describe('MotionPreferenceProvider — localStorage hydration', () => {
  it.each([
    ['system'],
    ['reduced'],
    ['full'],
  ] as const)("hydrates motionPreference from localStorage when key is preset to '%s'", (storedValue) => {
    localStorage.setItem(STORAGE_KEY, storedValue);
    const { result } = renderHook(() => useMotionPreference(), { wrapper });
    expect(result.current.motionPreference).toBe(storedValue);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — setMotionPreference cycles all three values and persists each
// ---------------------------------------------------------------------------

describe('MotionPreferenceProvider — setMotionPreference', () => {
  it('cycles through system -> reduced -> full and persists each value to localStorage', () => {
    const { result } = renderHook(() => useMotionPreference(), { wrapper });

    // Start at default 'system'
    expect(result.current.motionPreference).toBe('system');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Set to 'reduced'
    act(() => {
      result.current.setMotionPreference('reduced');
    });
    expect(result.current.motionPreference).toBe('reduced');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('reduced');

    // Set to 'full'
    act(() => {
      result.current.setMotionPreference('full');
    });
    expect(result.current.motionPreference).toBe('full');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('full');

    // Cycle back to 'system'
    act(() => {
      result.current.setMotionPreference('system');
    });
    expect(result.current.motionPreference).toBe('system');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — useMotionPreference throws outside the provider
// ---------------------------------------------------------------------------

describe('useMotionPreference — throws outside provider', () => {
  it('throws an error matching /MotionPreferenceProvider/ when used without a provider', () => {
    // Suppress React's console.error for the expected throw so test output is clean.
    const originalError = console.error;
    console.error = () => {};

    expect(() => {
      renderHook(() => useMotionPreference());
    }).toThrow(/MotionPreferenceProvider/);

    console.error = originalError;
  });
});
