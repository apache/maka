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
  'sessions.changed': {
    currentSessionId: string | null;
    sessions: ReadonlyArray<Readonly<{
      id: string;
      name: string;
      status: string;
      flagged: boolean;
      archived: boolean;
      unread: boolean;
      lastMessageAt?: number;
      lastMessagePreview?: string;
    }>>;
  };
  'conversation.changed': {
    sessionId: string | null;
    messages: ReadonlyArray<Readonly<{
      id: string;
      turnId: string;
      role: 'user' | 'assistant';
      text: string;
      timestamp?: number;
      streaming: boolean;
      truncated?: boolean;
    }>>;
  };
  'tools.detail.changed': {
    sessionId: string | null;
    tools: ReadonlyArray<Readonly<{
      id: string;
      turnId?: string;
      name: string;
      displayName?: string;
      status: string;
      argsText?: string;
      outputText?: string;
      durationMs?: number;
      truncated?: boolean;
    }>>;
  };
  'interaction.detail.changed': {
    sessionId: string | null;
    interaction: null | Readonly<{
      kind: 'permission' | 'question';
      requestId?: string;
      toolUseId?: string;
      questions?: ReadonlyArray<Readonly<{
        question: string;
        options: ReadonlyArray<Readonly<{ label: string; description?: string }>>;
      }>>;
    }>;
  };
  'composer.changed': {
    sessionId: string | null;
    draft: string;
    skills: ReadonlyArray<Readonly<{ id: string; ref?: string; name: string }>>;
    attachments: ReadonlyArray<Readonly<{ index: number; name: string; kind: string; size: number; mimeType?: string }>>;
    model?: string;
    permissionMode?: string;
    busy: boolean;
  };
  'navigation.will-change': {
    from: Readonly<{ section: string; module?: string }>;
    to: Readonly<{ section: string; module?: string }>;
  };
  'navigation.did-change': {
    from: Readonly<{ section: string; module?: string }>;
    to: Readonly<{ section: string; module?: string }>;
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
