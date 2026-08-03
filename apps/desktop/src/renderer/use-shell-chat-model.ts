import { useEffect, useMemo, useState } from 'react';
import type { LlmConnection, SessionSummary, SettingsSection, ThinkingLevel, UiLocale } from '@maka/core';
import { thinkingVariantsForModel } from '@maka/core';
import type { ChatModelChoice } from '@maka/ui';
import { deriveSessionHealthNotice } from './session-health-notice';
import { pickCatalogDefaultChatModel, pickNewChatModel } from './model-catalog-choices';
import { buildChatModelChoices, chatModelChoiceLabel, normalizeActiveChatModel } from './chat-model-selection';
import type { ComposerDefaults } from './composer-defaults';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export type NewChatModel = { llmConnectionSlug: string; model: string };

export type SessionHealthNoticeView = {
  tone: 'info' | 'warning' | 'destructive';
  label: string;
  tooltip?: string;
  onClick(): void;
  onClickTarget: 'models';
};

/**
 * Owns every value the chat header + composer derive from the LLM-connection
 * list and the active session: the resolved active connection/model labels,
 * the shared model-choice list, the home / empty-state new-chat model + its
 * sticky pick, the thinking-variant lists, and the hard-only session health
 * notice (#1032).
 *
 * Pure move out of AppShell — every memo keeps its exact dependency array (so
 * `chatModelChoices` / `activeThinkingLevels` / `newChatThinkingLevels` retain
 * their referential-stability behavior) and the sticky-pick validation still
 * drops a `pendingNewChatModel` that is no longer an offered choice. The
 * `openSettingsSection` jump is injected so `sessionHealthNotice` can wrap the
 * derived click target; its memo deliberately omits the injected handler from
 * the dep array (see the inline note).
 */
