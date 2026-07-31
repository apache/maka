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
  const root = document.documentElement;
  root.dataset.makaSection = detail.section;
  if (detail.module) root.dataset.makaModule = detail.module;
  else root.removeAttribute('data-maka-module');
  root.dataset.makaHasActiveSession = String(detail.hasActiveSession);
  root.dataset.makaStreaming = String(detail.streaming);
  root.dataset.makaModalOpen = String(detail.modalOpen);
  window.dispatchEvent(new CustomEvent(`maka:${type}`, { detail }));
}
