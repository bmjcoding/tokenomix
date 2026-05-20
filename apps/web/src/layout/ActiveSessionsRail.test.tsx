// @vitest-environment jsdom
/**
 * ActiveSessionsRail.test.tsx — Vitest tests for the collapsible live-session
 * panel.
 *
 * Uses react-dom/client createRoot + React.act — no @testing-library/react.
 *
 * Coverage:
 *   1. Empty state: [] sessions → pill shows "No live sessions", dot is grey/static.
 *   2. Populated state: 2 active sessions → pill shows "Live · 2", dot has animate-pulse.
 *   3. (removed — stale filtering is now server-side)
 *   4. Reduced-motion gating: motionPreference 'reduced' → dot has NO animate-pulse.
 *   5. Expand/collapse: clicking pill opens dialog; close button collapses it.
 *   6. Escape key closes the panel.
 *   7. Click outside the panel collapses it.
 *   8. Empty state message inside expanded panel.
 *   9. Session cards are Links with correct aria-label.
 *  10. Renders as many cards as data contains (cap is server-side).
 */

import type { SessionSummary } from '@tokenomix/shared';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionPreference } from '../providers/MotionPreferenceProvider.js';

// ---------------------------------------------------------------------------
// React act() environment flag (silences console.error from React 19)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Controlled useQuery stub.  Each test resets `queryReturnValue` before rendering
 * so it can supply different data without re-registering the mock.
 */
let queryReturnValue: { data: SessionSummary[] | undefined; isLoading: boolean; isError: boolean } =
  {
    data: undefined,
    isLoading: false,
    isError: false,
  };

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryReturnValue,
}));

/**
 * Controlled motionPreference stub.  Defaults to 'system' — override per test.
 */
let mockMotionPreference: MotionPreference = 'system';

vi.mock('../providers/MotionPreferenceProvider.js', () => ({
  useMotionPreference: () => ({ motionPreference: mockMotionPreference }),
}));

/**
 * Mock @tanstack/react-router Link → renders a plain <a> so no router context
 * is required.
 */
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    'aria-label': ariaLabel,
    to,
    params,
    className,
  }: {
    children: React.ReactNode;
    'aria-label'?: string;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => {
    const href = params
      ? to.replace(/\$([a-zA-Z]+)/g, (_: string, key: string) => params[key] ?? '')
      : to;
    return (
      <a href={href} aria-label={ariaLabel} className={className}>
        {children}
      </a>
    );
  },
}));

/**
 * Mock lucide-react X icon so we don't need the full package in jsdom.
 */
vi.mock('lucide-react', () => ({
  X: ({ size, 'aria-hidden': ariaHidden }: { size?: number; 'aria-hidden'?: string }) =>
    React.createElement('span', {
      'data-testid': 'x-icon',
      'aria-hidden': ariaHidden,
      'data-size': size,
    }),
}));

// ---------------------------------------------------------------------------
// Fixture time anchor
//
// All tests fix "now" at 2026-04-30T16:00:00Z.
// Active fixtures: lastTs = firstTs_epoch + durationMs is within 5 min of now.
// Stale fixtures:  lastTs is more than 5 min before now.
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-04-30T16:00:00Z';
const NOW_MS = new Date(NOW_ISO).getTime(); // 1_746_028_800_000

// 2 minutes ago (active)
const ACTIVE_LAST_TS_MS = NOW_MS - 2 * 60 * 1_000; // 1_746_028_680_000

/**
 * Builds a minimal SessionSummary fixture.
 *
 * `lastTs = firstTs_epoch + durationMs`.  We anchor firstTs to
 * (targetLastTs - durationMs) so the formula yields exactly targetLastTs.
 */
function buildSession(
  overrides: Partial<SessionSummary> & { targetLastTs?: number } = {}
): SessionSummary {
  const { targetLastTs = ACTIVE_LAST_TS_MS, ...rest } = overrides;
  const durationMs = 60_000; // 1 minute session
  const firstTsMs = targetLastTs - durationMs;
  const firstTs = new Date(firstTsMs).toISOString();

  const base: SessionSummary = {
    sessionId: 'aabbccdd1122334455',
    project: '/users/dev/my-project',
    projectName: 'my-project',
    costUsd: 0.05,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    events: 3,
    firstTs,
    durationMs,
    isSubagent: false,
    topTools: [],
    toolNamesCount: 0,
  };

  return { ...base, ...rest };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

interface RenderResult {
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}

async function renderComponent(): Promise<RenderResult> {
  // Dynamic import so mocks are established before the module loads.
  const { default: ActiveSessionsRail } = await import('./ActiveSessionsRail.js');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(ActiveSessionsRail));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
  // Reset defaults
  mockMotionPreference = 'system';
  queryReturnValue = { data: [], isLoading: false, isError: false };
});