export function useShellChatModel(options: {
  uiLocale: UiLocale;
  connections: LlmConnection[];
  /**
   * Refresh counter from `useShellConnections`: bumps on every successful
   * `refreshConnections`, including credential-only changes that keep the
   * list identity (`updatedAt` unchanged). The secret probe below depends
   * on it so those changes re-probe instead of serving stale presence
   * (#1038 review).
   */
  connectionsRevision: number;
  defaultConnection: string | null;
  activationCandidate?: NewChatModel;
  activeSession: SessionSummary | undefined;
  /**
   * True when the active session's loaded transcript already contains a
   * user message. Storage self-heals `connectionLocked` only on
   * `readHeader`/`readMessages`, so a just-opened legacy session's
   * summary can still read unlocked; the loaded transcript is the same
   * primary evidence storage uses, and the notice must not treat the
   * session as rebindable in the meantime (#1038 review).
   */
  activeSessionHasUserMessage: boolean;
  persistedComposerDefaults: ComposerDefaults | null;
  openSettingsSection: (section: SettingsSection) => void;
}): {
  chatModelChoices: ChatModelChoice[];
  activeConnection: LlmConnection | undefined;
  activeConnectionLabel: string | undefined;
  activeModel: string | undefined;
  activeModelLabel: string | undefined;
  activeThinkingLevels: readonly ThinkingLevel[];
  activeThinkingLevel: ThinkingLevel | undefined;
  newChatModel: NewChatModel | undefined;
  newChatModelLabel: string | undefined;
  newChatThinkingLevels: readonly ThinkingLevel[];
  newChatThinkingLevel: ThinkingLevel | undefined;
  pendingNewChatModel: NewChatModel | null;
  setPendingNewChatModel: (next: NewChatModel | null) => void;
  pendingNewChatThinkingLevel: ThinkingLevel | null;
  setPendingNewChatThinkingLevel: (next: ThinkingLevel | null) => void;
  sessionHealthNotice: SessionHealthNoticeView | undefined;
} {
  const { uiLocale, connections, connectionsRevision, defaultConnection, activationCandidate, activeSession, activeSessionHasUserMessage, persistedComposerDefaults, openSettingsSection } = options;
  const conversationCopy = getDesktopConversationCopy(uiLocale);
  // Persisted composer defaults seed the empty-state model so the home view is
  // populated before the async `app:info` round-trip completes on mount.
  const [pendingNewChatModel, setPendingNewChatModel] = useState<NewChatModel | null>(
    persistedComposerDefaults?.model ?? null,
  );
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const defaultConnectionEntry = defaultConnection
    ? connections.find((connection) => connection.slug === defaultConnection)
    : undefined;
  const chatModelChoices = useMemo<ChatModelChoice[]>(
    () => buildChatModelChoices(connections),
    [connections],
  );
  // Home / empty-state composer: which model the next NEW chat starts with.
  // An explicit pick stays sticky; otherwise onboarding's readiness-checked
  // candidate wins before the legacy catalog default and first offered choice.
  // Renderer-only — it never mutates the persisted Settings · 模型 default.
  const [pendingNewChatThinkingLevel, setPendingNewChatThinkingLevel] = useState<ThinkingLevel | null>(null);
  // A pick only stays in effect while it is still an offered choice. If the user
  // later disables/removes that connection or model, fall through to another
  // offered candidate so the home chip never shows — nor sends — a stale model.
  const catalogDefaultNewChatModel = defaultConnectionEntry
    ? pickCatalogDefaultChatModel(defaultConnectionEntry)
    : undefined;
  const newChatModel = pickNewChatModel({
    pending: pendingNewChatModel,
    activationCandidate,
    catalogDefault: catalogDefaultNewChatModel,
    choices: chatModelChoices,
  });
  const activeConnectionLabel = activeSession?.backend === 'fake'
    ? conversationCopy.model.fakeBackendLabel
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  const activeModel = activeSession?.backend === 'fake'
    ? undefined
    : normalizeActiveChatModel(activeSession, activeConnection, chatModelChoices);
  const activeModelLabel = activeSession?.backend === 'fake'
    ? undefined
    : chatModelChoiceLabel(chatModelChoices, activeSession?.llmConnectionSlug, activeModel);
  const activeThinkingLevels = useMemo(
    () => (activeConnection && activeModel) ? thinkingVariantsForModel(activeConnection.providerType, activeModel) : [],
    [activeConnection, activeModel],
  );
  // Only surface a stored level when the current model still supports it;
  // if the model changed (setModel clears it) or the catalog reconfigured so
  // the level is no longer offered, the chip falls back to 默认 instead of
  // advertising a level the runtime would silently drop. The runtime's
  // `buildProviderOptions` is the wire-level guard; this keeps the UI honest.
  const activeThinkingLevel =
    activeSession?.thinkingLevel && activeThinkingLevels.includes(activeSession.thinkingLevel)
      ? activeSession.thinkingLevel
      : undefined;
  const newChatThinkingLevels = useMemo(
    () => {
      if (!newChatModel) return [];
      const c = connections.find((entry) => entry.slug === newChatModel.llmConnectionSlug);
      return c ? thinkingVariantsForModel(c.providerType, newChatModel.model) : [];
    },
    [newChatModel, connections],
  );
  const newChatThinkingLevel = pendingNewChatThinkingLevel && newChatThinkingLevels.includes(pendingNewChatThinkingLevel)
    ? pendingNewChatThinkingLevel
    : undefined;
  const newChatModelLabel = chatModelChoiceLabel(chatModelChoices, newChatModel?.llmConnectionSlug, newChatModel?.model);

  // #1038: the notice decides from the same facts as the send gate, so
  // the renderer needs real secret presence, not the old
  // "default exists && enabled" proxy. Probe every connection's secret
  // via IPC whenever the connection list changes (the list refreshes on
  // every connection mutation, including API-key saves). Until the
  // probe lands, presence is treated optimistically so a destructive
  // notice never flashes on first paint.
  const [secretPresence, setSecretPresence] = useState<Readonly<Record<string, boolean>>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      connections.map(async (connection) => {
        try {
          return [connection.slug, await window.maka.connections.hasSecret(connection.slug)] as const;
        } catch {
          return [connection.slug, true] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setSecretPresence(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [connections, connectionsRevision]);

  // Notice derivation is a pure function (see `session-health-notice.ts`); we
  // wrap the returned `onClickTarget` here with the Settings-jump action.
  const sessionHealthNotice = useMemo<SessionHealthNoticeView | undefined>(() => {
    const derived = deriveSessionHealthNotice({
      locale: uiLocale,
      session: activeSession
        ? {
            backend: activeSession.backend,
            llmConnectionSlug: activeSession.llmConnectionSlug,
            model: activeSession.model,
            // Effective lock: the healed summary bit OR the same primary
            // evidence storage heals from (a user message in the loaded
            // transcript). See the option doc above.
            connectionLocked: activeSession.connectionLocked || activeSessionHasUserMessage,
          }
        : undefined,
      connections,
      defaultSlug: defaultConnection,
      hasSecret: (slug) => secretPresence[slug] ?? true,
      lastTestStatus: activeConnection?.lastTestStatus,
    });
    if (!derived) return undefined;
    const target = derived.onClickTarget;
    return {
      tone: derived.tone,
      label: derived.label,
      ...(derived.tooltip ? { tooltip: derived.tooltip } : {}),
      onClickTarget: target,
      onClick: () => openSettingsSection(target),
    };
    // openSettingsSection is stable enough for our purposes — main.tsx
    // doesn't depend on it changing, and including it would force the
    // effect to re-create on every render due to its function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSession?.id,
    activeSession?.backend,
    activeSession?.llmConnectionSlug,
    activeSession?.model,
    activeSession?.connectionLocked,
    activeSessionHasUserMessage,
    connections,
    defaultConnection,
    secretPresence,
    activeConnection?.lastTestStatus,
    uiLocale,
  ]);

  return {
    chatModelChoices,
    activeConnection,
    activeConnectionLabel,
    activeModel,
    activeModelLabel,
    activeThinkingLevels,
    activeThinkingLevel,
    newChatModel,
    newChatModelLabel,
    newChatThinkingLevels,
    newChatThinkingLevel,
    pendingNewChatModel,
    setPendingNewChatModel,
    pendingNewChatThinkingLevel,
    setPendingNewChatThinkingLevel,
    sessionHealthNotice,
  };
}
