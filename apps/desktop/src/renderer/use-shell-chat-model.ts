/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useMemo } from 'react';
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
import { useNewTaskChoice } from './use-new-task-choice.js';

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
 * The model catalog is derived from the same Host-scoped connection list as
 * the labels and selectors, so switching between Hosts cannot mix catalogs.
 * Sticky picks still drop out when their model is no longer offered.
 */
export function useShellChatModel(options: {
  uiLocale: UiLocale;
  connections: LlmConnection[];
  chatModelChoices: ChatModelChoice[];
  sessionSendOutcome: SessionSendProjection | undefined;
  defaultConnection: string | null;
  newTaskKey: string;
  activationCandidate?: NewChatModel;
  activeSession: SessionSummary | undefined;
  persistedComposerDefaults: ComposerDefaults | null;
  usePersistedComposerDefaults: boolean;
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
  const [pendingNewChatModelChoice, setPendingNewChatModel] = useNewTaskChoice<
    NewChatModel | null
  >(
    options.newTaskKey,
  );
  const pendingNewChatModel = pendingNewChatModelChoice !== undefined
    ? pendingNewChatModelChoice
    : options.usePersistedComposerDefaults
      ? persistedComposerDefaults?.model ?? null
      : null;
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const { chatModelChoices } = options;
  // Home / empty-state composer: which model the next NEW chat starts with.
  // An explicit pick stays sticky; otherwise onboarding's readiness-checked
  // candidate wins before the legacy catalog default and first offered choice.
  // Renderer-only — it never mutates the persisted Settings · 模型 default.
  // Three states, because two cannot say this: `undefined` is an untouched
  // picker, so Settings → 通用 → 默认思考级别 applies; `null` is the user
  // explicitly choosing 模型默认 for this one chat, which must beat the
  // configured default or the per-chat picker could not undo it.
  //
  // The pick carries its target key so a Host or Project switch cannot apply it
  // to a different execution authority, even for an identically named model.
  const [pendingNewChatThinkingLevel, setPendingNewChatThinkingLevel] =
    useNewTaskChoice<ThinkingLevel | null>(
      options.newTaskKey,
    );
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
  // A task whose backend was retired has no model to name (#3211). That verdict
  // comes from the readiness projection, not from reading `activeSession.backend`
  // here: the projection is the single authority on whether a task is usable,
  // and it already answers `fake_backend` for these rows.
  const isRetiredBackend =
    options.sessionSendOutcome?.kind === 'blocked' &&
    options.sessionSendOutcome.reason === 'fake_backend';
  const activeConnectionLabel = isRetiredBackend
    ? conversationCopy.model.fakeBackendLabel
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  const activeModel = isRetiredBackend
    ? undefined
    : activeSession?.model || activeConnection?.defaultModel;
  const activeModelLabel = isRetiredBackend
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
