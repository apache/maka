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
 * fail for a recoverable connection/session reason, and where should the
 * user go?". The answer comes from `projectSessionSendOutcome`, already
 * resolved by main and carried in the onboarding snapshot. Runtime Host
 * remains the submission authority; the renderer only maps this
 * compatibility projection to copy:
 *
 *   - `ready` / `rebind` → no notice (`rebind` supplies a compatible
 *     target for renderer readiness checks, #1032).
 *   - `blocked` → destructive notice whose copy names the failing
 *     connection and points at the matching Settings section.
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

import { type LlmConnection } from '@maka/core/llm-connections';

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
  connections: readonly LlmConnection[];
  /**
   * The session's own connection's most recent credential test result.
   * Advisory reminder only — never interpreted as a send block (E4).
   */
  lastTestStatus: 'verified' | 'needs_reauth' | 'error' | undefined;
}

// #1209 (U1): every health-notice CTA points at 设置 · 模型 — the single
// place that manages model connections, credentials, and OAuth. The former
// 'account' target routed to a redundant page that has since been retired.
export type SessionHealthNoticeTarget = 'models';

export interface SessionHealthNotice {
  tone: 'info' | 'warning' | 'destructive';
  /** Short label shown inside the notice. */
  label: string;
  /** Longer explanation for tooltip / assistive text. */
  tooltip?: string;
  /** Which Settings section the click handler should navigate to. */
  onClickTarget: SessionHealthNoticeTarget;
}

export function deriveSessionHealthNotice(
  input: SessionHealthNoticeInput,
): SessionHealthNotice | undefined {
  const { session, outcome } = input;
  if (!session || !outcome) return undefined;

  if (outcome.kind === 'blocked') return blockedNotice(outcome, input);
  if (outcome.kind === 'rebind') return undefined;
  return credentialReminderNotice(input.lastTestStatus, input.locale);
}

function blockedNotice(
  outcome: Extract<SessionSendProjection, { kind: 'blocked' }>,
  input: SessionHealthNoticeInput,
): SessionHealthNotice {
  const session = input.session!;
  const own = input.connections.find((connection) => connection.slug === session.llmConnectionSlug);
  const name = own?.name ?? session.llmConnectionSlug;
  const copy = getDesktopConversationCopy(input.locale).health.blocked[outcome.reason];
  return {
    tone: 'destructive',
    label: copy.label,
    tooltip: copy.tooltip(name, session.model),
    onClickTarget: 'models',
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
