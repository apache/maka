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

/**
 * Derivation of the session health notice shown above the composer.
 *
 * #1038 — the notice answers exactly one question: "will the next send
 * fail for a recoverable connection/session reason, and what should the
 * user do?". The answer comes from `projectSessionSendOutcome`, already
 * resolved by main and carried in the onboarding snapshot. Runtime Host
 * remains the submission authority; the renderer only maps this
 * compatibility projection to copy:
 *
 *   - `ready` / `rebind` → no notice (`rebind` supplies a compatible
 *     target for renderer readiness checks, #1032).
 *   - `blocked` → destructive notice whose copy names the recovery action;
 *     identity repair opens the exact model picker, configuration repair opens
 *     the matching Settings section.
 *
 * `lastTestStatus` is an intentional pre-send reminder (product contract
 * decided in #1038). E4 locks that it must NOT gate send, so here it
 * must never claim send is blocked either: it renders only as a
 * `warning`, only when the projection says the session's own connection
 * will serve the next send (`ready`), and its copy states plainly that
 * the send is not intercepted. When the projection selects a compatibility
 * target instead, the reminder about the stored connection is noise and
 * stays silent.
 */

import { type IdentifiedLlmConnection } from '@maka/core/llm-connections';

import { type SessionSendProjection, type SessionSendProjectionSession } from '@maka/core/session-send-projection';

import { type UiLocale } from '@maka/core/ui-locale';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

export interface SessionHealthNoticeInput {
  locale: UiLocale;
  /**
   * The active session's send-relevant header facts. `undefined` when no
   * session is active → no notice. `backend` is `string` (not
   * `BackendKind`) so legacy on-disk values like `'claude'` surface
   * exactly as stored.
   */
  session: SessionSendProjectionSession | undefined;
  /** Main-process projection from the latest onboarding snapshot. */
  outcome: SessionSendProjection | undefined;
  /** Persisted connections are used only to name a blocked session's own connection. */
  connections: readonly IdentifiedLlmConnection[];
  /** Whether the current surface can offer an exact account-and-model choice. */
  hasModelChoices: boolean;
  /** False while the active Host's first connection snapshot is still loading. */
  modelChoicesSettled: boolean;
  /** True while the existing model switcher cannot safely mutate this Session. */
  modelPickerDisabled: boolean;
  /**
   * The session's own connection's most recent credential test result.
   * Advisory reminder only — never interpreted as a send block (E4).
   */
  lastTestStatus: 'verified' | 'needs_reauth' | 'error' | undefined;
}

// Configuration failures remain owned by 设置 · 模型. Identity recovery is
// different: an existing catalog choice is selected from the composer's exact
// model picker. Loading retries here; credential repair remains in Settings.
export type SessionHealthNoticeTarget = 'models' | 'model_picker' | 'model_choices_refresh';

export interface SessionHealthNotice {
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the notice. */
  label: string;
  /** Longer explanation for tooltip / assistive text. */
  tooltip?: string;
  /** Optional action-specific label; Settings actions use the shared fallback. */
  actionLabel?: string;
  /** A live Turn or pending switch keeps the recovery action visible but inert. */
  actionDisabled?: boolean;
  /** Which recovery surface the click handler should open. */
  onClickTarget: SessionHealthNoticeTarget;
}

export function deriveSessionHealthNotice(
  input: SessionHealthNoticeInput,
): SessionHealthNotice | undefined {
  const { session, outcome } = input;
  if (!session || !outcome) return undefined;

  if (outcome.kind === 'blocked') return blockedNotice(outcome, input);
  return credentialReminderNotice(input.lastTestStatus, input.locale);
}

function blockedNotice(
  outcome: Extract<SessionSendProjection, { kind: 'blocked' }>,
  input: SessionHealthNoticeInput,
): SessionHealthNotice {
  const session = input.session!;
  const own = input.connections.find(
    (connection) =>
      connection.connectionId === session.llmConnectionId &&
      connection.slug === session.llmConnectionSlug,
  );
  const name = own?.name ?? session.llmConnectionSlug;
  const healthCopy = getDesktopConversationCopy(input.locale).health;
  const copy = healthCopy.blocked[outcome.reason];
  const identityRecovery =
    outcome.reason === 'legacy_connection_identity' ||
    outcome.reason === 'connection_missing' ||
    outcome.reason === 'connection_identity_mismatch';
  if (identityRecovery && !input.modelChoicesSettled) {
    return {
      tone: 'destructive',
      label: copy.label,
      tooltip: healthCopy.connectionChoicesLoading.tooltip,
      actionLabel: healthCopy.connectionChoicesLoading.actionLabel,
      onClickTarget: 'model_choices_refresh',
    };
  }
  const opensModelPicker = identityRecovery && input.hasModelChoices;
  return {
    tone: 'destructive',
    label: copy.label,
    tooltip: opensModelPicker
      ? copy.tooltip(name, session.model)
      : (copy.settingsTooltip?.(name, session.model) ?? copy.tooltip(name, session.model)),
    ...(opensModelPicker && copy.actionLabel ? { actionLabel: copy.actionLabel } : {}),
    ...(opensModelPicker && input.modelPickerDisabled ? { actionDisabled: true } : {}),
    onClickTarget: opensModelPicker ? 'model_picker' : 'models',
  };
}

/**
 * The intentional `lastTestStatus` reminder (#1038 contract): warning
 * tone only, copy states the send is NOT intercepted, Settings remains
 * the fix home. Only called when the projection is `ready`.
 */
function credentialReminderNotice(
  lastTestStatus: SessionHealthNoticeInput['lastTestStatus'],
  locale: UiLocale,
): SessionHealthNotice | undefined {
  const copy = getDesktopConversationCopy(locale).health;
  if (lastTestStatus === 'needs_reauth') {
    return {
      tone: 'warning',
      label: copy.reauth.label,
      tooltip: copy.reauth.tooltip,
      onClickTarget: 'models',
    };
  }
  if (lastTestStatus === 'error') {
    return {
      tone: 'warning',
      label: copy.testError.label,
      tooltip: copy.testError.tooltip,
      onClickTarget: 'models',
    };
  }
  return undefined;
}
