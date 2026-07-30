import type { SessionSummary, StoredMessage, UiLocale } from '@maka/core';
import { userFacingText } from '@maka/core';
import type { ComposerHandle, ComposerSkillSelection } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';

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
  /** Active owner of the draft. Changes to the branch child after prepare. */
  draftSessionId: string;
  originalText: string;
  /** Composer text that was present before edit began; restored on cancel. */
  previousComposerText: string;
  /** Structured Skills that were present before edit began; restored on cancel. */
  previousComposerSkills: ComposerSkillSelection[];
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
    commitRevisionDraft({
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      draftSessionId: sessionId,
      originalText: prompt,
      previousComposerText: composerRef.current?.getText() ?? '',
      previousComposerSkills: composerRef.current?.getSkills() ?? [],
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
    let restored: TurnRevisionDraft | undefined;
    if (current?.draftSessionId === revisionSessionId) {
      restored = { ...draft, draftSessionId: draft.sourceSessionId };
      composerRef.current?.setDraft(draft.sourceSessionId, text);
      commitRevisionDraft(restored);
    }
    if (activeIdRef.current === revisionSessionId) {
      openSessionInChat(draft.sourceSessionId);
      setMessages([]);
      await refreshMessages(draft.sourceSessionId).catch(() => false);
      if (activeIdRef.current === draft.sourceSessionId && revisionDraftRef.current === restored) {
        composerRef.current?.setText(text);
        composerRef.current?.focus();
      }
    }
    await window.maka.sessions.remove(revisionSessionId).catch(() => undefined);
    await refreshSessions().catch(() => []);
  }

  async function prepareRevisionSend(text: string): Promise<boolean> {
    const draft = revisionDraftRef.current;
    if (!draft || activeIdRef.current !== draft.draftSessionId) return false;
    // A previous attempt already prepared the version; retry normal send there.
    if (draft.draftSessionId !== draft.sourceSessionId) return true;

    const sourceSessionId = draft.sourceSessionId;
    // Snapshot the submitted structured draft before the first async boundary.
    // The composer remains editable while the revision session is created, so
    // reading it after reviseBeforeTurn() could migrate a newer, unsent Skill
    // selection instead of the one that belongs to this send attempt.
    const submittedSkills =
      composerRef.current?.getSkills().map((skill) => ({ ...skill })) ?? [];
    let preparedSessionId: string | undefined;
    try {
      const newSession = await window.maka.sessions.reviseBeforeTurn(sourceSessionId, {
        sourceTurnId: draft.sourceTurnId,
      });
      preparedSessionId = newSession.id;
      if (activeIdRef.current !== sourceSessionId || revisionDraftRef.current !== draft) {
        await rollbackPreparedRevision(draft, newSession.id, text);
        return false;
      }

      const prepared = { ...draft, draftSessionId: newSession.id };
      composerRef.current?.setSkillDraft(newSession.id, submittedSkills);
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
        await rollbackPreparedRevision(draft, newSession.id, text);
        return false;
      }
      composerRef.current?.focus();
      toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      await refreshSessions();
      return true;
    } catch (error) {
      if (preparedSessionId) {
        await rollbackPreparedRevision(draft, preparedSessionId, text);
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
    const preparedSessionId =
      draft.draftSessionId !== draft.sourceSessionId ? draft.draftSessionId : undefined;
    commitRevisionDraft(null);
    composerRef.current?.setDraft(draft.sourceSessionId, draft.previousComposerText);
    composerRef.current?.setSkillDraft(
      draft.sourceSessionId,
      draft.previousComposerSkills,
    );
    if (preparedSessionId) composerRef.current?.clearDraft(preparedSessionId);
    if (activeIdRef.current !== draft.sourceSessionId) {
      openSessionInChat(draft.sourceSessionId);
      setMessages([]);
      await refreshMessages(draft.sourceSessionId).catch(() => false);
    }
    if (preparedSessionId) {
      await window.maka.sessions.remove(preparedSessionId).catch(() => undefined);
      await refreshSessions().catch(() => []);
    }
    if (activeIdRef.current === draft.sourceSessionId) {
      composerRef.current?.setText(draft.previousComposerText);
      composerRef.current?.focus();
    }
  }

  return { beginEditUserMessage, prepareRevisionSend, cancelRevisionDraft };
}
