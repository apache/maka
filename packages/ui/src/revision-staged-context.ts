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

import type { AttachmentRef, QuoteRef } from '@maka/core/events';
import { userFacingText, type StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ComposerHandle } from './composer.js';
import type { PendingAttachment } from './composer-attachments.js';

/**
 * Snapshot of the composer's staged context, read fresh at every use: the
 * staging hooks bind their mutators to the active session's draft key, which
 * moves across the revision commit (source → branch child). Restoring and
 * clearing take an explicit owner key so the lifecycle can re-key the staged
 * quotes across that commit; attachments never enter the plates — a revision
 * copy excludes the revised turn, so no target-owned refs exist to stage
 * (#5109 review) and the lifecycle reads the plate only for conflict gates.
 */
export type RevisionStagedContext = {
  quotes: readonly QuoteRef[];
  attachments: readonly PendingAttachment[];
  restoreQuotes(ownerKey: string, quotes: readonly QuoteRef[]): void;
  clearQuotes(ownerKey: string): void;
};

/** The edit-and-resend source context a staged plate must match verbatim. */
export type RevisionStagedSource = {
  originalQuotes: readonly QuoteRef[];
  originalAttachments: readonly AttachmentRef[];
};

/**
 * Surface-neutral revision draft: the shared staged-context fields every
 * edit-and-resend client carries, parameterized by its copy-attempt phase.
 */
export type TurnRevisionDraftBase<Phase> = {
  sourceSessionId: string;
  sourceTurnId: string;
  copyId: string;
  copyPhase: Phase;
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  originalText: string;
  previousComposerText: string;
  originalQuotes: readonly QuoteRef[];
  originalAttachments: readonly AttachmentRef[];
};


function quoteKey(quote: QuoteRef): string {
  return JSON.stringify([quote.text, quote.label ?? null, quote.sourceTurnId ?? null]);
}

function attachmentToPending(attachment: AttachmentRef): PendingAttachment {
  return {
    stagingKey: `revision:${JSON.stringify(attachment)}`,
    displayName: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.bytes,
    source: { type: 'retained', attachment },
  };
}

function attachmentKey(attachment: PendingAttachment): string {
  return JSON.stringify(
    attachment.source.type === 'retained' ? attachment.source.attachment : attachment.source,
  );
}

/**
 * A send whose text and staged context both match what the edit staged is a
 * no-op retry: the replacement would duplicate the source turn verbatim.
 * Compared in plate order — the restaged source context is the whole plate,
 * because editing is refused while the user has own context staged.
 */
export function revisionStagedContextUnchanged(
  source: RevisionStagedSource,
  originalText: string,
  text: string,
  stagedQuotes: readonly QuoteRef[],
  stagedAttachments: readonly PendingAttachment[],
): boolean {
  if (text.trim() !== originalText.trim()) return false;
  if (stagedQuotes.map(quoteKey).join('\n') !== source.originalQuotes.map(quoteKey).join('\n')) {
    return false;
  }
  return (
    stagedAttachments.map(attachmentKey).join('\n') ===
    source.originalAttachments.map(attachmentToPending).map(attachmentKey).join('\n')
  );
}

/**
 * The pre-send gate for a revision replacement: 'unchanged' blocks a no-op
 * retry that would duplicate the source turn verbatim; 'conflict' blocks a
 * send mixing user-staged context into the restored set (pending directories
 * have no plate snapshot — flagged through pendingContext with an empty
 * attachment plate).
 */
export function stageRevisionSourceContext(
  staged: Pick<RevisionStagedContext, 'restoreQuotes'>,
  ownerKey: string,
  message: { quotes?: readonly QuoteRef[] },
): RevisionStagedSource {
  const sourceQuotes = [...(message.quotes ?? [])];
  if (sourceQuotes.length > 0) staged.restoreQuotes(ownerKey, sourceQuotes);
  return { originalQuotes: sourceQuotes, originalAttachments: [] };
}

/**
 * The pre-send gate for a revision replacement: 'unchanged' blocks a no-op
 * retry that would duplicate the source turn verbatim; 'conflict' blocks a
 * send mixing user-staged context into the restored set (pending directories
 * have no plate snapshot — flagged through pendingContext with an empty
 * attachment plate).
 */
