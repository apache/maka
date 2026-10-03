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
import { userFacingText } from '@maka/core/session';
import type { ComposerHandle } from '@maka/ui';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from '../../../application/contracts/session-workspace-errors.js';
import type { ComposerSubmissionServices } from '../submission-services.js';
import {
  acquireSessionCopyAttempt,
  abandonSessionCopyAttempt,
  completeSessionCopyAttempt,
  startSessionCopyAttempt,
  type SessionCopyAttemptPhase,
  type SessionCopyAttemptKey,
} from '../../../application/contracts/session-copy-attempt.js';

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

/** Active edit-and-resend draft, owned by the Composer submission owner. */
export type TurnRevisionDraft = {
  sourceSessionId: string;
  sourceTurnId: string;
  copyId: string;
  copyPhase: SessionCopyAttemptPhase;
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  /** Composer text that was present before edit began; restored on cancel.
   *  Staged Skills ride along inside it as `/skill:<id>` chips. */
  previousComposerText: string;
};

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
 * creating another version. Attachment-bearing source messages are rejected
 * until the revision draft can carry their target-owned references (#5109);
 * retained historical attachments are fine — the Host revision copier
 * rewrites their Session refs losslessly.
 */
export function createRevisionActions(deps: {
  services: Pick<ComposerSubmissionServices, 'reviseBeforeTurn' | 'abandonSessionCopy'>;
  uiLocale: UiLocale;
  activeIdRef: ReadonlyRef<string | undefined>;
  captureSelection(): () => boolean;
  composerRef: ReadonlyRef<ComposerHandle | null>;
  readMessages(): readonly StoredMessage[];
  hasPendingAttachments: () => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  refreshSessions: () => Promise<unknown>;
  commitRevisionDraft: (draft: TurnRevisionDraft | null) => void;
  revisionDraftRef: ReadonlyRef<TurnRevisionDraft | null>;
  toastApi: ToastApi;
}): RevisionActions {
  const {
    services,
    uiLocale,
    activeIdRef,
    captureSelection,
    composerRef,
    readMessages,
    hasPendingAttachments,
    openSessionInChat,
    refreshSessions,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
  } = deps;
  const copy = getDesktopConversationCopy(uiLocale).actions;

  function revisionCopyKey(sourceSessionId: string, sourceTurnId: string): SessionCopyAttemptKey {
    return {
      scope: `edit-and-resend:${sourceTurnId}`,
      kind: 'revision',
      sourceSessionId,
    };
  }

  function beginEditUserMessage(turnId: string): void {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const existing = revisionDraftRef.current;
    if (existing) {
      if (existing.draftSessionId === sessionId && existing.sourceTurnId === turnId) {
        composerRef.current?.focus();
      } else {
        toastApi.info(copy.revisionUnavailableTitle, copy.revisionAlreadyActive);
      }
      return;
    }
    if (hasPendingAttachments()) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionDraftAttachmentConflict);
      return;
    }
    const userMessage = readMessages().find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!userMessage) {
      toastApi.error(
        copy.operationFailedTitle,
        copy.operationFailedFallback,
        undefined,
        { sessionId },
      );
      return;
    }

    if (userMessage.attachments && userMessage.attachments.length > 0) {
      // Attachment references are session-owned and their rewritten targets
      // are not exposed to clients yet, so those stay explicitly rejected.
      // Quotes never reach this point: chat-turn's editDisabled gate excludes them.
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionAttachmentsUnsupported);
      return;
    }
    if (userMessage.displayText !== undefined && userMessage.displayText !== userMessage.text) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionTransformedTextUnsupported);
      return;
    }

    const prompt = userFacingText(userMessage);
    const copyAttempt = acquireSessionCopyAttempt(
      revisionCopyKey(sessionId, turnId),
      turnId,
    );
    commitRevisionDraft({
      sourceSessionId: sessionId,
      sourceTurnId: copyAttempt.sourceTurnId,
      copyId: copyAttempt.copyId,
      copyPhase: copyAttempt.phase,
      draftSessionId: sessionId,
      previousComposerText: composerRef.current?.getText() ?? '',
    });
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
    toastApi.info(copy.revisionStartedTitle, copy.revisionStartedDescription);
  }

  async function rollbackPreparedRevision(
    draft: TurnRevisionDraft,
    revisionSessionId: string,
    text: string,
    selectionIsCurrent: () => boolean,
  ): Promise<void> {
    composerRef.current?.clearDraft(revisionSessionId);
    const current = revisionDraftRef.current;
    if (selectionIsCurrent() && activeIdRef.current === revisionSessionId) {
      openSessionInChat(draft.sourceSessionId);
      selectionIsCurrent = captureSelection();
    }
    const abandonment = await abandonRevisionCopy(draft);
    const abandoningDraft = abandonment.draft;
    let restored: TurnRevisionDraft | undefined;
    if (current?.copyId === draft.copyId && revisionDraftRef.current === abandoningDraft) {
      if (abandonment.acknowledged) {
        const nextAttempt = acquireSessionCopyAttempt(
          revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId),
          draft.sourceTurnId,
        );
        restored = {
          ...draft,
          sourceTurnId: nextAttempt.sourceTurnId,
          copyId: nextAttempt.copyId,
          copyPhase: nextAttempt.phase,
          draftSessionId: draft.sourceSessionId,
        };
      } else {
        restored = { ...abandoningDraft, draftSessionId: draft.sourceSessionId };
      }
      composerRef.current?.setDraft(draft.sourceSessionId, text);
      commitRevisionDraft(restored);
    }
    if (selectionIsCurrent() && activeIdRef.current === draft.sourceSessionId && revisionDraftRef.current === restored) {
      composerRef.current?.setText(text);
      composerRef.current?.focus();
    }
    await refreshSessions().catch(() => []);
  }

  async function abandonRevisionCopy(
    draft: TurnRevisionDraft,
  ): Promise<{ acknowledged: boolean; draft: TurnRevisionDraft }> {
    const tracked = abandonSessionCopyAttempt(
      revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId),
      draft.copyId,
    );
    const current = revisionDraftRef.current;
    const trackedDraft = current?.copyId === draft.copyId ? current : draft;
    const abandoningDraft =
      tracked && trackedDraft.copyPhase !== 'abandoning'
        ? { ...trackedDraft, copyPhase: 'abandoning' as const }
        : trackedDraft;
    if (revisionDraftRef.current === trackedDraft && abandoningDraft !== trackedDraft) {
      commitRevisionDraft(abandoningDraft);
    }
    try {
      // Main acknowledges only after the cleanup intent is durable; physical
      // removal may finish after this renderer has closed the draft.
      await services.abandonSessionCopy(draft.sourceSessionId, draft.copyId);
      completeTurnRevisionCopyAttempt(draft);
      return { acknowledged: true, draft: abandoningDraft };
    } catch {
      // An ambiguous cleanup acknowledgement stays in `abandoning`; this
      // target may only retry cleanup and can never be copied into again.
      return { acknowledged: false, draft: abandoningDraft };
    }
  }

  async function prepareRevisionSend(text: string): Promise<boolean> {
    let selectionIsCurrent = captureSelection();
    let draft = revisionDraftRef.current;
    if (!draft || activeIdRef.current !== draft.draftSessionId) return false;
    // A previous attempt already prepared the version; retry normal send there.
    if (draft.draftSessionId !== draft.sourceSessionId) return true;

    if (draft.copyPhase === 'abandoning') {
      const abandonment = await abandonRevisionCopy(draft);
      if (
        !selectionIsCurrent() || !abandonment.acknowledged ||
        revisionDraftRef.current !== abandonment.draft ||
        activeIdRef.current !== draft.sourceSessionId
      ) {
        return false;
      }
      const nextAttempt = acquireSessionCopyAttempt(
        revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId),
        draft.sourceTurnId,
      );
      draft = {
        ...draft,
        copyId: nextAttempt.copyId,
        copyPhase: nextAttempt.phase,
      };
      commitRevisionDraft(draft);
    }

    const startedDraft =
      draft.copyPhase === 'started' ? draft : { ...draft, copyPhase: 'started' as const };
    if (startedDraft !== draft) {
      if (
        !startSessionCopyAttempt(
          revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId),
          draft.copyId,
        )
      ) {
        return false;
      }
      commitRevisionDraft(startedDraft);
    }
    const sourceSessionId = startedDraft.sourceSessionId;
    let preparedSessionId: string | undefined;
    try {
      const newSession = await services.reviseBeforeTurn(sourceSessionId, {
        sourceTurnId: startedDraft.sourceTurnId,
        copyId: startedDraft.copyId,
      });
      preparedSessionId = newSession.id;
      if (!selectionIsCurrent() || revisionDraftRef.current !== startedDraft) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text, selectionIsCurrent);
        return false;
      }

      const prepared = { ...startedDraft, draftSessionId: newSession.id };
      composerRef.current?.setDraft(newSession.id, text);
      commitRevisionDraft(prepared);
      openSessionInChat(newSession.id);
      selectionIsCurrent = captureSelection();
      await refreshSessions();
      if (!selectionIsCurrent() || revisionDraftRef.current !== prepared) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text, selectionIsCurrent);
        return false;
      }
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      return true;
    } catch (error) {
      // Rollback itself navigates back to the source Session, so the failure
      // must be surfaced before it runs — checking after it is always stale.
      if (selectionIsCurrent()) {
        if (isSessionWorkspaceUnavailableError(error)) {
          showSessionWorkspaceUnavailableToast(toastApi, getShellCopy(uiLocale).errors, {
            sessionId: sourceSessionId,
          });
        } else {
          toastApi.error(
            copy.operationFailedTitle,
            localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
            undefined,
            { sessionId: sourceSessionId },
          );
        }
      }
      if (preparedSessionId) {
        await rollbackPreparedRevision(startedDraft, preparedSessionId, text, selectionIsCurrent);
      }
      return false;
    }
  }

  async function cancelRevisionDraft() {
    let selectionIsCurrent = captureSelection();
    const draft = revisionDraftRef.current;
    if (!draft) return;
    const cleanupSessionId = draft.copyPhase !== 'reserved'
      ? draft.draftSessionId !== draft.sourceSessionId
        ? draft.draftSessionId
        : draft.copyId
      : undefined;
    if (cleanupSessionId) await abandonRevisionCopy(draft);
    else completeTurnRevisionCopyAttempt(draft);
    commitRevisionDraft(null);
    composerRef.current?.setDraft(draft.sourceSessionId, draft.previousComposerText);
    if (draft.draftSessionId !== draft.sourceSessionId) {
      composerRef.current?.clearDraft(draft.draftSessionId);
    }
    if (selectionIsCurrent() && activeIdRef.current !== draft.sourceSessionId) {
      openSessionInChat(draft.sourceSessionId);
      selectionIsCurrent = captureSelection();
    }
    if (cleanupSessionId) {
      await refreshSessions().catch(() => []);
    }
    if (selectionIsCurrent() && activeIdRef.current === draft.sourceSessionId) {
      composerRef.current?.setText(draft.previousComposerText);
      composerRef.current?.focus();
    }
  }

  return { beginEditUserMessage, prepareRevisionSend, cancelRevisionDraft };
}

export function completeTurnRevisionCopyAttempt(draft: TurnRevisionDraft): void {
  completeSessionCopyAttempt(
    {
      scope: `edit-and-resend:${draft.sourceTurnId}`,
      kind: 'revision',
      sourceSessionId: draft.sourceSessionId,
    },
    draft.copyId,
  );
}

export async function abandonTurnRevisionCopyAttempt(
  services: Pick<ComposerSubmissionServices, 'abandonSessionCopy'>,
  draft: TurnRevisionDraft,
): Promise<boolean> {
  const key: SessionCopyAttemptKey = {
    scope: `edit-and-resend:${draft.sourceTurnId}`,
    kind: 'revision',
    sourceSessionId: draft.sourceSessionId,
  };
  abandonSessionCopyAttempt(key, draft.copyId);
  try {
    await services.abandonSessionCopy(draft.sourceSessionId, draft.copyId);
    completeSessionCopyAttempt(key, draft.copyId);
    return true;
  } catch {
    return false;
  }
}
