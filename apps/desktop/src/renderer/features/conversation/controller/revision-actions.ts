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

import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComposerHandle } from '@maka/ui';
import {
  createRevisionActions as createStagedRevisionActions,
  type TurnRevisionDraftBase,
} from '@maka/ui';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import * as sessionCopyAttempts from '../../../application/contracts/session-copy-attempt.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from '../../../application/contracts/session-workspace-errors.js';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import type { ComposerSubmissionServices } from '../submission-services.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';

type ReadonlyRef<T> = { readonly current: T };

type ToastApi = {
  info(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
};

/**
 * The desktop revision draft: the shared lifecycle's draft extended with the
 * staged-context snapshot the edit restages into the composer plates (#5109).
 */
export type TurnRevisionDraft = TurnRevisionDraftBase<string>;

export interface RevisionActions {
  beginEditUserMessage(turnId: string): void;
  /** Lazily create the before-turn branch immediately before normal send. */
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
 * assembler injects the submission services, the locale catalog, and the
 * copy-attempt tracker, and derives both the pending-context probe and the
 * live plate reads from the shell's one persistent staging handle.
 */
export function createRevisionActions(deps: {
  services: Pick<ComposerSubmissionServices, 'reviseBeforeTurn' | 'abandonSessionCopy'>;
  uiLocale: UiLocale;
  activeIdRef: ReadonlyRef<string | undefined>;
  captureSelection(): () => boolean;
  composerRef: ReadonlyRef<ComposerHandle | null>;
  readMessages(): readonly StoredMessage[];
  /** The persistent staging owner: the gate's pending-context probe and the
   *  lifecycle's live plate reads both derive from this one handle. */
  staging: ComposerStagingCommands;
  openSessionInChat(sessionId: string, turnId?: string): void;
  refreshSessions(): Promise<unknown>;
  commitRevisionDraft(draft: TurnRevisionDraft | null): void;
  revisionDraftRef: ReadonlyRef<TurnRevisionDraft | null>;
  toastApi: ToastApi;
}): RevisionActions {
  const actions = createStagedRevisionActions<string, TurnRevisionDraft>({
    uiLocale: deps.uiLocale,
    activeIdRef: deps.activeIdRef,
    captureSelection: deps.captureSelection,
    composerRef: deps.composerRef,
    readMessages: deps.readMessages,
    hasPendingAttachments: () => deps.staging.captureSubmission().hasPendingContext,
    stagedContext: deps.staging.stagedContext,
    openSessionInChat: deps.openSessionInChat,
    refreshSessions: async () => {
      await deps.refreshSessions();
      return [];
    },
    commitRevisionDraft: deps.commitRevisionDraft,
    revisionDraftRef: deps.revisionDraftRef,
    toastApi: deps.toastApi,
    copy: getDesktopConversationCopy(deps.uiLocale).actions,
    reviseBeforeTurn: (sourceSessionId, input) =>
      deps.services.reviseBeforeTurn(sourceSessionId, input),
    abandonSessionCopy: (sourceSessionId, copyId) =>
      deps.services.abandonSessionCopy(sourceSessionId, copyId),
    localizedShellErrorMessage: (error, fallback, locale) =>
      localizedShellErrorMessage(error, fallback, locale),
    reportSessionWorkspaceUnavailable: (error, sessionId) => {
      if (!isSessionWorkspaceUnavailableError(error)) return false;
      showSessionWorkspaceUnavailableToast(deps.toastApi, getShellCopy(deps.uiLocale).errors, {
        sessionId,
      });
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

/**
 * Module-level copy-attempt bookkeeping a send needs beside the lifecycle:
 * completion on send, and abandonment with the same ambiguous-acknowledgement
 * contract the lifecycle above uses.
 */
export function completeTurnRevisionCopyAttempt(draft: TurnRevisionDraft): void {
  sessionCopyAttempts.completeSessionCopyAttempt(
    {
      scope: `edit-and-resend:${draft.sourceTurnId}`,
      kind: 'revision',
      sourceSessionId: draft.sourceSessionId,
    } as never,
    draft.copyId,
  );
}

export async function abandonTurnRevisionCopyAttempt(
  services: Pick<ComposerSubmissionServices, 'abandonSessionCopy'>,
  draft: TurnRevisionDraft,
): Promise<boolean> {
  const key = {
    scope: `edit-and-resend:${draft.sourceTurnId}`,
    kind: 'revision',
    sourceSessionId: draft.sourceSessionId,
  } as never;
  sessionCopyAttempts.abandonSessionCopyAttempt(key, draft.copyId);
  try {
    await services.abandonSessionCopy(draft.sourceSessionId, draft.copyId);
    sessionCopyAttempts.completeSessionCopyAttempt(key, draft.copyId);
    return true;
  } catch {
    return false;
  }
}