export function revisionSendGate(
  source: RevisionStagedSource,
  originalText: string,
  text: string,
  staged: Pick<RevisionStagedContext, 'quotes' | 'attachments'>,
  pendingContext: boolean,
): 'pass' | 'unchanged' | 'conflict' {
  if (revisionStagedContextUnchanged(source, originalText, text, staged.quotes, staged.attachments)) {
    return 'unchanged';
  }
  if (
    staged.quotes.length > source.originalQuotes.length ||
    staged.attachments.length > source.originalAttachments.length ||
    (pendingContext && staged.attachments.length === 0)
  ) {
    return 'conflict';
  }
  return 'pass';
}

/**
 * Unstage everything the edit staged, wherever the commit left it — the
 * cancel path. The plates hold only the edit's items under the two draft
 * keys (source before the commit, branch child after), because editing is
 * refused while the user has own context staged.
 */
export function clearRevisionStagedContext(
  staged: Pick<RevisionStagedContext, 'clearQuotes'>,
  ownerKeys: readonly string[],
): void {
  for (const ownerKey of new Set(ownerKeys)) staged.clearQuotes(ownerKey);
}

/** Localized strings an edit-and-resend surface needs from its own catalog. */
export interface RevisionEditCopy {
  revisionUnavailableTitle: string;
  revisionAlreadyActive: string;
  revisionDraftAttachmentConflict: string;
  revisionDraftQuoteConflict: string;
  revisionAttachmentsUnsupported: string;
  revisionMixedContextUnsupported: string;
  revisionTransformedTextUnsupported: string;
  revisionStartedTitle: string;
  revisionStartedDescription: string;
  revisionReadyTitle: string;
  revisionReadyDescription: string;
  revisionUnchanged: string;
  operationFailedTitle: string;
  operationFailedFallback: string;
}

/** Identity of one copy attempt, owned by the surface's attempt tracker. */
export interface RevisionCopyKey {
  scope: string;
  kind: string;
  sourceSessionId: string;
}

