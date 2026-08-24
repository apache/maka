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
  QuoteRef,
  SessionEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { useWorkbarServices } from '../../services-context.js';
import type { WorkbarIngestInput } from '../../ports.js';
import {
  abandonPendingCompanionCopy,
  applyCompanionInteractionEvent,
  createCompanionDismissalGuard,
  dismissCompanionCopy,
  companionRunEventEffect,
  deriveCompanionComposerState,
  ensureCompanionFork,
  performCompanionTurn,
  type CompanionErrorCode,
  type EnsureCompanionForkResult,
} from './quote-companion-core.js';
import { mergeSettledMessages } from '../../../../settled-message-merge.js';
import { getDesktopConversationCopy } from '../../../../locales/conversation-copy.js';
import {
  snapshotCompanionQuotes,
  type CompanionQuoteSnapshot,
  type StagedCompanionQuote,
} from './quote-companion-panel-state.js';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility.js';

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
  /** True after this temporary conversation has accepted at least one turn. */
  hasContent: boolean;
  /** The companion's OWN turns only — the forked parent history is context for
   *  the model but stays hidden from this side transcript (separate transcript,
   *  like Codex /side), so the panel isn't a duplicate of the main conversation. */
  messages: StoredMessage[];
  liveTurn: LiveTurnProjection | undefined;
  streaming: boolean;
  processing: boolean;
  preparing: boolean;
  permissionMode: PermissionMode | undefined;
  permissionModePending: boolean;
  regeneratePendingTurnId: string | null;
  /** A localized, retryable error (fork setup, run error, or a rejected send). */
  error: string | null;
  /** The model the companion inherited from the source (shown read-only). */
  activeModel: { llmConnectionSlug: string; model: string } | undefined;
  /** Pending sandbox-boundary / user-question prompt raised by the companion's run. */
  activeSandboxBoundary: SandboxBoundaryRequestEvent | undefined;
  activeQuestion: UserQuestionRequestEvent | undefined;
  /** Returns whether the send was accepted; false leaves the draft + staged
   *  quotes in place so the user can retry. */
  send: (text: string, attachmentItems?: WorkbarIngestInput[]) => Promise<boolean>;
  /** Insert text into the active companion turn at the next model step. */
  steer: (text: string) => Promise<boolean>;
  setPermissionMode: (mode: PermissionMode) => Promise<boolean>;
  regenerate: (turnId: string) => Promise<boolean>;
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
 * The fork inherits the source permission profile and exposes the normal
 * permission control for later changes.
 * Follow-ups stream through the SAME live-turn reducer the main shell uses, and
 * hand off from the live projection only once the persisted message settles (the
 * shared `readSettledMessages` + `reconcileTerminalLiveTurn` rule) so a completed
 * exchange never flickers away. Asking never writes back to the main conversation;
 * inherited history is hidden from the side transcript. The subscription is
 * established the moment the fork commits — before the run starts — so no
 * prompt/complete is missed. Reset only by unmount (tab close or switching away
 * from the owning source session), which removes the ephemeral fork. Workbar
 * collapse and New Tab navigation keep the panel mounted.
 */
