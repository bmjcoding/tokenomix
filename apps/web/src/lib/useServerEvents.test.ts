/**
 * useServerEvents.test.ts — Integration tests for the refreshMode branching logic.
 *
 * @vitest-environment jsdom
 *
 * Covers three scenarios:
 *   1. Realtime mode (default): EventSource is constructed on mount, close() on unmount.
 *   2. Minute mode: EventSource is NOT constructed; setInterval fires every 60 000 ms and
 *      calls invalidateQueries on all four cache keys; clearInterval on unmount.
 *   3. Mode switch realtime → minute: EventSource is closed when mode switches, interval
 *      is started after the switch (two separate renderHook calls asserting cleanup →
 *      new-effect transition per plan note).
 *
 * Approach:
 *   - vi.stubGlobal mocks the global EventSource constructor.
 *   - vi.useFakeTimers controls the 60 000 ms setInterval without waiting in real time.
 *   - A minimal renderHook helper built on react-dom/client createRoot and React.act
 *     wraps the hook in both QueryClientProvider and RefreshModeProvider.
 *   - QueryClient.invalidateQueries is replaced with a vi.fn() spy to observe calls.
 */

import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  RefreshModeProvider,
} from '../providers/RefreshModeProvider';
import { useServerEvents } from './useServerEvents';

// ---------------------------------------------------------------------------
// Minimal renderHook helper (no @testing-library/react dependency)
// ---------------------------------------------------------------------------

interface RenderHookResult {
  unmount: () => Promise<void>;
}

/**
 * Renders a React hook inside a `<RefreshModeProvider defaultMode={initialMode}>` +
 * `<QueryClientProvider client={queryClient}>` wrapper using a real DOM container.
 *
 * Returns `{ unmount }` so the caller can trigger React cleanup.
 */
async function renderHookWithProviders(
  queryClient: QueryClient,
  initialMode: 'realtime' | 'minute',
): Promise<RenderHookResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  /** Leaf component that just calls the hook with no return value. */
  function HookConsumer(): null {
    useServerEvents();
    return null;
  }

  /** Wrapper that supplies both providers. */
  function Wrapper(): React.ReactElement {
    return React.createElement(
      RefreshModeProvider,
      { defaultMode: initialMode, children: null } as React.ComponentProps<typeof RefreshModeProvider>,
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(HookConsumer),
      ),
    );
  }

  await act(async () => {
    root.render(React.createElement(Wrapper));
  });

  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// EventSource mock factory
// ---------------------------------------------------------------------------

/** Tracks every EventSource instance created during the test. */
let eventSourceInstances: { close: ReturnType<typeof vi.fn> }[] = [];

/**
 * Builds a mock EventSource class.  Each constructor call creates an instance
 * with a `close` spy and records it in `eventSourceInstances`.
 */
function buildEventSourceMock(): { new (url: string): EventSource } {
  const MockEventSource = vi.fn(function MockEventSourceCtor(
    this: { close: ReturnType<typeof vi.fn> },
    _url: string,
  ) {
    this.close = vi.fn();
    eventSourceInstances.push(this);
  }) as unknown as { new (url: string): EventSource };
  return MockEventSource;
}

// ---------------------------------------------------------------------------
// React act() environment flag
//
// React 19's act() emits a console.error when IS_REACT_ACT_ENVIRONMENT is not
// set to true in the global scope.  The @vitest-environment jsdom docblock sets
// the DOM environment but does not automatically set this flag.  Setting it here
// silences the spurious warning without requiring a separate vitest setup file.
// ---------------------------------------------------------------------------

declare global {
  // Augment globalThis so TypeScript accepts the assignment below.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  eventSourceInstances = [];
  // Fake timers intercept setInterval / clearInterval / setTimeout.
  vi.useFakeTimers();
  // Clear localStorage so RefreshModeProvider always starts from its prop default.
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Helper: fresh QueryClient with invalidateQueries spy
// ---------------------------------------------------------------------------

function makeQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
  return qc;
}

// ---------------------------------------------------------------------------
// Test 1 — Realtime mode (default)
// ---------------------------------------------------------------------------

describe('useServerEvents — realtime mode (default)', () => {
  it('constructs EventSource once with /api/events and closes it on unmount', async () => {
    const MockEventSource = buildEventSourceMock();
    vi.stubGlobal('EventSource', MockEventSource);

    const qc = makeQueryClient();
    const { unmount } = await renderHookWithProviders(qc, 'realtime');

    // One EventSource should have been constructed.
    expect(MockEventSource).toHaveBeenCalledOnce();
    expect(MockEventSource).toHaveBeenCalledWith('/api/events');

    const instance = eventSourceInstances[0];
    expect(instance).toBeDefined();
    if (!instance) throw new Error('Expected EventSource instance to exist');

    // close() should not have been called yet.
    expect(instance.close).not.toHaveBeenCalled();

    // Unmount triggers useEffect cleanup → source.close().
    await unmount();

    expect(instance.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Minute mode
// ---------------------------------------------------------------------------

describe('useServerEvents — minute mode', () => {
  it('does NOT construct EventSource; fires invalidateQueries on each interval tick; cleans up on unmount', async () => {
    const MockEventSource = buildEventSourceMock();
    vi.stubGlobal('EventSource', MockEventSource);

    // Spy on setInterval / clearInterval to verify timer lifecycle.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const qc = makeQueryClient();
    const { unmount } = await renderHookWithProviders(qc, 'minute');

    // EventSource must NOT be constructed in minute mode.
    expect(MockEventSource).not.toHaveBeenCalled();

    // A setInterval for 60 000 ms should have been registered.
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    // invalidateQueries should not have been called yet (interval hasn't fired).
    expect(qc.invalidateQueries).not.toHaveBeenCalled();

    // Advance fake timers by exactly 60 000 ms to fire the interval once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // All four query keys must have been invalidated.
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(4);
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['metrics'] });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['turns'] });
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['session'] });

    // Unmount triggers useEffect cleanup → clearInterval.
    await unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Mode switch: realtime → minute (two-renderHook approach)
// ---------------------------------------------------------------------------

describe('useServerEvents — mode switch realtime → minute', () => {
  it('closes EventSource when transitioning to realtime and starts interval in minute', async () => {
    const MockEventSource = buildEventSourceMock();
    vi.stubGlobal('EventSource', MockEventSource);

    // ---- Phase A: realtime ----
    const qcA = makeQueryClient();
    const { unmount: unmountA } = await renderHookWithProviders(qcA, 'realtime');

    // EventSource constructed in realtime mode.
    expect(MockEventSource).toHaveBeenCalledOnce();
    const instanceA = eventSourceInstances[0];
    if (!instanceA) throw new Error('Expected EventSource instanceA to exist');
    expect(instanceA.close).not.toHaveBeenCalled();

    // Unmount the realtime hook — this triggers cleanup (close EventSource).
    await unmountA();
    expect(instanceA.close).toHaveBeenCalledOnce();

    // ---- Phase B: minute (simulates "switched" mode via new renderHook with minute default) ----
    // Reset the mock so call counts are clean for the minute phase.
    vi.mocked(MockEventSource as unknown as (...args: unknown[]) => unknown).mockClear();

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const qcB = makeQueryClient();
    const { unmount: unmountB } = await renderHookWithProviders(qcB, 'minute');

    // After the mode "switch", EventSource must NOT be constructed.
    expect(MockEventSource).not.toHaveBeenCalled();

    // The interval must be registered.
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    // Unmount minute mode — triggers clearInterval.
    await unmountB();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
