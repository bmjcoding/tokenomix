/**
 * Constants for the ActiveSessionsRail component.
 */

/**
 * Sliding window (in milliseconds) used by ActiveSessionsRail to determine
 * whether a session is considered "active". A session whose computed lastTs
 * (firstTs epoch + durationMs) falls within this window of the current time
 * is shown in the rail. Defaults to 5 minutes.
 */
export const ACTIVE_SESSION_WINDOW_MS: number = 5 * 60 * 1_000;