afterEach(async () => {
  // Clean up any leftover DOM nodes
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Test 1 — Empty state (no sessions)
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — empty state (collapsed)', () => {
  it('shows "No live sessions" pill text and a static grey dot when sessions array is empty', async () => {
    queryReturnValue = { data: [], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    const pill = container.querySelector('button[aria-label="Active sessions"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('No live sessions');

    // Dot span is the first child of the button
    const dot = pill?.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('bg-gray-');
    expect(dot?.className).not.toContain('animate-pulse');
    expect(dot?.className).not.toContain('bg-emerald');

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Populated state (2 active sessions)
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — populated state (2 active sessions)', () => {
  it('shows "Live · 2" pill text and animate-pulse dot when 2 sessions are within the 5-min window', async () => {
    const session1 = buildSession({
      sessionId: 'aaaa111122223333',
      project: '/users/dev/project-alpha',
      events: 5,
      costUsd: 0.12,
      targetLastTs: ACTIVE_LAST_TS_MS,
    });
    const session2 = buildSession({
      sessionId: 'bbbb444455556666',
      project: '/users/dev/project-beta',
      events: 2,
      costUsd: 0.03,
      // 1 minute ago — also active
      targetLastTs: NOW_MS - 60_000,
    });
    queryReturnValue = { data: [session1, session2], isLoading: false, isError: false };
    mockMotionPreference = 'system';

    const { container, unmount } = await renderComponent();

    const pill = container.querySelector('button[aria-label="Active sessions"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('Live · 2');

    const dot = pill?.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain('animate-pulse');
    expect(dot?.className).toContain('bg-primary');

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Reduced-motion gating
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — reduced-motion gating', () => {
  it('does NOT add animate-pulse to the dot when motionPreference is "reduced", even with active sessions', async () => {
    const session = buildSession({ targetLastTs: ACTIVE_LAST_TS_MS });
    queryReturnValue = { data: [session], isLoading: false, isError: false };
    mockMotionPreference = 'reduced';

    const { container, unmount } = await renderComponent();

    const pill = container.querySelector('button[aria-label="Active sessions"]');
    // Should show count (1 active session)
    expect(pill?.textContent).toContain('Live · 1');

    const dot = pill?.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).not.toContain('animate-pulse');
    // Still primary-coloured — just not animated
    expect(dot?.className).toContain('bg-primary');

    await unmount();
  });

  it('adds animate-pulse to the dot when motionPreference is "full" with active sessions', async () => {
    const session = buildSession({ targetLastTs: ACTIVE_LAST_TS_MS });
    queryReturnValue = { data: [session], isLoading: false, isError: false };
    mockMotionPreference = 'full';

    const { container, unmount } = await renderComponent();

    const pill = container.querySelector('button[aria-label="Active sessions"]');
    expect(pill?.textContent).toContain('Live · 1');

    const dot = pill?.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain('animate-pulse');

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Expand/collapse via pill and close button
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — expand/collapse', () => {
  it('opens the dialog panel on pill click and collapses on close button click', async () => {
    queryReturnValue = { data: [], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Panel should not be visible initially
    expect(container.querySelector('section[aria-label="Active sessions"]')).toBeNull();

    // Click the pill to expand
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    expect(pill).not.toBeNull();

    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    // Panel should now be visible
    const dialog = container.querySelector('section[aria-label="Active sessions"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toBe('Active sessions');

    // Click the close button
    const closeBtn = container.querySelector('button[aria-label="Close active sessions"]');
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      (closeBtn as HTMLButtonElement).click();
    });

    // Panel should be gone; pill should be back
    expect(container.querySelector('section[aria-label="Active sessions"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Active sessions"]')).not.toBeNull();

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Escape key closes the panel
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — Escape key', () => {
  it('closes the expanded panel when Escape is pressed', async () => {
    queryReturnValue = { data: [], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Expand
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    expect(container.querySelector('section[aria-label="Active sessions"]')).not.toBeNull();

    // Press Escape
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container.querySelector('section[aria-label="Active sessions"]')).toBeNull();

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Click outside the panel collapses it
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — click outside', () => {
  it('collapses the panel on a pointerdown event outside the panel root', async () => {
    queryReturnValue = { data: [], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Expand
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    expect(container.querySelector('section[aria-label="Active sessions"]')).not.toBeNull();

    // Simulate pointerdown on the document body (outside the panel)
    const outsideEl = document.createElement('div');
    document.body.appendChild(outsideEl);

    await act(async () => {
      // Dispatch on an element that is NOT inside the panel
      document.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          // target will be document when using document.dispatchEvent directly
        })
      );
    });

    expect(container.querySelector('section[aria-label="Active sessions"]')).toBeNull();

    outsideEl.remove();
    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Empty state message inside expanded panel
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — empty state message in expanded panel', () => {
  it('shows "No active sessions in the last 5 minutes." when expanded with no active sessions', async () => {
    queryReturnValue = { data: [], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Expand
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    const dialog = container.querySelector('section[aria-label="Active sessions"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('No active sessions in the last 5 minutes.');

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Session cards are Link elements with correct aria-label
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — session card aria-labels', () => {
  it('each card is an anchor with aria-label including project, cost, and session age', async () => {
    const session = buildSession({
      sessionId: 'aabbccddee112233',
      project: '/users/dev/tokenomix',
      costUsd: 1.5,
      events: 7,
      // exactly 2 minutes ago: formatTimeSince yields "2m"
      targetLastTs: ACTIVE_LAST_TS_MS,
    });
    queryReturnValue = { data: [session], isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Expand to see session cards
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    // id7 = sessionId.slice(0, 8).toLowerCase() = "aabbccdd"
    // displayName = "tokenomix"
    // cost = formatCurrency(1.50) = "$1.50"
    // sessionAge = now - firstTs = 3 minutes (firstTs = ACTIVE_LAST_TS_MS - 60_000 = NOW_MS - 3min)
    // formatDuration(3 * 60_000) = "3m"
    const expectedLabel =
      'Open session aabbccdd, project tokenomix, $1.50 spend, running for 3m, 1,500 input + output tokens';

    const link = container.querySelector(`a[aria-label="${expectedLabel}"]`);
    expect(link).not.toBeNull();
    // Verify href points to the session report
    expect(link?.getAttribute('href')).toContain(session.sessionId);

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — Renders as many cards as data contains (cap is server-side)
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — renders all cards returned by server', () => {
  it('renders exactly as many session cards as the mocked data contains, since cap is server-side', async () => {
    const sessions: SessionSummary[] = Array.from({ length: 10 }, (_, i) =>
      buildSession({
        sessionId: `session${String(i).padStart(12, '0')}`,
        project: `/users/dev/project-${i}`,
        targetLastTs: ACTIVE_LAST_TS_MS - i * 5_000,
      })
    );
    queryReturnValue = { data: sessions, isLoading: false, isError: false };

    const { container, unmount } = await renderComponent();

    // Expand to see session cards
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    const listItems = container.querySelectorAll('ul li');
    expect(listItems.length).toBe(10);

    await unmount();
  });
});

// ---------------------------------------------------------------------------
// Test 11 — isError state (B7 regression guard)
// ---------------------------------------------------------------------------

describe('ActiveSessionsRail — error state', () => {
  it('shows "Live · !" pill text when isError is true (collapsed)', async () => {
    queryReturnValue = { data: undefined, isLoading: false, isError: true };

    const { container, unmount } = await renderComponent();

    const pill = container.querySelector('button[aria-label="Active sessions"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('Live · !');

    await unmount();
  });

  it('shows error message in expanded panel when isError is true', async () => {
    queryReturnValue = { data: undefined, isLoading: false, isError: true };

    const { container, unmount } = await renderComponent();

    // Expand the panel
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    const dialog = container.querySelector('section[aria-label="Active sessions"]');
    expect(dialog).not.toBeNull();

    // Must show the error message, not the empty-state message.
    expect(dialog?.textContent).toContain('Could not load active sessions');
    expect(dialog?.textContent).not.toContain('No active sessions in the last 5 minutes.');

    await unmount();
  });

  it('does NOT show session cards when isError is true even if stale data is present', async () => {
    // Simulate a re-query that fails but has prior cached data: isError=true, data still set.
    const staleSession = buildSession({ sessionId: 'stale-session-abc1234567' });
    queryReturnValue = { data: [staleSession], isLoading: false, isError: true };

    const { container, unmount } = await renderComponent();

    // Expand the panel
    const pill = container.querySelector('button[aria-label="Active sessions"]');
    await act(async () => {
      (pill as HTMLButtonElement).click();
    });

    const dialog = container.querySelector('section[aria-label="Active sessions"]');
    expect(dialog).not.toBeNull();

    // Error message shown instead of session list.
    expect(dialog?.textContent).toContain('Could not load active sessions');
    // No list items rendered.
    const listItems = container.querySelectorAll('ul li');
    expect(listItems.length).toBe(0);

    await unmount();
  });
});
