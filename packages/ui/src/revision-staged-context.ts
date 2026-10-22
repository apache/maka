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
 * quotes and attachments across that commit; restaged attachments carry
 * source-owned refs until prepare swaps them for the copy's target-owned
 * ones (#5109).
 */
export type RevisionStagedContext = {
  quotes: readonly QuoteRef[];
  attachments: readonly PendingAttachment[];
  restoreQuotes(ownerKey: string, quotes: readonly QuoteRef[]): void;
  /** Removes and returns what an owner key holds, so the cancel path can
   *  re-stage the entries the edit did not stage itself (#5274 review). */
  clearQuotes(ownerKey: string): readonly QuoteRef[];
  restoreAttachments(ownerKey: string, attachments: readonly PendingAttachment[]): void;
  /** Removes and returns what an owner key holds, mirroring clearQuotes. */
  clearAttachments(ownerKey: string): readonly PendingAttachment[];
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
  previousComposerText: string;
  originalQuotes: readonly QuoteRef[];
  originalAttachments: readonly AttachmentRef[];
};


/** The retained pending form of a source message attachment: it carries the
 *  source-owned ref verbatim until prepare swaps in the copy's target-owned
 *  one (#5109). */
export function retainedAttachmentToPending(attachment: AttachmentRef): PendingAttachment {
  return {
    stagingKey: crypto.randomUUID(),
    displayName: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.bytes,
    source: { type: 'retained', attachment: structuredClone(attachment) },
  };
}

function quoteKey(quote: QuoteRef): string {
  // Every field participates: two snapshots can share text, label, and turn
  // while differing in which Session they were captured from, when, or how
  // completely — and treating a provenance-only replacement as a no-op would
  // refuse a legitimate edit (apache/maka#5274 review). The model-facing
  // comment counts too: editing only the annotation is a real change the
  // composer exposes through onEditQuoteComment.
  return JSON.stringify([
    quote.text,
    quote.label ?? null,
    quote.sourceTurnId ?? null,
    quote.sourceSessionId ?? null,
    quote.sourceSessionName ?? null,
    quote.sourceCapturedAt ?? null,
    quote.sourceTruncated ?? null,
    quote.comment ?? null,
  ]);
}

/**
 * Snapshot the source message's context at edit start and restage its quotes
 * and attachments under the edit's owner key, so the gate can later tell the
 * edit's own staging from the user's.
 */
export function stageRevisionSourceContext(
  staged: Pick<RevisionStagedContext, 'restoreQuotes' | 'restoreAttachments'>,
  ownerKey: string,
  message: { quotes?: readonly QuoteRef[]; attachments?: readonly AttachmentRef[] },
): RevisionStagedSource {
  const sourceQuotes = [...(message.quotes ?? [])];
  if (sourceQuotes.length > 0) staged.restoreQuotes(ownerKey, sourceQuotes);
  const sourceAttachments = [...(message.attachments ?? [])];
  if (sourceAttachments.length > 0) {
    staged.restoreAttachments(
      ownerKey,
      sourceAttachments.map(retainedAttachmentToPending),
    );
  }
  return { originalQuotes: sourceQuotes, originalAttachments: sourceAttachments };
}

/**
 * The pre-send gate for a revision replacement: 'conflict' blocks a send
 * mixing user-staged context into the restored set (pending directories have
 * no plate snapshot — flagged through pendingContext with an empty attachment
 * plate). An unchanged-text retry is allowed through (#5815).
 */
export function revisionSendGate(
  source: RevisionStagedSource,
  staged: Pick<RevisionStagedContext, 'quotes' | 'attachments'>,
  pendingContext: boolean,
): 'pass' | 'conflict' {
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
 * Unstage the edit's staged context from under every draft key — the cancel
 * path. Entries the edit staged itself (the beginEdit snapshot) are dropped
 * wherever the commit left them (source key before it, branch child after);
 * anything else on those plates is the user's own staging, added during the
 * edit, so it survives — re-keyed onto the first owner key, the source
 * Session the cancel returns to (#5274 review).
 */
export function clearRevisionStagedContext(
  staged: Pick<
    RevisionStagedContext,
    'clearQuotes' | 'restoreQuotes' | 'clearAttachments' | 'restoreAttachments'
  >,
  ownerKeys: readonly string[],
  editOwnedQuotes: readonly QuoteRef[],
  editOwnedAttachments: readonly AttachmentRef[] = [],
): void {
  const keys = [...new Set(ownerKeys)];
  const owned = new Map<string, number>();
  for (const quote of editOwnedQuotes) {
    const key = quoteKey(quote);
    owned.set(key, (owned.get(key) ?? 0) + 1);
  }
  const removed: QuoteRef[] = [];
  for (const ownerKey of keys) removed.push(...staged.clearQuotes(ownerKey));
  const kept: QuoteRef[] = [];
  for (const quote of removed) {
    // Past the edit's own per-quote count, every entry is the user's own —
    // including once the counter has run negative past zero, because a user
    // addition can duplicate a quote the edit staged itself (#5274 review).
    const key = quoteKey(quote);
    const ownedCount = owned.get(key) ?? 0;
    owned.set(key, ownedCount - 1);
    if (ownedCount <= 0) kept.push(quote);
  }
  if (keys.length > 0 && kept.length > 0) staged.restoreQuotes(keys[0], kept);
  // Attachments: the edit's own entries (matched by their source ref) are
  // dropped; anything else on the plates was staged by the user during the
  // edit and survives on the first owner key. ponytail: count-based survival
  // can mirror the quote logic if duplicated user additions matter.
  const editOwnedRefs = new Set(editOwnedAttachments.map((ref) => JSON.stringify(ref)));
  const dropped: PendingAttachment[] = [];
  for (const ownerKey of keys) dropped.push(...staged.clearAttachments(ownerKey));
  const keptAttachments = dropped.filter(
    (item) =>
      item.source.type !== 'retained' ||
      !editOwnedRefs.has(JSON.stringify(item.source.attachment.ref)),
  );
  if (keys.length > 0 && keptAttachments.length > 0) {
    staged.restoreAttachments(keys[0], keptAttachments);
  }
}

/** Localized strings an edit-and-resend surface needs from its own catalog. */
export interface RevisionEditCopy {
  revisionUnavailableTitle: string;
  revisionAlreadyActive: string;
  revisionAttachmentsUnsupported: string;
  revisionDraftAttachmentConflict: string;
  revisionDraftQuoteConflict: string;
  revisionMixedContextUnsupported: string;
  revisionTransformedTextUnsupported: string;
  revisionStartedTitle: string;
  revisionStartedDescription: string;
  revisionReadyTitle: string;
  revisionReadyDescription: string;
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
  activeIdRef: { readonly current: string | undefined };
  captureSelection(): () => boolean;
  composerRef: { readonly current: ComposerHandle | null };
  readMessages(): readonly StoredMessage[];
  hasPendingAttachments(): boolean;
  stagedContext(): RevisionStagedContext;
  openSessionInChat(sessionId: string, turnId?: string): void;
  refreshSessions(): Promise<unknown[]>;
  commitRevisionDraft(draft: TurnRevisionDraftBase<Phase> | null): void;
  revisionDraftRef: { readonly current: TDraft | null };
  toastApi: RevisionToastApi;
  copy: RevisionEditCopy;
  reviseBeforeTurn(
    sourceSessionId: string,
    input: { sourceTurnId: string; copyId: string },
  ): Promise<{ id: string; stagedAttachments?: readonly AttachmentRef[] }>;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
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
    readMessages,
    hasPendingAttachments,
    stagedContext,
    openSessionInChat,
    refreshSessions,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    copy,
  } = env;

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
      toastApi.error(copy.operationFailedTitle, copy.operationFailedFallback, undefined, {
        sessionId,
      });
      return;
    }
    // The selected message's quotes and attachments restage into the surface's
    // plates (#5109): the plates make the carried context visible and
    // explicitly removable, and the commit re-keys them onto the branch child
    // (prepareRevisionSend). Attachments restage as retained pending items
    // carrying their source-owned refs — prepare swaps those for the copy's
    // target-owned refs, because the Host stages the artifacts into the new
    // Session at copy time. The edit refuses while the user has own context
    // staged, so the plate ends up holding exactly the source context.
    const staged = stagedContext();
    if (staged.quotes.length > 0) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionDraftQuoteConflict);
      return;
    }
    if (staged.attachments.length > 0) {
      toastApi.info(copy.revisionUnavailableTitle, copy.revisionDraftAttachmentConflict);
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
    // A send mixing user-staged context into the restored set cannot carry it
    // truthfully; it stops here, toasting. An unchanged-text retry goes
    // through (#5815).
    const staged = stagedContext();
    if (revisionSendGate(draft, staged, hasPendingAttachments()) !== 'pass') {
      toastApi.info(copy.revisionReadyTitle, copy.revisionMixedContextUnsupported);
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
      await refreshSessions();
      if (!selectionIsCurrent() || revisionDraftRef.current !== prepared) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text, selectionIsCurrent);
        return false;
      }
      // Re-key the plate's *current* quotes onto the branch child: the user
      // may have removed or re-annotated entries during the edit, and the
      // replacement must carry the plate as it stands, not the snapshot the
      // edit started from (#5274 review). Re-keyed only after every rollback
      // check has passed, so a failed preparation leaves the plate on the
      // source key.
      staged.restoreQuotes(newSession.id, staged.quotes);
      staged.clearQuotes(startedDraft.sourceSessionId);
      // Restaged attachments re-key onto the branch child with their refs
      // swapped for the copy's target-owned ones (#5109): the copy response
      // lists the edited turn's attachments in source order, matched back to
      // the plate items by their source ref. An attachment whose rewrite is
      // missing keeps its source ref — the Host's session-owned guard will
      // fail that submit loudly rather than send a dangling reference.
      const rewritten = newSession.stagedAttachments ?? [];
      const refKey = (ref: AttachmentRef['ref']): string => JSON.stringify(ref);
      staged.restoreAttachments(
        newSession.id,
        staged.attachments.map((item) => {
          const source = item.source;
          if (source.type !== 'retained') return item;
          const index = startedDraft.originalAttachments.findIndex(
            (candidate) => refKey(candidate.ref) === refKey(source.attachment.ref),
          );
          const target = index >= 0 ? rewritten[index] : undefined;
          return target
            ? { ...item, source: { type: 'retained' as const, attachment: target } }
            : item;
        }),
      );
      staged.clearAttachments(startedDraft.sourceSessionId);
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      return true;
    } catch (error) {
      // Rollback itself navigates back to the source Session, so the failure
      // must be surfaced before it runs — checking after it is always stale.
      if (selectionIsCurrent()) {
        if (env.reportSessionWorkspaceUnavailable(error, sourceSessionId)) {
          return false;
        }
        toastApi.error(
          copy.operationFailedTitle,
          env.localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
          undefined,
          { sessionId: sourceSessionId },
        );
      }
      if (preparedSessionId) {
        await rollbackPreparedRevision(startedDraft, preparedSessionId, text, selectionIsCurrent);
      }
      return false;
    }
  }

  async function cancelRevisionDraft(): Promise<void> {
    let selectionIsCurrent = captureSelection();
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
    // Unstage the edit's staged context under both draft keys (source before
    // the commit, branch child after); quotes the user added during the edit
    // are not the edit's, so they survive on the source key (#5274 review).
    clearRevisionStagedContext(
      stagedContext(),
      [draft.sourceSessionId, draft.draftSessionId],
      draft.originalQuotes,
      draft.originalAttachments,
    );
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