export function useQuoteCompanion(input: UseQuoteCompanionInput): UseQuoteCompanionResult {
  const { sideChat } = useWorkbarServices();
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
  const companionRef = useRef<SessionSummary | undefined>(undefined);
  const companionIdRef = useRef<string | null>(null);
  // A created fork is hidden immediately, but is not considered usable until
  // onForkCommitted promotes it.
  const pendingForkIdRef = useRef<string | null>(null);
  const sourceSessionRef = useRef(sourceSession);
  sourceSessionRef.current = sourceSession;
  const sourceSessionId = sourceSession?.id;
  const sourceSessionIdRef = useRef(sourceSession?.id);
  sourceSessionIdRef.current = sourceSessionId;
  const forkSetupPromiseRef = useRef<Promise<EnsureCompanionForkResult> | null>(null);
  const stopRequestedRef = useRef(false);
  const activeTurnIdRef = useRef<string | null>(null);
  const turnInFlightRef = useRef(false);
  const settlingTurnIdsRef = useRef<Set<string>>(new Set());
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
  const [preparing, setPreparing] = useState(Boolean(sourceSession));
  const [permissionModePending, setPermissionModePending] = useState(false);
  const [regeneratePendingTurnId, setRegeneratePendingTurnId] = useState<string | null>(
    null,
  );
  const [hasContent, setHasContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkRetryPending, setForkRetryPending] = useState(false);
  // Bumped whenever the own-turn set changes so the render picks up the new
  // filter result (the set lives in a ref to stay stable for the event handler).
  const [, setOwnTurnTick] = useState(0);
  // The live event subscription's unsubscribe, established at fork-commit time.
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // StrictMode-safe mounted guard (re-arms on the dev mount → unmount → remount
  // double-invoke; a hand-rolled disposed flag would stay tripped after replay).
  const mountedRef = useMountedRef();
  const dismissalGuardRef = useRef(createCompanionDismissalGuard());

  // Subscribe to the fork's event stream + load its transcript. Called
  // synchronously the moment the fork is committed, BEFORE the run starts, so
  // no boundary request / complete can be missed (the stream has no replay).
  const subscribeToFork = useCallback((forkId: string) => {
    void sideChat.readSettledMessages(forkId)
      .then(({ messages }) => {
        if (mountedRef.current) {
          setAllMessages((current) => mergeSettledMessages(current, messages));
        }
      })
      .catch(() => {
        if (mountedRef.current) setError(copyRef.current.errors.settlementFailed);
      });
    unsubscribeRef.current = sideChat.subscribeEvents(forkId, (event: SessionEvent) => {
      if (!mountedRef.current) return;
      const effect = companionRunEventEffect(
        event,
        activeTurnIdRef.current,
        stopRequestedRef.current,
        localeRef.current,
      );
      if (effect.kind === 'ignore') return;

      // Interaction queue (so a boundary expansion surfaces) + live stream.
      setInteractions((current) => applyCompanionInteractionEvent(current, forkId, event));
      setLiveTurn((prev) => applyLiveTurnEvent(prev, event, localeRef.current));
      if (effect.error !== undefined) setError(effect.error);
      if (effect.terminal && event.turnId && !settlingTurnIdsRef.current.has(event.turnId)) {
        const settledTurnId = event.turnId;
        settlingTurnIdsRef.current.add(settledTurnId);
        // Settlement: wait for the assistant message to persist before handing
        // off from the live projection, then reconcile (shared with the main chat)
        // so the finished exchange never flickers away.
        void sideChat.readSettledMessages(forkId, {
          ...(requiredAssistantMessageId(liveTurnRef.current)
                ? {
                    requiredAssistantMessageId: requiredAssistantMessageId(liveTurnRef.current),
                  }
            : {}),
          })
          .then(({ messages: next }) => {
            if (!mountedRef.current || activeTurnIdRef.current !== settledTurnId) return;
            setAllMessages((current) => mergeSettledMessages(current, next));
            setLiveTurn((prev) => (prev ? reconcileTerminalLiveTurn(prev, next) : prev));
            activeTurnIdRef.current = null;
            turnInFlightRef.current = false;
            stopRequestedRef.current = false;
            setTurnInFlight(false);
          })
          .catch(() => {
            if (!mountedRef.current || activeTurnIdRef.current !== settledTurnId) return;
            activeTurnIdRef.current = null;
            turnInFlightRef.current = false;
            stopRequestedRef.current = false;
            setTurnInFlight(false);
            setError((current) => current ?? copyRef.current.errors.settlementFailed);
          })
          .finally(() => {
            settlingTurnIdsRef.current.delete(settledTurnId);
          });
      }
    });
  }, [mountedRef, sideChat]);

  const commitFork = useCallback(
    (session: SessionSummary) => {
      pendingForkIdRef.current = null;
      companionIdRef.current = session.id;
      companionRef.current = session;
      setCompanion(session);
      subscribeToFork(session.id);
    },
    [subscribeToFork],
  );

  const ensureFork = useCallback(
    (
      name: string,
      options: { readonly showPreparing?: boolean } = {},
    ): Promise<EnsureCompanionForkResult> => {
      const existing = companionRef.current;
      if (existing) return Promise.resolve({ status: 'ready', session: existing });
      if (forkSetupPromiseRef.current) return forkSetupPromiseRef.current;
      const currentSourceSession = sourceSessionRef.current;
      if (!currentSourceSession) {
        return Promise.resolve({ status: 'error', code: 'fork_setup_failed' });
      }

      const showPreparing = options.showPreparing ?? true;
      if (showPreparing) setPreparing(true);
      const promise = ensureCompanionFork({
        api: sideChat,
        sourceSession: currentSourceSession,
        panelId,
        name,
        isDisposed: () => !mountedRef.current,
        onForkCreated: (session) => {
          pendingForkIdRef.current = session.id;
          onForkVisibilityChangeRef.current?.({
            type: 'fork-created',
            sessionId: session.id,
          });
        },
        onForkCleanupSucceeded: (sessionId) => {
          if (pendingForkIdRef.current === sessionId) {
            pendingForkIdRef.current = null;
          }
          onForkVisibilityChangeRef.current?.({
            type: 'cleanup-succeeded',
            sessionId,
          });
        },
      })
        .then((result) => {
          if (result.status === 'ready' && mountedRef.current) {
            setForkRetryPending(false);
            setError(null);
            commitFork(result.session);
          } else if (result.status === 'error' && mountedRef.current) {
            setForkRetryPending(result.code === 'fork_source_busy');
            const errors = copyRef.current.errors;
            setError(
              result.code === 'fork_source_busy'
                ? errors.forkSourceBusy
                : result.code === 'fork_unsupported'
                  ? errors.forkUnsupported
                  : errors.forkSetupFailed,
            );
          }
          return result;
        })
        .finally(() => {
          forkSetupPromiseRef.current = null;
          if (showPreparing && mountedRef.current) setPreparing(false);
        });
      forkSetupPromiseRef.current = promise;
      return promise;
    },
    [commitFork, mountedRef, panelId, sideChat],
  );

  useEffect(() => {
    if (sourceSessionId) void ensureFork(copyRef.current.defaultName);
  }, [ensureFork, sourceSessionId]);

  useEffect(() => {
    if (!sourceSessionId || !forkRetryPending) return;
    let retrying = false;
    const retry = () => {
      if (retrying || !mountedRef.current || companionRef.current) return;
      retrying = true;
      const currentSetup = forkSetupPromiseRef.current;
      void (async () => {
        if (currentSetup) await currentSetup;
        if (!mountedRef.current || companionRef.current) return;
        await ensureFork(copyRef.current.defaultName, { showPreparing: false });
      })().finally(() => {
        retrying = false;
      });
    };
    const unsubscribe = sideChat.subscribeSessionChanges((event) => {
      if (
        event.sessionId === sourceSessionId &&
        (event.reason === 'turn-status-change' ||
          event.reason === 'status-change' ||
          event.reason === 'message-appended')
      ) {
        retry();
      }
    });
    const retryTimer = globalThis.setInterval(retry, 2_000);
    return () => {
      globalThis.clearInterval(retryTimer);
      unsubscribe();
    };
  }, [ensureFork, forkRetryPending, mountedRef, sideChat, sourceSessionId]);

  // The fork is ephemeral (用完即弃): when the panel is dismissed — 退出,
  // switching source session — unsubscribe and remove the fork so it never
  // lingers in the session list. Collapsing keeps the panel mounted and alive.
  useEffect(() => {
    const shouldDismiss = dismissalGuardRef.current.beginMount();
    return () => {
      queueMicrotask(() => {
        // React StrictMode immediately replays mount effects in development.
        // A later setup generation means this was not a real panel dismissal.
        if (!shouldDismiss()) return;
        unsubscribeRef.current?.();
        const sourceSessionId = sourceSessionIdRef.current;
        const id = companionIdRef.current ?? pendingForkIdRef.current;
        if (id && sourceSessionId) {
          void dismissCompanionCopy(sideChat, sourceSessionId, panelId, id).then(
            (cleaned) => {
              if (cleaned) {
                onForkVisibilityChangeRef.current?.({
                  type: 'cleanup-succeeded',
                  sessionId: id,
                });
              }
            },
          );
        } else if (sourceSessionId) {
          void abandonPendingCompanionCopy(sideChat, sourceSessionId, panelId);
        }
      });
    };
  }, [panelId, sideChat]);

  const send = useCallback(
    async (
      text: string,
      attachmentItems?: WorkbarIngestInput[],
    ): Promise<boolean> => {
      const trimmed = text.trim();
      if (!mountedRef.current || !trimmed || turnInFlightRef.current || !sourceSession) {
        return false;
      }
      // Close the same-frame double-submit window before the first await. The
      // visible in-flight state still begins only when the run is armed.
      turnInFlightRef.current = true;
      setError(null);
      const turnId = crypto.randomUUID();
      const quoteSnapshot = snapshotCompanionQuotes(panelId, pendingQuotes);
      const label = (quoteSnapshot.quotes[0]?.text ?? trimmed).slice(0, 24);
      const fork = await ensureFork(`${copyRef.current.namePrefix}${label}`);
      if (fork.status !== 'ready') {
        turnInFlightRef.current = false;
        return false;
      }
      const result = await performCompanionTurn({
        api: sideChat,
        sourceSession,
        panelId,
        name: `${copyRef.current.namePrefix}${label}`,
        isDisposed: () => !mountedRef.current,
        existingForkId: fork.session.id,
        turnId,
        text: trimmed,
        quotes: quoteSnapshot.quotes.length > 0 ? [...quoteSnapshot.quotes] : undefined,
        ...(attachmentItems?.length ? { attachmentItems } : {}),
        onForkCreated: () => {},
        onForkCleanupSucceeded: (sessionId) =>
          onForkVisibilityChangeRef.current?.({
            type: 'cleanup-succeeded',
            sessionId,
          }),
        onForkCommitted: () => {},
        // Arm the optimistic live turn right before the send.
        onBeforeSend: () => {
          stopRequestedRef.current = false;
          activeTurnIdRef.current = turnId;
          turnInFlightRef.current = true;
          setTurnInFlight(true);
          setLiveTurn(armLiveTurn(turnId));
          ownTurnIdsRef.current.add(turnId);
          setOwnTurnTick((tick) => tick + 1);
        },
        onQuotesConsumed: () => onQuotesConsumed(quoteSnapshot),
      });
      if (result.status === 'sent') {
        setHasContent(true);
        // Surface the just-sent user message immediately, and reflect any
        // automatic connection/model rebound in the read-only model label.
        void sideChat.readSettledMessages(result.forkId)
          .then(({ messages: next }) => {
            if (mountedRef.current) {
              setAllMessages((current) => mergeSettledMessages(current, next));
            }
          })
          .catch(() => {});
        void sideChat
          .listSessions()
          .then((sessions) => {
            const updated = sessions.find((session) => session.id === result.forkId);
            if (updated && mountedRef.current) {
              companionRef.current = updated;
              setCompanion(updated);
            }
          })
          .catch(() => {});
        return true;
      }
      if (result.status === 'error') {
        const errors = copyRef.current.errors;
        const byCode: Record<CompanionErrorCode, string> = {
          fork_setup_failed: errors.forkSetupFailed,
          fork_source_busy: errors.forkSourceBusy,
          fork_unsupported: errors.forkUnsupported,
          send_failed: errors.sendFailed,
          send_rejected: errors.sendRejected,
        };
        setError(byCode[result.code]);
        activeTurnIdRef.current = null;
        turnInFlightRef.current = false;
        setTurnInFlight(false);
        setLiveTurn(undefined);
      }
      // 'disposed' → the panel unmounted mid-create; nothing to update.
      turnInFlightRef.current = false;
      return false;
    },
    [
      sourceSession,
      panelId,
      pendingQuotes,
      onQuotesConsumed,
      ensureFork,
      mountedRef,
      sideChat,
    ],
  );

  const stop = useCallback(async (): Promise<void> => {
    const id = companionIdRef.current;
    if (!id) return;
    stopRequestedRef.current = true;
    try {
      await sideChat.stop(id);
    } catch {
      stopRequestedRef.current = false;
      // best-effort; the terminal event still reconciles state
    }
  }, [sideChat]);

  const steer = useCallback(async (text: string): Promise<boolean> => {
    const id = companionIdRef.current;
    const trimmed = text.trim();
    if (!mountedRef.current || !id || !trimmed || !turnInFlight) return false;
    try {
      const outcome = await sideChat.steer(id, trimmed);
      if (!mountedRef.current) return false;
      if (outcome.kind !== 'queued') return false;
      setError(null);
      return true;
    } catch {
      if (mountedRef.current) setError(copyRef.current.errors.sendFailed);
      return false;
    }
  }, [mountedRef, sideChat, turnInFlight]);

  const setPermissionMode = useCallback(
    async (mode: PermissionMode): Promise<boolean> => {
      const id = companionIdRef.current;
      if (!id || turnInFlight || permissionModePending) return false;
      setPermissionModePending(true);
      try {
        const next = await sideChat.setPermissionMode(id, mode);
        if (!mountedRef.current) return false;
        companionRef.current = next;
        setCompanion(next);
        setError(null);
        return true;
      } catch {
        if (mountedRef.current) setError(copyRef.current.errors.respondFailed);
        return false;
      } finally {
        if (mountedRef.current) setPermissionModePending(false);
      }
    },
    [mountedRef, permissionModePending, sideChat, turnInFlight],
  );

  const regenerate = useCallback(
    async (turnId: string): Promise<boolean> => {
      const id = companionIdRef.current;
      if (!id || turnInFlight || regeneratePendingTurnId) return false;
      setRegeneratePendingTurnId(turnId);
      const regenerationTurnId = crypto.randomUUID();
      stopRequestedRef.current = false;
      activeTurnIdRef.current = regenerationTurnId;
      turnInFlightRef.current = true;
      setTurnInFlight(true);
      setError(null);
      setLiveTurn(armLiveTurn(regenerationTurnId));
      ownTurnIdsRef.current.add(regenerationTurnId);
      setOwnTurnTick((tick) => tick + 1);
      try {
        await sideChat.regenerateTurn(id, {
          sourceTurnId: turnId,
          turnId: regenerationTurnId,
        });
        return true;
      } catch {
        if (mountedRef.current) {
          activeTurnIdRef.current = null;
          turnInFlightRef.current = false;
          setTurnInFlight(false);
          setLiveTurn(undefined);
          setError(copyRef.current.errors.sendFailed);
        }
        return false;
      } finally {
        if (mountedRef.current) setRegeneratePendingTurnId(null);
      }
    },
    [mountedRef, regeneratePendingTurnId, sideChat, turnInFlight],
  );

  const respondToSandboxBoundary = useCallback(
    async (response: SandboxBoundaryResponse): Promise<void> => {
      const id = companionIdRef.current;
      if (!mountedRef.current || !id) return;
      try {
        await sideChat.respondToSandboxBoundary(id, response);
      } catch {
        if (mountedRef.current) setError(copyRef.current.errors.respondFailed);
      }
    },
    [mountedRef, sideChat],
  );

  const respondToUserQuestion = useCallback(
    async (response: UserQuestionResponse): Promise<void> => {
      const id = companionIdRef.current;
      if (!mountedRef.current || !id) return;
      try {
        await sideChat.respondToUserQuestion(id, response);
      } catch {
        if (mountedRef.current) setError(copyRef.current.errors.respondFailed);
      }
    },
    [mountedRef, sideChat],
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
  const permissionMode = (companion?.permissionMode ??
    sourceSession?.permissionMode) as PermissionMode | undefined;
  const activeInteraction = companionIdRef.current
    ? activeInteractionFor(interactions, companionIdRef.current)
    : undefined;
  const activeSandboxBoundary =
    activeInteraction?.type === 'sandbox_boundary_request' ? activeInteraction : undefined;
  const activeQuestion =
    activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;

  return {
    companionSession: companion,
    hasContent,
    messages,
    liveTurn,
    streaming,
    processing,
    preparing,
    permissionMode,
    permissionModePending,
    regeneratePendingTurnId,
    error,
    activeModel,
    activeSandboxBoundary,
    activeQuestion,
    send,
    steer,
    setPermissionMode,
    regenerate,
    stop,
    respondToSandboxBoundary,
    respondToUserQuestion,
  };
}
