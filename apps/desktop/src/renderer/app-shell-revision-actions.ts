import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { userFacingText } from '@maka/core/session';
import type { ComposerHandle } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';
import {
  acquireSessionCopyAttempt,
  abandonSessionCopyAttempt,
  completeSessionCopyAttempt,
  startSessionCopyAttempt,
  type SessionCopyAttemptPhase,
  type SessionCopyAttemptKey,
} from './session-copy-attempt.js';

type RefBox<T> = { current: T };
type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

type ToastApi = {
  info(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/** Active edit-and-resend draft owned by the desktop shell. */
export type TurnRevisionDraft = {
  sourceSessionId: string;
  sourceTurnId: string;
  copyId: string;
  copyPhase: SessionCopyAttemptPhase;
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  originalText: string;
  /** Composer text that was present before edit began; restored on cancel.
   *  Staged Skills ride along inside it as `/skill:<id>` chips. */
  previousComposerText: string;
};

export interface AppShellRevisionActions {
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
 * creating another version. Attachment-bearing source or retained context is
 * rejected until the revision copier can preserve those references losslessly.
 */
export function createAppShellRevisionActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  composerRef: RefBox<ComposerHandle | null>;
  messages: readonly StoredMessage[];
  hasPendingAttachments: () => boolean;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  setMessages: MessageListUpdater;
  commitRevisionDraft: (draft: TurnRevisionDraft | null) => void;
  revisionDraftRef: RefBox<TurnRevisionDraft | null>;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
}): AppShellRevisionActions {
  const {
    uiLocale,
    activeIdRef,
    composerRef,
    messages,
    hasPendingAttachments,
    openSessionInChat,
    refreshMessages,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    upsertSessionSummary,
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
    const userMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!userMessage) {
      toastApi.error(copy.operationFailedTitle, copy.operationFailedFallback);
      return;
    }

    const turnOrder: string[] = [];
    const seenTurns = new Set<string>();
    const turnHasAttachments = new Set<string>();
    for (const message of messages) {
      const messageTurnId = (message as { turnId?: string }).turnId;
      if (messageTurnId && !seenTurns.has(messageTurnId)) {
        seenTurns.add(messageTurnId);
        turnOrder.push(messageTurnId);
      }
      if (message.type === 'user' && message.attachments && message.attachments.length > 0) {
        turnHasAttachments.add(message.turnId);
      }
    }
    const sourceIndex = turnOrder.indexOf(turnId);
    const retainedAttachmentTurn = turnOrder
      .slice(0, Math.max(0, sourceIndex))
      .find((candidate) => turnHasAttachments.has(candidate));
    if (
      (userMessage.attachments && userMessage.attachments.length > 0) ||
      retainedAttachmentTurn
    ) {
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
      originalText: prompt,
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
  ): Promise<void> {
    composerRef.current?.clearDraft(revisionSessionId);
    const current = revisionDraftRef.current;
    if (activeIdRef.current === revisionSessionId) {
      openSessionInChat(draft.sourceSessionId);
      setMessages([]);
      await refreshMessages(draft.sourceSessionId).catch(() => false);
    }
    const abandonment = await abandonRevisionCopy(draft, revisionSessionId);
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
    if (activeIdRef.current === draft.sourceSessionId && revisionDraftRef.current === restored) {
      composerRef.current?.setText(text);
      composerRef.current?.focus();
    }
    await refreshSessions().catch(() => []);
  }

  function completeRevisionCopyAttempt(draft: TurnRevisionDraft): void {
    completeTurnRevisionCopyAttempt(draft);
  }

  async function abandonRevisionCopy(
    draft: TurnRevisionDraft,
    revisionSessionId: string,
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
      await window.maka.sessions.abandonSessionCopy(revisionSessionId);
      completeRevisionCopyAttempt(draft);
      return { acknowledged: true, draft: abandoningDraft };
    } catch {
      // An ambiguous cleanup acknowledgement stays in `abandoning`; this
      // target may only retry cleanup and can never be copied into again.
      return { acknowledged: false, draft: abandoningDraft };
    }
  }

  async function prepareRevisionSend(text: string): Promise<boolean> {
    let draft = revisionDraftRef.current;
    if (!draft || activeIdRef.current !== draft.draftSessionId) return false;
    // A previous attempt already prepared the version; retry normal send there.
    if (draft.draftSessionId !== draft.sourceSessionId) return true;

    if (draft.copyPhase === 'abandoning') {
      const abandonment = await abandonRevisionCopy(draft, draft.copyId);
      if (
        !abandonment.acknowledged ||
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
      const newSession = await window.maka.sessions.reviseBeforeTurn(sourceSessionId, {
        sourceTurnId: startedDraft.sourceTurnId,
        copyId: startedDraft.copyId,
      });
      preparedSessionId = newSession.id;
      if (activeIdRef.current !== sourceSessionId || revisionDraftRef.current !== startedDraft) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text);
        return false;
      }

      const prepared = { ...startedDraft, draftSessionId: newSession.id };
      composerRef.current?.setDraft(newSession.id, text);
      commitRevisionDraft(prepared);
      upsertSessionSummary(newSession);
      openSessionInChat(newSession.id);
      setMessages([]);
      const loaded = await refreshMessages(newSession.id);
      if (
        !loaded ||
        activeIdRef.current !== newSession.id ||
        revisionDraftRef.current !== prepared
      ) {
        await rollbackPreparedRevision(startedDraft, newSession.id, text);
        return false;
      }
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      await refreshSessions();
      return true;
    } catch (error) {
      if (preparedSessionId) {
        await rollbackPreparedRevision(startedDraft, preparedSessionId, text);
      }
      if (activeIdRef.current !== sourceSessionId) return false;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
      return false;
    }
  }

  async function cancelRevisionDraft(): Promise<void> {
    const draft = revisionDraftRef.current;
    if (!draft) return;
    const cleanupSessionId = draft.copyPhase !== 'reserved'
      ? draft.draftSessionId !== draft.sourceSessionId
        ? draft.draftSessionId
        : draft.copyId
      : undefined;
    if (cleanupSessionId) await abandonRevisionCopy(draft, cleanupSessionId);
    else completeRevisionCopyAttempt(draft);
    commitRevisionDraft(null);
    composerRef.current?.setDraft(draft.sourceSessionId, draft.previousComposerText);
    if (draft.draftSessionId !== draft.sourceSessionId) {
      composerRef.current?.clearDraft(draft.draftSessionId);
    }
    if (activeIdRef.current !== draft.sourceSessionId) {
      openSessionInChat(draft.sourceSessionId);
      setMessages([]);
      await refreshMessages(draft.sourceSessionId).catch(() => false);
    }
    if (cleanupSessionId) {
      await refreshSessions().catch(() => []);
    }
    if (activeIdRef.current === draft.sourceSessionId) {
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
  draft: TurnRevisionDraft,
): Promise<boolean> {
  const key: SessionCopyAttemptKey = {
    scope: `edit-and-resend:${draft.sourceTurnId}`,
    kind: 'revision',
    sourceSessionId: draft.sourceSessionId,
  };
  abandonSessionCopyAttempt(key, draft.copyId);
  const targetSessionId =
    draft.draftSessionId === draft.sourceSessionId ? draft.copyId : draft.draftSessionId;
  try {
    await window.maka.sessions.abandonSessionCopy(targetSessionId);
    completeSessionCopyAttempt(key, draft.copyId);
    return true;
  } catch {
    return false;
  }
}
