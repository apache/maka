/** Polling interval for the session-scoped heartbeat Automation authority. */
export const FIRE_CHECK_INTERVAL_MS = 5_000;

/** Maximum time a due fire may wait for its target Session to become idle. */
export const DEFER_WINDOW_MS = 45 * 60 * 1_000;
