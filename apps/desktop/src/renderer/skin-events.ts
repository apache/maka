/**
 * Public, versionable renderer events for high-freedom Maka skins.
 *
 * Event payloads deliberately expose UI state, not session content. A skin
 * already has DOM access in its isolated world; this channel gives it stable
 * lifecycle signals without coupling to React internals.
 */
export interface MakaSkinSemanticEventMap {
  state: {
    section: string;
    module?: string;
    hasActiveSession: boolean;
    streaming: boolean;
    modalOpen: boolean;
  };
  'session.changed': {
    sessionId: string | null;
  };
  'messages.changed': {
    sessionId: string | null;
    count: number;
    lastMessage?: Readonly<{ id: string; type: string }>;
  };
  'generation.changed': {
    sessionId: string | null;
    state: 'idle' | 'processing' | 'streaming' | 'tool' | 'waiting';
  };
  'tools.changed': {
    sessionId: string | null;
    tools: ReadonlyArray<Readonly<{
      id: string;
      name: string;
      status: string;
    }>>;
  };
  'interaction.changed': {
    sessionId: string | null;
    kind: 'permission' | 'question' | null;
    waiting: boolean;
  };
}

export function publishMakaSkinEvent<Type extends keyof MakaSkinSemanticEventMap>(
  type: Type,
  detail: MakaSkinSemanticEventMap[Type],
): void {
  const root = document.documentElement;
  if (type === 'state') {
    const state = detail as MakaSkinSemanticEventMap['state'];
    root.dataset.makaSection = state.section;
    if (state.module) root.dataset.makaModule = state.module;
    else root.removeAttribute('data-maka-module');
    root.dataset.makaHasActiveSession = String(state.hasActiveSession);
    root.dataset.makaStreaming = String(state.streaming);
    root.dataset.makaModalOpen = String(state.modalOpen);
  }
  window.dispatchEvent(new CustomEvent(`maka:${type}`, { detail }));
}