/** Toast surface used by the revision lifecycle. */
export interface RevisionToastApi {
  info(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
}

/**
 * Everything a surface must inject so the edit-and-resend lifecycle can run
 * without knowing the bridge, the locale catalog, or the attempt tracker:
 * desktop touchpoints arrive as values and callbacks, never as imports.
 *
 * Why this lives in @maka/ui: the desktop renderer's debt ratchet forbids
 * new dependency edges in the legacy shell files, and the lifecycle needs a
 * runtime import of this module's composer types. Surfaces that already hold
 * an @maka/ui edge (app-shell) assemble the env; the injected shell file
 * keeps only type-level contact with this module.
 */
export interface RevisionActionsEnv<
  Phase,
  TDraft extends TurnRevisionDraftBase<Phase>,
> {
  uiLocale: UiLocale;
  activeIdRef: { current: string | undefined };
  captureSelection(): () => boolean;
  composerRef: { current: ComposerHandle | null };
  messages: readonly StoredMessage[];
  hasPendingAttachments(): boolean;
  stagedContext(): RevisionStagedContext;
  openSessionInChat(sessionId: string, turnId?: string): void;
  refreshSessions(): Promise<unknown[]>;
  setMessages(messages: readonly StoredMessage[]): void;
  commitRevisionDraft(draft: TurnRevisionDraftBase<Phase> | null): void;
  revisionDraftRef: { current: TDraft | null };
  toastApi: RevisionToastApi;
  copy: RevisionEditCopy;
  reviseBeforeTurn(
    sourceSessionId: string,
    input: { sourceTurnId: string; copyId: string },
  ): Promise<{ id: string }>;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
  readSettledMessages(
    sessionId: string,
    options: { signal: AbortSignal },
  ): Promise<{ messages: readonly StoredMessage[]; settled: boolean }>;
  localizedShellErrorMessage(error: unknown, fallback: string, locale: UiLocale): string;
  /** True when the error is the workspace-unavailable class, having toasted. */
  reportSessionWorkspaceUnavailable(error: unknown, sessionId: string): boolean;
  acquireCopyAttempt(
    key: RevisionCopyKey,
    turnId: string,
  ): { sourceTurnId: string; copyId: string; phase: Phase };
  startCopyAttempt(key: RevisionCopyKey, copyId: string): boolean;
  abandonCopyAttempt(key: RevisionCopyKey, copyId: string): boolean;
  completeCopyAttempt(key: RevisionCopyKey, copyId: string): void;
}

function revisionCopyKey(
  sourceSessionId: string,
  sourceTurnId: string,
): RevisionCopyKey {
  return {
    scope: `edit-and-resend:${sourceTurnId}`,
    kind: 'revision',
    sourceSessionId,
  };
}

/**
 * The edit-and-resend lifecycle shared by surfaces that stage the selected
 * message's context into composer plates (#5109): edit click stages without
 * branching; send prepares the before-turn branch, swaps the staged
 * attachment refs for the copied message's target-owned refs, and hands back
 * to the surface's normal send. Cancel unbranches and restores the plates.
 */
export function createRevisionActions<
  Phase,
  TDraft extends TurnRevisionDraftBase<Phase>,
>(
  env: RevisionActionsEnv<Phase, TDraft>,
): {
  beginEditUserMessage(turnId: string): void;
  prepareRevisionSend(text: string): Promise<boolean>;
  cancelRevisionDraft(): Promise<void>;
} {
  const {
    uiLocale,
    activeIdRef,
    captureSelection,
    composerRef,
    messages,
    hasPendingAttachments,
    stagedContext,
    openSessionInChat,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    copy,
  } = env;
  let revisionPreparationAbort: AbortController | undefined;

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
    const userMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!userMessage) {
      toastApi.error(copy.operationFailedTitle, copy.operationFailedFallback, undefined, {
        sessionId,
      });
      return;
    }
    if ((userMessage.attachments?.length ?? 0) > 0) {
      // Attachments are session-owned refs, and a revision copy excludes the
      // revised turn, so no target-owned rewrite exists to restage — the
      // replacement would claim files the branch child does not own (#5109
      // review). The edit refuses instead of promising a restage that cannot
      // happen.
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionAttachmentsUnsupported);
      return;
    }

    // The selected message's quotes restage into the composer plate (#5109):
    // the plate makes the carried context visible and explicitly removable,
    // and the commit re-keys it onto the branch child (prepareRevisionSend).
    // The edit refuses while the user has own context staged, so the plate
    // ends up holding exactly the source context.
    const staged = stagedContext();
    if (staged.quotes.length > 0) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionDraftQuoteConflict);
      return;
    }
    if (userMessage.displayText !== undefined && userMessage.displayText !== userMessage.text) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionTransformedTextUnsupported);
      return;
    }

    const prompt = userFacingText(userMessage);
    const copyAttempt = env.acquireCopyAttempt(
      revisionCopyKey(sessionId, turnId),
      turnId,
    );
    const { originalQuotes, originalAttachments } = stageRevisionSourceContext(
      staged,
      sessionId,
      userMessage,
    );
    commitRevisionDraft({
      sourceSessionId: sessionId,
      sourceTurnId: copyAttempt.sourceTurnId,
      copyId: copyAttempt.copyId,
      copyPhase: copyAttempt.phase,
      draftSessionId: sessionId,
      originalText: prompt,
      previousComposerText: composerRef.current?.getText() ?? '',
      originalQuotes,
      originalAttachments,
    });
    composerRef.current?.setText(prompt);
    composerRef.current?.focus();
    toastApi.info(copy.revisionStartedTitle, copy.revisionStartedDescription);
  }

  async function rollbackPreparedRevision(
    draft: TDraft,
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
    let restored: TDraft | undefined;
    if (current?.copyId === draft.copyId && revisionDraftRef.current === abandoningDraft) {
      if (abandonment.acknowledged) {
        const nextAttempt = env.acquireCopyAttempt(
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
    if (
      selectionIsCurrent() && activeIdRef.current === draft.sourceSessionId &&
      revisionDraftRef.current === restored
    ) {
      composerRef.current?.setText(text);
      composerRef.current?.focus();
    }
    await refreshSessions().catch(() => []);
  }

  async function abandonRevisionCopy(
    draft: TDraft,
  ): Promise<{ acknowledged: boolean; draft: TDraft }> {
    const tracked = env.abandonCopyAttempt(
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
      await env.abandonSessionCopy(draft.sourceSessionId, draft.copyId);
      env.completeCopyAttempt(revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId), draft.copyId);
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
    // A no-op retry (text and staged context unchanged) would duplicate the
    // source turn verbatim; a send mixing user-staged context into the
    // restored set cannot carry it truthfully. Both stop here, toasting.
    const staged = stagedContext();
    const gate = revisionSendGate(draft, draft.originalText, text, staged, hasPendingAttachments());
    if (gate !== 'pass') {
      toastApi.info(
        copy.revisionReadyTitle,
        gate === 'unchanged' ? copy.revisionUnchanged : copy.revisionMixedContextUnsupported,
      );
      return false;
    }
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
      const nextAttempt = env.acquireCopyAttempt(
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
        !env.startCopyAttempt(
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
    const preparationAbort = new AbortController();
    revisionPreparationAbort?.abort();
    revisionPreparationAbort = preparationAbort;
    try {
      const newSession = await env.reviseBeforeTurn(sourceSessionId, {
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
      const { messages: preparedMessages, settled } = await env.readSettledMessages(
        newSession.id,
        { signal: preparationAbort.signal },
      );
      if (!settled) throw new Error('Revised Session transcript did not become ready');
      if (
        !selectionIsCurrent() || activeIdRef.current !== newSession.id ||
        revisionDraftRef.current !== prepared
      ) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text, selectionIsCurrent);
        return false;
      }
      // Re-key the restored quotes onto the branch child: the plates read the
      // active session's draft key, and the replacement send reads them live
      // (#5109 review). The refs are pure data staged from the draft snapshot
      // — a revision copy excludes the revised turn, so the copied transcript
      // cannot be their source. Re-keyed only after every rollback check has
      // passed, so a failed preparation leaves the plate on the source key.
      staged.restoreQuotes(newSession.id, startedDraft.originalQuotes);
      staged.clearQuotes(startedDraft.sourceSessionId);
      setMessages(preparedMessages);
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      await refreshSessions();
      return true;
    } catch (error) {
      if (preparationAbort.signal.aborted) return false;
      if (preparedSessionId) {
        await rollbackPreparedRevision(startedDraft, preparedSessionId, text, selectionIsCurrent);
      }
      if (!selectionIsCurrent()) return false;
      if (env.reportSessionWorkspaceUnavailable(error, sourceSessionId)) {
        return false;
      } else {
        toastApi.error(
          copy.operationFailedTitle,
          env.localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
          undefined,
          { sessionId: sourceSessionId },
        );
      }
      return false;
    } finally {
      if (revisionPreparationAbort === preparationAbort) revisionPreparationAbort = undefined;
    }
  }

  async function cancelRevisionDraft(): Promise<void> {
    let selectionIsCurrent = captureSelection();
    revisionPreparationAbort?.abort();
    const draft = revisionDraftRef.current;
    if (!draft) return;
    const cleanupSessionId = draft.copyPhase !== 'reserved'
      ? draft.draftSessionId !== draft.sourceSessionId
        ? draft.draftSessionId
        : draft.copyId
      : undefined;
    if (cleanupSessionId) await abandonRevisionCopy(draft);
    else env.completeCopyAttempt(revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId), draft.copyId);
    commitRevisionDraft(null);
    // Unstage everything the edit staged (#5109), under both draft keys: the
    // plate starts on the source key and the commit re-keys it onto the
    // branch child. The edit refuses while the user has own context staged.
    clearRevisionStagedContext(stagedContext(), [draft.sourceSessionId, draft.draftSessionId]);
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

/**
 * The module-level copy-attempt bookkeeping a surface exports beside the
 * factory: completion on send, and abandonment with the same ambiguous-
 * acknowledgement contract as the lifecycle above.
 */
export function createTurnRevisionCopyHelpers<
  Phase,
  TDraft extends TurnRevisionDraftBase<Phase>,
>(deps: {
  completeCopyAttempt(key: RevisionCopyKey, copyId: string): void;
  abandonCopyAttempt(key: RevisionCopyKey, copyId: string): boolean;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
}): {
  completeTurnRevisionCopyAttempt(draft: TDraft): void;
  abandonTurnRevisionCopyAttempt(draft: TDraft): Promise<boolean>;
} {
  function completeTurnRevisionCopyAttempt(draft: TDraft): void {
    deps.completeCopyAttempt(revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId), draft.copyId);
  }

  async function abandonTurnRevisionCopyAttempt(draft: TDraft): Promise<boolean> {
    const key = revisionCopyKey(draft.sourceSessionId, draft.sourceTurnId);
    deps.abandonCopyAttempt(key, draft.copyId);
    try {
      await deps.abandonSessionCopy(draft.sourceSessionId, draft.copyId);
      deps.completeCopyAttempt(key, draft.copyId);
      return true;
    } catch {
      return false;
    }
  }

  return { completeTurnRevisionCopyAttempt, abandonTurnRevisionCopyAttempt };
}
