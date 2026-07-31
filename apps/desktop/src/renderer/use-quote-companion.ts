import { useCallback, useEffect, useRef, useState } from 'react';
import {
  activeInteractionFor,
  applyLiveTurnEvent,
  armLiveTurn,
  reconcileTerminalLiveTurn,
  useMountedRef,
  type InteractionQueues,
  type LiveTurnProjection,
} from '@maka/ui';
import type {
  SandboxBoundaryRequestEvent,
  SandboxBoundaryResponse,
  QuoteRef,
  SessionEvent,
  SessionSummary,
  StoredMessage,
  UiLocale,
  UserQuestionRequestEvent,
  UserQuestionResponse,
} from '@maka/core';
import {
  applyCompanionInteractionEvent,
  deriveCompanionComposerState,
  isCompanionTurnTerminal,
  performCompanionTurn,
  type CompanionErrorCode,
} from './quote-companion-core';
import { readSettledMessages } from './session-message-settlement';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import {
  snapshotCompanionQuotes,
  type CompanionQuoteSnapshot,
  type StagedCompanionQuote,
} from './quote-companion-panel-state';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility';

export interface UseQuoteCompanionInput {
  /** Stable owner for the currently mounted panel generation. */
  panelId: string;
  /** Excerpts staged for the next send; accumulates as the user adds more from
   *  the main transcript. Attached to the next turn, then cleared by the host. */
  pendingQuotes: readonly StagedCompanionQuote[];
  /** The main session the panel is attached to. The companion FORKS from it (via
   *  branchFromTurn) so it inherits the full conversation context + model / cwd —
   *  Codex `/side` style. */
  sourceSession: SessionSummary | undefined;
  locale: UiLocale;
  /** Called once a send has consumed the staged quotes, so the host clears them. */
  onQuotesConsumed: (snapshot: CompanionQuoteSnapshot) => void;
  /** Reports creation and authoritative cleanup so the host can keep every
   *  ephemeral fork hidden for its complete lifetime. */
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
}

export interface UseQuoteCompanionResult {
  companionSession: SessionSummary | undefined;
  /** The companion's OWN turns only — the forked parent history is context for
   *  the model but stays hidden from this side transcript (separate transcript,
   *  like Codex /side), so the panel isn't a duplicate of the main conversation. */
  messages: StoredMessage[];
  liveTurn: LiveTurnProjection | undefined;
  streaming: boolean;
  processing: boolean;
  /** A localized, retryable error (fork setup, run error, or a rejected send). */
  error: string | null;
  /** The model the companion inherited from the source (shown read-only). */
  activeModel: { llmConnectionSlug: string; model: string } | undefined;
  /** Pending sandbox-boundary / user-question prompt raised by the companion's run. */
  activeSandboxBoundary: SandboxBoundaryRequestEvent | undefined;
  activeQuestion: UserQuestionRequestEvent | undefined;
  /** Returns whether the send was accepted; false leaves the draft + staged
   *  quotes in place so the user can retry. */
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
  respondToSandboxBoundary: (response: SandboxBoundaryResponse) => Promise<void>;
  respondToUserQuestion: (response: UserQuestionResponse) => Promise<void>;
}

/** The last streamed assistant message id of a turn — the settlement anchor. */
function requiredAssistantMessageId(projection: LiveTurnProjection | undefined): string | undefined {
  return [...(projection?.steps ?? [])].reverse().find((step) => step.text)?.stepId;
}

/**
 * Companion for the quote side panel. On the first question it FORKS the main
 * session (`branchFromTurn` from the latest SETTLED turn) into a child that
 * carries the whole main conversation as context and inherits its model / cwd.
 * The fork is pinned read-only (`explore`): it explains and explores the selected
 * context — writes / shell / destructive operations are hard-blocked, while web /
 * custom tools follow the normal permission path (surfaced here as a prompt).
 * Follow-ups stream through the SAME live-turn reducer the main shell uses, and
 * hand off from the live projection only once the persisted message settles (the
 * shared `readSettledMessages` + `reconcileTerminalLiveTurn` rule) so a completed
 * exchange never flickers away. Asking never writes back to the main conversation;
 * inherited history is hidden from the side transcript. The subscription is
 * established the moment the fork commits — before the run starts — so no
 * prompt/complete is missed. Reset only by unmount (退出 / switch / collapse),
 * which removes the ephemeral fork.
 */
