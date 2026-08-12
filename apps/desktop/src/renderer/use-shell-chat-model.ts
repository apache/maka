import { useMemo, useState } from 'react';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionSendProjection } from '@maka/core/session-send-projection';
import type { SessionSummary } from '@maka/core/session';
import type { SettingsSection } from '@maka/core/settings';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  chatModelChoiceLabel,
  pickNewChatModel,
  type NewChatModel,
} from './shell-chat-model-selection';
import { deriveSessionHealthNotice } from './session-health-notice';
import type { ComposerDefaults } from './composer-defaults';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export type { NewChatModel } from './shell-chat-model-selection';

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
  snapshotChoices: ChatModelChoice[] | undefined;
  sessionSendOutcome: SessionSendProjection | undefined;
  defaultConnection: string | null;
  activationCandidate?: NewChatModel;
  activeSession: SessionSummary | undefined;
  persistedComposerDefaults: ComposerDefaults | null;
  /** Settings → 通用 → 默认思考级别; undefined means "no preference". */
  defaultThinkingLevel?: ThinkingLevel;
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
  const { uiLocale, connections, defaultConnection, activationCandidate, activeSession, persistedComposerDefaults, openSettingsSection } = options;
  const conversationCopy = getDesktopConversationCopy(uiLocale);
  // Persisted composer defaults seed the empty-state model so the home view is
  // populated before the async `app:info` round-trip completes on mount.
  const [pendingNewChatModel, setPendingNewChatModel] = useState<NewChatModel | null>(
    persistedComposerDefaults?.model ?? null,
  );
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const chatModelChoices = options.snapshotChoices ?? [];
  // Home / empty-state composer: which model the next NEW chat starts with.
  // An explicit pick stays sticky; otherwise onboarding's readiness-checked
  // candidate wins before the legacy catalog default and first offered choice.
  // Renderer-only — it never mutates the persisted Settings · 模型 default.
  // Three states, because two cannot say this: `undefined` is an untouched
  // picker, so Settings → 通用 → 默认思考级别 applies; `null` is the user
  // explicitly choosing 模型默认 for this one chat, which must beat the
  // configured default or the per-chat picker could not undo it.
  //
  // The settings value is read here rather than seeded into useState because it
  // arrives from an async settings fetch, after this hook first mounts — a
  // useState initializer would silently keep the mount-time `undefined` and the
  // setting would never take effect. (`persistedComposerDefaults` above can use
  // an initializer only because it is read synchronously from localStorage.)
  const [pendingNewChatThinkingLevel, setPendingNewChatThinkingLevel] = useState<
    ThinkingLevel | null | undefined
  >(undefined);
  const requestedNewChatThinkingLevel =
    pendingNewChatThinkingLevel === undefined
      ? options.defaultThinkingLevel ?? null
      : pendingNewChatThinkingLevel;
  // A pick only stays in effect while it is still an offered choice. If the user
  // later disables/removes that connection or model, fall through to another
  // offered candidate so the home chip never shows — nor sends — a stale model.
  const catalogDefaultChoice = chatModelChoices.find(
    (choice) => choice.connectionSlug === defaultConnection && choice.isDefault,
  );
  const catalogDefaultNewChatModel = catalogDefaultChoice
    ? { llmConnectionSlug: catalogDefaultChoice.connectionSlug, model: catalogDefaultChoice.model }
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
    : activeSession?.model || activeConnection?.defaultModel;
  const activeModelLabel = activeSession?.backend === 'fake'
    ? undefined
    : chatModelChoiceLabel(chatModelChoices, activeSession?.llmConnectionSlug, activeModel);
  const activeThinkingLevels = useMemo(
    () => chatModelChoices.find(
      (choice) => choice.connectionSlug === activeSession?.llmConnectionSlug && choice.model === activeModel,
    )?.thinkingLevels ?? [],
    [activeSession?.llmConnectionSlug, activeModel, chatModelChoices],
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
      return chatModelChoices.find(
        (choice) => choice.connectionSlug === newChatModel.llmConnectionSlug && choice.model === newChatModel.model,
      )?.thinkingLevels ?? [];
    },
    [newChatModel, chatModelChoices],
  );
  // The membership check is what keeps a configured default honest: a level the
  // current model does not offer falls through to that model's own default
  // rather than being forced to the nearest rung.
  const newChatThinkingLevel = requestedNewChatThinkingLevel && newChatThinkingLevels.includes(requestedNewChatThinkingLevel)
    ? requestedNewChatThinkingLevel
    : undefined;
  const newChatModelLabel = chatModelChoiceLabel(chatModelChoices, newChatModel?.llmConnectionSlug, newChatModel?.model);

  // Notice derivation is a pure function (see `session-health-notice.ts`); we
  // wrap the returned `onClickTarget` here with the Settings-jump action.
  const sessionHealthNotice = useMemo<SessionHealthNoticeView | undefined>(() => {
    const derived = deriveSessionHealthNotice({
      locale: uiLocale,
      session: activeSession,
      outcome: options.sessionSendOutcome,
      connections,
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
    activeSession?.llmConnectionSlug,
    activeSession?.model,
    options.sessionSendOutcome,
    connections,
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
    // Resolved, not raw: callers want the level the next chat would actually
    // request, and must not have to re-apply the settings fallback themselves.
    pendingNewChatThinkingLevel: requestedNewChatThinkingLevel,
    setPendingNewChatThinkingLevel,
    sessionHealthNotice,
  };
}
