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

import * as sessionCopyAttempts from './session-copy-attempt.js';
import { readSettledMessages } from './platform/desktop/session-message-settlement.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { isSessionWorkspaceUnavailableError, showSessionWorkspaceUnavailableToast } from './session-workspace-errors.js';
import {
  createRevisionActions,
  createTurnRevisionCopyHelpers,
  type RevisionActionsEnv,
  type TurnRevisionDraftBase,
} from '@maka/ui';

/**
 * The desktop revision draft: the shared staged-context source bound to the
 * shell's copy-attempt phases.
 */
export type TurnRevisionDraft = TurnRevisionDraftBase<string>;

type DesktopRevisionActionsDeps = Omit<
  RevisionActionsEnv<string, TurnRevisionDraft>,
  | 'copy'
  | 'reviseBeforeTurn'
  | 'abandonSessionCopy'
  | 'readSettledMessages'
  | 'localizedShellErrorMessage'
  | 'isSessionWorkspaceUnavailableError'
  | 'showSessionWorkspaceUnavailableToast'
  | 'acquireCopyAttempt'
  | 'startCopyAttempt'
  | 'abandonCopyAttempt'
  | 'completeCopyAttempt'
  | 'commitRevisionDraft'
> & {
  /** The shell's draft state is bound to the concrete desktop draft type. */
  commitRevisionDraft(draft: TurnRevisionDraft | null): void;
};

export interface AppShellRevisionActions {
  beginEditUserMessage(turnId: string): void;
  prepareRevisionSend(text: string): Promise<boolean>;
  cancelRevisionDraft(): Promise<void>;
}

/**
 * Desktop edit-and-resend follows the CLI rewind boundary without creating an
 * empty branch at click time:
 *
 *   edit click -> local composer draft only
 *   send       -> reviseBeforeTurn -> switch version -> normal send
 *
 * If normal send fails after a revision was prepared, that version remains
 * active with the edited text and a second send retries there instead of
 * creating another version. The lifecycle itself lives in `@maka/ui`; this
 * assembler injects the bridge, the locale catalog, and the copy-attempt
 * tracker.
 */
export function createAppShellRevisionActions(
  deps: DesktopRevisionActionsDeps,
): AppShellRevisionActions {
  const actions = createRevisionActions({
    ...deps,
    commitRevisionDraft: (draft) => deps.commitRevisionDraft(draft as TurnRevisionDraft),
    copy: getDesktopConversationCopy(deps.uiLocale).actions,
    reviseBeforeTurn: (sourceSessionId, input) =>
      window.maka.sessions.reviseBeforeTurn(sourceSessionId, input),
    abandonSessionCopy: (sourceSessionId, copyId) =>
      window.maka.sessions.abandonSessionCopy(sourceSessionId, copyId),
    readSettledMessages: (sessionId, options) => readSettledMessages(sessionId, options),
    localizedShellErrorMessage: (error, fallback, locale) =>
      localizedShellErrorMessage(error, fallback, locale),
    reportSessionWorkspaceUnavailable: (error, sessionId) => {
      if (!isSessionWorkspaceUnavailableError(error)) return false;
      showSessionWorkspaceUnavailableToast(deps.toastApi, deps.uiLocale, { sessionId });
      return true;
    },
    acquireCopyAttempt: (key, turnId) =>
      sessionCopyAttempts.acquireSessionCopyAttempt(key as never, turnId),
    startCopyAttempt: (key, copyId) =>
      sessionCopyAttempts.startSessionCopyAttempt(key as never, copyId),
    abandonCopyAttempt: (key, copyId) =>
      sessionCopyAttempts.abandonSessionCopyAttempt(key as never, copyId),
    completeCopyAttempt: (key, copyId) =>
      sessionCopyAttempts.completeSessionCopyAttempt(key as never, copyId),
  });
  return {
    beginEditUserMessage: actions.beginEditUserMessage,
    prepareRevisionSend: actions.prepareRevisionSend,
    cancelRevisionDraft: actions.cancelRevisionDraft,
  };
}

const turnRevisionCopyHelpers = createTurnRevisionCopyHelpers<
  string,
  TurnRevisionDraft
>({
  completeCopyAttempt: (key, copyId) =>
    sessionCopyAttempts.completeSessionCopyAttempt(key as never, copyId),
  abandonCopyAttempt: (key, copyId) =>
    sessionCopyAttempts.abandonSessionCopyAttempt(key as never, copyId),
  abandonSessionCopy: (sourceSessionId, copyId) =>
    window.maka.sessions.abandonSessionCopy(sourceSessionId, copyId),
});

export const completeTurnRevisionCopyAttempt = turnRevisionCopyHelpers.completeTurnRevisionCopyAttempt;

export const abandonTurnRevisionCopyAttempt = turnRevisionCopyHelpers.abandonTurnRevisionCopyAttempt;