export function useQuoteCompanion(input: UseQuoteCompanionInput): UseQuoteCompanionResult {
  const {
    panelId,
    locale,
    sourceSession,
    pendingQuotes,
    onQuotesConsumed,
    onForkVisibilityChange,
  } = input;
  const copy = getDesktopConversationCopy(locale).quoteCompanion;
  const [companion, setCompanion] = useState<SessionSummary | undefined>(undefined);
  const companionIdRef = useRef<string | null>(null);
  // A created fork is hidden immediately, before its permission pin completes,
  // but is not considered usable until onForkCommitted promotes it.
  const pendingForkIdRef = useRef<string | null>(null);
  const onForkVisibilityChangeRef = useRef(onForkVisibilityChange);
  onForkVisibilityChangeRef.current = onForkVisibilityChange;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const ownTurnIdsRef = useRef<Set<string>>(new Set());
  const [allMessages, setAllMessages] = useState<StoredMessage[]>([]);
  const [liveTurn, setLiveTurn] = useState<LiveTurnProjection | undefined>(undefined);
  const liveTurnRef = useRef(liveTurn);
  liveTurnRef.current = liveTurn;
  const [interactions, setInteractions] = useState<InteractionQueues>({});
  const [turnInFlight, setTurnInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever the own-turn set changes so the render picks up the new
  // filter result (the set lives in a ref to stay stable for the event handler).
  const [, setOwnTurnTick] = useState(0);
  // The live event subscription's unsubscribe, established at fork-commit time.
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // StrictMode-safe mounted guard (re-arms on the dev mount → unmount → remount
  // double-invoke; a hand-rolled disposed flag would stay tripped after replay).
  const mountedRef = useMountedRef();

  // Subscribe to the fork's event stream + load its transcript. Called
  // synchronously the moment the fork is committed, BEFORE the run starts, so
  // no boundary request / complete can be missed (the stream has no replay).
  const subscribeToFork = useCallback((forkId: string) => {
    void readSettledMessages(forkId)
      .then(({ messages }) => {
        if (mountedRef.current) setAllMessages(messages);
      })
      .catch(() => {});
    unsubscribeRef.current = window.maka.sessions.subscribeEvents(forkId, (event: SessionEvent) => {
      // Interaction queue (so a boundary expansion surfaces) + live stream.
      setInteractions((current) => applyCompanionInteractionEvent(current, forkId, event));
      setLiveTurn((prev) => applyLiveTurnEvent(prev, event, localeRef.current));
      if (event.type === 'error') setError(copyRef.current.errors.runError);
      if (isCompanionTurnTerminal(event)) {
        // Settlement: wait for the assistant message to persist before handing
        // off from the live projection, then reconcile (shared with the main chat)
        // so the finished exchange never flickers away.
        void readSettledMessages(forkId, {
          ...(requiredAssistantMessageId(liveTurnRef.current)
            ? { requiredAssistantMessageId: requiredAssistantMessageId(liveTurnRef.current) }
            : {}),
        })
          .then(({ messages: next }) => {
            if (!mountedRef.current) return;
            setAllMessages(next);
            setLiveTurn((prev) => (prev ? reconcileTerminalLiveTurn(prev, next) : prev));
            setTurnInFlight(false);
          })
          .catch(() => {
            if (mountedRef.current) setTurnInFlight(false);
          });
      }
    });
  }, [mountedRef]);

  // The fork is ephemeral (用完即弃): when the panel is dismissed — 退出,
  // switching source session, or collapsing the workbar — unsubscribe and remove
  // the fork so it never lingers in the session list. Runs only on unmount.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      const id = companionIdRef.current ?? pendingForkIdRef.current;
      if (id) {
        // The main-process authority records this intent before attempting the
        // full removal, and retries it on a later session list / app restart.
        void window.maka.sessions
          .cleanupQuoteCompanion(id)
          .then(() =>
            onForkVisibilityChangeRef.current?.({
              type: 'cleanup-succeeded',
              sessionId: id,
            }),
          )
          .catch(() => {});
      }
    };
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || turnInFlight || !sourceSession) return false;
      setError(null);
      const turnId = crypto.randomUUID();
      const quoteSnapshot = snapshotCompanionQuotes(panelId, pendingQuotes);
      const label = (quoteSnapshot.quotes[0]?.text ?? trimmed).slice(0, 24);
      const result = await performCompanionTurn({
        api: window.maka.sessions,
        sourceSession,
        name: `${copyRef.current.namePrefix}${label}`,
        isDisposed: () => !mountedRef.current,
        existingForkId: companionIdRef.current,
        turnId,
        text: trimmed,
        quotes: quoteSnapshot.quotes.length > 0 ? [...quoteSnapshot.quotes] : undefined,
        onForkCreated: (session) => {
          pendingForkIdRef.current = session.id;
          onForkVisibilityChangeRef.current?.({
            type: 'fork-created',
            sessionId: session.id,
          });
        },
        onForkCleanupSucceeded: (sessionId) =>
          onForkVisibilityChangeRef.current?.({
            type: 'cleanup-succeeded',
            sessionId,
          }),
        onForkCommitted: (session) => {
          pendingForkIdRef.current = null;
          companionIdRef.current = session.id;
          setCompanion(session);
          // Establish the event subscription BEFORE the send starts (fixes the
          // pre-subscription race). The host already hid it at creation time.
          subscribeToFork(session.id);
        },
        // Arm the optimistic live turn right before the send.
        onBeforeSend: () => {
          setTurnInFlight(true);
          setLiveTurn(armLiveTurn(turnId));
          ownTurnIdsRef.current.add(turnId);
          setOwnTurnTick((tick) => tick + 1);
        },
        onQuotesConsumed: () => onQuotesConsumed(quoteSnapshot),
      });
      if (result.status === 'sent') {
        // Surface the just-sent user message immediately, and reflect any
        // automatic connection/model rebound in the read-only model label.
        void readSettledMessages(result.forkId)
          .then(({ messages: next }) => {
            if (mountedRef.current) setAllMessages(next);
          })
          .catch(() => {});
        void window.maka.sessions
          .list()
          .then((sessions) => {
            const updated = sessions.find((session) => session.id === result.forkId);
            if (updated && mountedRef.current) setCompanion(updated);
          })
          .catch(() => {});
        return true;
      }
      if (result.status === 'error') {
        const errors = copyRef.current.errors;
        const byCode: Record<CompanionErrorCode, string> = {
          fork_setup_failed: errors.forkSetupFailed,
          permission_pin_failed: errors.permissionPinFailed,
          send_failed: errors.sendFailed,
          send_rejected: errors.sendRejected,
        };
        if (result.code === 'permission_pin_failed') {
          pendingForkIdRef.current = null;
        }
        setError(byCode[result.code]);
        setTurnInFlight(false);
        setLiveTurn(undefined);
      }
      // 'disposed' → the panel unmounted mid-create; nothing to update.
      return false;
    },
    [turnInFlight, sourceSession, panelId, pendingQuotes, onQuotesConsumed, subscribeToFork, mountedRef],
  );

  const stop = useCallback(async (): Promise<void> => {
    const id = companionIdRef.current;
    if (!id) return;
    try {
      await window.maka.sessions.stop(id);
    } catch {
      // best-effort; the terminal event still reconciles state
    }
  }, []);

  const respondToSandboxBoundary = useCallback(
    async (response: SandboxBoundaryResponse): Promise<void> => {
    const id = companionIdRef.current;
    if (!id) return;
    try {
      await window.maka.sessions.respondToSandboxBoundary(id, response);
    } catch {
      setError(copyRef.current.errors.respondFailed);
    }
    },
    [],
  );

  const respondToUserQuestion = useCallback(
    async (response: UserQuestionResponse): Promise<void> => {
      const id = companionIdRef.current;
      if (!id) return;
      try {
        await window.maka.sessions.respondToUserQuestion(id, response);
      } catch {
        setError(copyRef.current.errors.respondFailed);
      }
    },
    [],
  );

  // Only the companion's own turns render; the forked parent history stays as
  // hidden model context.
  const messages = allMessages.filter(
    (message) => message.turnId !== undefined && ownTurnIdsRef.current.has(message.turnId),
  );
  const { streaming, processing } = deriveCompanionComposerState(turnInFlight, liveTurn);
  // Inherited model (read-only): the fork's once created, else the source's.
  const activeModel = companion
    ? { llmConnectionSlug: companion.llmConnectionSlug, model: companion.model }
    : sourceSession
      ? { llmConnectionSlug: sourceSession.llmConnectionSlug, model: sourceSession.model }
      : undefined;
  const activeInteraction = companionIdRef.current
    ? activeInteractionFor(interactions, companionIdRef.current)
    : undefined;
  const activeSandboxBoundary =
    activeInteraction?.type === 'sandbox_boundary_request' ? activeInteraction : undefined;
  const activeQuestion =
    activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;

  return {
    companionSession: companion,
    messages,
    liveTurn,
    streaming,
    processing,
    error,
    activeModel,
    activeSandboxBoundary,
    activeQuestion,
    send,
    stop,
    respondToSandboxBoundary,
    respondToUserQuestion,
  };
}
