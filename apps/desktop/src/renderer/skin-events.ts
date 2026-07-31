/**
 * Public, versionable renderer events for high-freedom Maka skins.
 *
 * Event payloads deliberately expose UI state, not session content. A skin
 * already has DOM access in its isolated world; this channel gives it stable
 * lifecycle signals without coupling to React internals.
 */
export function publishMakaSkinEvent(
  type: 'state',
  detail: {
    section: string;
    module?: string;
    hasActiveSession: boolean;
    streaming: boolean;
    modalOpen: boolean;
  },
): void {
  window.dispatchEvent(new CustomEvent(`maka:${type}`, { detail }));
}
