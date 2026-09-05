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
  useSessionSettingIntent,
  type InteractionQueues,
  type LiveTurnProjection,
  type TransientUserMessageProjection,
} from '@maka/ui';
import type {
  SandboxBoundaryRequestEvent,
  ClientCapabilityRequestEvent,
  ContextCompactionOutcome,
  FormRequestEvent,
  QuoteRef,
  SessionEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ClientCapabilityResponse } from '@maka/core/client-capability-grant';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { InteractionFormResponse } from '@maka/core/interaction';
import type { ContextCompactResult } from '@maka/runtime-host/protocol';
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
  sessionHasExactModelChoice,
  type CompanionErrorCode,
  type EnsureCompanionForkResult,
} from './quote-companion-core.js';
import { isExactCompactCommand } from './quote-companion-context-compaction.js';
import { mergeSettledMessages } from '../../../../settled-message-merge.js';
import { getDesktopConversationCopy } from '../../../../locales/conversation-copy.js';
import {
  snapshotCompanionQuotes,
  type CompanionQuoteSnapshot,
  type StagedCompanionQuote,
} from './quote-companion-panel-state.js';
import type { CompanionForkVisibilityEvent } from './quote-companion-visibility.js';

type QuoteCompanionSettingValues = { permissionMode: PermissionMode };

type PendingAdmission = {
  messageId: string;
  events: SessionEvent[];
  consumeOnAdmission?: () => void;
  stopPromise?: Promise<'confirmed' | 'unknown'>;
};

type PendingCompactionTerminal =
  | { kind: 'outcome'; turnId: string; outcome: ContextCompactionOutcome }
  | { kind: 'error'; turnId: string; error: unknown };

function readMutableRef<T>(ref: { current: T }): T {
  return ref.current;
}

type AdmissionOutcome =
  | { kind: 'admitted'; turnId: string }
  | { kind: 'retracted' };

function admissionOutcomeForMessage(
  events: readonly SessionEvent[],
  messageId: string,
): AdmissionOutcome | undefined {
  const admitted = events.find(
    (event) =>
      event.type === 'message_admission' &&
      event.outcome === 'admitted' &&
      event.messageId === messageId,
  );
  if (admitted) return { kind: 'admitted', turnId: admitted.turnId };
  const retracted = events.some(
    (event) =>
      event.type === 'message_admission' &&
      event.outcome === 'retracted' &&
      event.messageId === messageId,
  );
  return retracted ? { kind: 'retracted' } : undefined;
}

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
  /** Latest Host-authorized choices used to validate both source and fork. */
  modelChoices: readonly ChatModelChoice[];
  locale: UiLocale;
  /** Called once a send has consumed the staged quotes, so the host clears them. */
  onQuotesConsumed: (snapshot: CompanionQuoteSnapshot) => void;
  /** Confirms the destructive Full access permission mode before it is written. */
  confirmBypass: () => Promise<boolean>;
  /** Reports creation and authoritative cleanup so the host can keep every
   *  ephemeral fork hidden for its complete lifetime. */
  onForkVisibilityChange?: (event: CompanionForkVisibilityEvent) => void;
  /** Presents the immediate result of an explicit companion compaction. */
  onContextCompactionResult?: (sessionId: string, result: ContextCompactResult) => void;
  /** Presents the terminal event for an asynchronous companion compaction. */
  onContextCompactionOutcome?: (
    sessionId: string,
    turnId: string,
    outcome: ContextCompactionOutcome,
  ) => void;
  onContextCompactionError?: (sessionId: string, error: unknown) => void;
}

export async function requestPermissionModeWithConfirmation(
  mode: PermissionMode,
  confirmBypass: () => Promise<boolean>,
  write: () => Promise<boolean>,
): Promise<boolean> {
  if (mode === 'bypass' && !(await confirmBypass())) return false;
  return write();
}

export interface UseQuoteCompanionResult {
  companionSession: SessionSummary | undefined;
  /** True after this temporary conversation has accepted at least one turn. */
  hasContent: boolean;
  /** The companion's OWN turns only — the forked parent history is context for
   *  the model but stays hidden from this side transcript (separate transcript,
   *  like Codex /side), so the panel isn't a duplicate of the main conversation. */
  messages: StoredMessage[];
  /** Optimistic, renderer-only user bubbles shown the instant a send dispatches,
   *  before the durable transcript echoes them back. Reconciled away once the
   *  durable message with the same id lands. Pass straight to `ChatView`. */
  transientMessages: readonly TransientUserMessageProjection[];
  liveTurn: LiveTurnProjection | undefined;
  streaming: boolean;
  processing: boolean;
  /** Whether the source and any committed companion can execute their exact model. */
  modelReady: boolean;
  permissionMode: PermissionMode | undefined;
  regeneratePendingTurnId: string | null;
  /** A localized, retryable error (fork setup, run error, or a rejected send). */
  error: string | null;
  /** The model the companion inherited from the source (shown read-only). */
  activeModel: { llmConnectionSlug: string; model: string } | undefined;
  /** Pending sandbox-boundary / question / form prompt raised by the companion's run. */
  activeSandboxBoundary: SandboxBoundaryRequestEvent | undefined;
  activeClientCapability: ClientCapabilityRequestEvent | undefined;
  activeQuestion: UserQuestionRequestEvent | undefined;
  activeForm: FormRequestEvent | undefined;
  /** Runs `/compact` against the committed companion fork when it is idle. */
  compact: () => Promise<boolean>;
  /** Returns whether the send was accepted; false leaves the draft + staged
   *  quotes in place so the user can retry. */
  send: (text: string, attachmentItems?: WorkbarIngestInput[]) => Promise<boolean>;
  /** Insert text into the active companion turn at the next model step. */
  steer: (text: string) => Promise<boolean>;
  setPermissionMode: (mode: PermissionMode) => Promise<boolean>;
  regenerate: (turnId: string) => Promise<boolean>;
  stop: () => Promise<void>;
  respondToSandboxBoundary: (response: SandboxBoundaryResponse) => Promise<void>;
  respondToClientCapability: (response: ClientCapabilityResponse) => Promise<void>;
  respondToUserQuestion: (response: UserQuestionResponse) => Promise<void>;
  respondToUserForm: (response: InteractionFormResponse) => Promise<void>;
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
    modelChoices,
    pendingQuotes,
    onQuotesConsumed,
    onForkVisibilityChange,
    onContextCompactionResult,
    onContextCompactionOutcome,
    onContextCompactionError,
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
  const modelChoicesRef = useRef(modelChoices);
  modelChoicesRef.current = modelChoices;
  const confirmBypassRef = useRef(input.confirmBypass);
  confirmBypassRef.current = input.confirmBypass;
  const sourceModelReady = sessionHasExactModelChoice(sourceSession, modelChoices);
  const sourceSessionId = sourceSession?.id;
  const sourceSessionIdRef = useRef(sourceSession?.id);
  sourceSessionIdRef.current = sourceSessionId;
  const forkSetupPromiseRef = useRef<Promise<EnsureCompanionForkResult> | null>(null);
  const stopRequestRef = useRef<Promise<unknown> | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const pendingAdmissionRef = useRef<PendingAdmission | null>(null);
  const reconcilingAdmissionRef = useRef<PendingAdmission | null>(null);
  const subscriptionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const submitLockRef = useRef(false);
  const settlingTurnIdsRef = useRef<Set<string>>(new Set());
  const onForkVisibilityChangeRef = useRef(onForkVisibilityChange);
  onForkVisibilityChangeRef.current = onForkVisibilityChange;
  const onContextCompactionResultRef = useRef(onContextCompactionResult);
  onContextCompactionResultRef.current = onContextCompactionResult;
  const onContextCompactionOutcomeRef = useRef(onContextCompactionOutcome);
  onContextCompactionOutcomeRef.current = onContextCompactionOutcome;
  const onContextCompactionErrorRef = useRef(onContextCompactionError);
  onContextCompactionErrorRef.current = onContextCompactionError;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const ownTurnIdsRef = useRef<Set<string>>(new Set());
  const compactionRequestInFlightRef = useRef(false);
  const compactionTurnIdRef = useRef<string | null>(null);
  const pendingCompactionTerminalRef = useRef<PendingCompactionTerminal | null>(null);
  const [allMessages, setAllMessages] = useState<StoredMessage[]>([]);
  // Renderer-only user bubble shown the instant a send dispatches. The durable
  // transcript only echoes the just-sent question back mid-turn on a single
  // best-effort refresh (and otherwise not until the turn settles), so without
  // this the user's message stays invisible until the whole answer completes.
  // Mirrors the main chat's optimistic `transientMessages`; reconciled away once
  // the durable message with the same id lands in `allMessages`.
  const [pendingUserMessages, setPendingUserMessages] = useState<
    TransientUserMessageProjection[]
  >([]);
  const [liveTurn, setLiveTurn] = useState<LiveTurnProjection | undefined>(undefined);
  const liveTurnRef = useRef(liveTurn);
  liveTurnRef.current = liveTurn;
  const [interactions, setInteractions] = useState<InteractionQueues>({});
  const [pendingAdmission, setPendingAdmissionState] = useState<PendingAdmission | null>(null);
  const { streaming, processing } = deriveCompanionComposerState(
    pendingAdmission !== null,
    activeTurnIdRef.current,
    liveTurn,
  );
  const turnInFlight = streaming;
  const [regeneratePendingTurnId, setRegeneratePendingTurnId] = useState<string | null>(
    null,
  );
  const [hasContent, setHasContent] = useState(false);
  const hasContentRef = useRef(hasContent);
  hasContentRef.current = hasContent;
  const [error, setError] = useState<string | null>(null);
  // A permission mode the user picked before the fork exists. Applied to the
  // fork once the first send creates it; until then it drives the read-only chip.
  const [stagedPermissionMode, setStagedPermissionMode] = useState<PermissionMode | undefined>(
    undefined,
  );
  const pendingPermissionModeRef = useRef<PermissionMode | undefined>(undefined);
  // Bumped whenever the own-turn set changes so the render picks up the new
  // filter result (the set lives in a ref to stay stable for the event handler).
  const [, setOwnTurnTick] = useState(0);
  // The live event subscription's unsubscribe, established at fork-commit time.
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // StrictMode-safe mounted guard (re-arms on the dev mount → unmount → remount
  // double-invoke; a hand-rolled disposed flag would stay tripped after replay).
  const mountedRef = useMountedRef();
  const dismissalGuardRef = useRef(createCompanionDismissalGuard());
  const [permissionCatalogRevision, setPermissionCatalogRevision] = useState(0);
  const permissionModeIntent = useSessionSettingIntent<QuoteCompanionSettingValues>({
    catalogRevision: permissionCatalogRevision,
    refreshCatalog: async () => {
      const sessionId = companionIdRef.current;
      if (!sessionId) return;
      const sessions = await sideChat.listSessions();
      const next = sessions.find((session) => session.id === sessionId);
      if (!mountedRef.current || companionIdRef.current !== sessionId || !next) return;
      companionRef.current = next;
      setCompanion(next);
      setPermissionCatalogRevision((revision) => revision + 1);
    },
    channels: {
      permissionMode: {
        write: async (sessionId, mode) => {
          const next = await sideChat.setPermissionMode(sessionId, mode);
          if (mountedRef.current && companionIdRef.current === sessionId) {
            companionRef.current = next;
            setCompanion(next);
          }
          return next.permissionMode === mode;
        },
        onWriteError: () => {
          if (mountedRef.current) setError(copyRef.current.errors.respondFailed);
        },
      },
    },
  });
  const requestPermissionMode = useCallback(
    (sessionId: string, mode: PermissionMode) =>
      permissionModeIntent.request('permissionMode', sessionId, mode),
    [permissionModeIntent.request],
  );
  const clearPermissionModeIntent = permissionModeIntent.clear;

  const setPendingAdmission = useCallback((admission: PendingAdmission | null) => {
    pendingAdmissionRef.current = admission;
    setPendingAdmissionState(admission);
  }, []);
  // Reentrancy is guarded by the ref alone; no render depends on the lock, so
  // there is no state to keep in sync.
  const setSubmitLocked = useCallback((locked: boolean) => {
    submitLockRef.current = locked;
  }, []);

  // Retire the optimistic bubble for a message id. Called when a send is
  // retracted/abandoned; the success path retires it implicitly by reconciling
  // against the durable transcript (see the `transientMessages` derivation).
  const dropOptimisticUserMessage = useCallback((messageId: string) => {
    setPendingUserMessages((current) => {
      const next = current.filter((message) => message.id !== messageId);
      return next.length === current.length ? current : next;
    });
  }, []);

  const applyOwnedEvent = useCallback(
    (forkId: string, event: SessionEvent) => {
      const terminal: PendingCompactionTerminal | undefined =
        event.type === 'complete' && event.contextCompactionOutcome
          ? { kind: 'outcome', turnId: event.turnId, outcome: event.contextCompactionOutcome }
          : event.type === 'abort' || (event.type === 'error' && !event.recoverable)
            ? { kind: 'error', turnId: event.turnId, error: event }
            : undefined;
      if (terminal) {
        if (compactionTurnIdRef.current === terminal.turnId) {
          compactionTurnIdRef.current = null;
          compactionRequestInFlightRef.current = false;
          if (terminal.kind === 'outcome') {
            onContextCompactionOutcomeRef.current?.(forkId, terminal.turnId, terminal.outcome);
          } else {
            onContextCompactionErrorRef.current?.(forkId, terminal.error);
          }
        } else if (compactionRequestInFlightRef.current) {
          // The Host can publish the terminal event before the compact RPC
          // returns its turn identity. Keep it fenced until the response
          // proves that this event belongs to the pending compaction.
          pendingCompactionTerminalRef.current = terminal;
        }
      }
      const effect = companionRunEventEffect(
        event,
        activeTurnIdRef.current,
        stopRequestRef.current !== null,
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
            stopRequestRef.current = null;
          })
          .catch(() => {
            if (!mountedRef.current || activeTurnIdRef.current !== settledTurnId) return;
            activeTurnIdRef.current = null;
            stopRequestRef.current = null;
            setError((current) => current ?? copyRef.current.errors.settlementFailed);
          })
          .finally(() => {
            settlingTurnIdsRef.current.delete(settledTurnId);
          });
      }
    },
    [mountedRef, sideChat],
  );

  const bindAdmittedTurn = useCallback(
    (
      forkId: string,
      turnId: string,
      options: { readonly preserveLiveTurn?: boolean } = {},
    ) => {
      const admission = pendingAdmissionRef.current;
      if (!admission) return;
      setPendingAdmission(null);
      // Host admission is the durable-content boundary. Even if a concurrent
      // Stop interrupts the Run before send() settles, this fork now owns a
      // persisted user message and must never be replaced as an empty copy.
      hasContentRef.current = true;
      setHasContent(true);
      activeTurnIdRef.current = turnId;
      ownTurnIdsRef.current.add(turnId);
      admission.consumeOnAdmission?.();
      setError(null);
      setOwnTurnTick((tick) => tick + 1);
      if (!(options.preserveLiveTurn && liveTurnRef.current?.turnId === turnId)) {
        setLiveTurn(armLiveTurn(turnId));
      }
      for (const event of admission.events) {
        if (event.turnId === turnId) applyOwnedEvent(forkId, event);
      }
    },
    [applyOwnedEvent, setPendingAdmission],
  );

  // A Message whose admission answer was lost is still reconcilable: the Host
  // materializes a root Message before its Run starts, so the durable
  // transcript names the Turn it opened under the identity the panel sent.
  const reconcileUnknownAdmission = useCallback(
    async (forkId: string, admission: PendingAdmission): Promise<void> => {
      if (reconcilingAdmissionRef.current === admission) return;
      reconcilingAdmissionRef.current = admission;
      try {
        const { messages } = await sideChat.readSettledMessages(forkId);
        if (!mountedRef.current || pendingAdmissionRef.current !== admission) return;
        const admitted = messages.find(
          (message) => message.type === 'user' && message.id === admission.messageId,
        );
        if (admitted?.turnId) {
          bindAdmittedTurn(forkId, admitted.turnId, { preserveLiveTurn: true });
        }
      } catch {
        // The next event this fork produces is another chance to reconcile.
      } finally {
        if (reconcilingAdmissionRef.current === admission) {
          reconcilingAdmissionRef.current = null;
        }
      }
    },
    [bindAdmittedTurn, mountedRef, sideChat],
  );

  const releaseAdmission = useCallback(
    (admission: PendingAdmission, message?: string) => {
      if (pendingAdmissionRef.current !== admission) return;
      setPendingAdmission(null);
      // The send is being abandoned (retracted / failed): the optimistic bubble
      // would otherwise linger with no turn to reconcile it away.
      dropOptimisticUserMessage(admission.messageId);
      if (stopRequestRef.current === admission.stopPromise) stopRequestRef.current = null;
      if (!activeTurnIdRef.current) setLiveTurn(undefined);
      if (message) setError(message);
    },
    [dropOptimisticUserMessage, setPendingAdmission],
  );

  const resolveAdmission = useCallback(
    (
      forkId: string,
      admission: PendingAdmission,
      messageId: string,
      preserveLiveTurn = false,
    ): AdmissionOutcome | undefined => {
      const outcome = admissionOutcomeForMessage(admission.events, messageId);
      if (outcome?.kind === 'admitted') {
        bindAdmittedTurn(forkId, outcome.turnId, { preserveLiveTurn });
      } else if (outcome?.kind === 'retracted') {
        releaseAdmission(admission);
      }
      return outcome;
    },
    [bindAdmittedTurn, releaseAdmission],
  );

  // Subscribe to the fork's event stream + load its transcript. Called
  // synchronously the moment the fork is committed, BEFORE the run starts, so
  // no boundary request / complete can be missed (the stream has no replay).
  const subscribeToFork = useCallback((forkId: string): Promise<void> => {
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let readySettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolve();
      };
      rejectReady = (error: unknown) => {
        if (readySettled) return;
        readySettled = true;
        reject(error);
      };
    });
    // A subscription can fail before the first send. Keep that failure
    // observable to a later send without creating an unhandled rejection now.
    void ready.catch(() => undefined);
    void sideChat.readSettledMessages(forkId)
      .then(({ messages }) => {
        if (mountedRef.current) {
          setAllMessages((current) => mergeSettledMessages(current, messages));
        }
      })
      .catch(() => {
        if (mountedRef.current) setError(copyRef.current.errors.settlementFailed);
      });
    const unsubscribe = sideChat.subscribeEvents(
      forkId,
      (event: SessionEvent) => {
        if (!mountedRef.current) return;
        const admission = pendingAdmissionRef.current;
        if (event.type === 'error' && event.recoverable) {
          if (admission) {
            // Observation failure does not prove whether Host admitted the
            // dispatched command. Keep its identity until Host events or the
            // command result provide an authoritative outcome.
            setError(copyRef.current.errors.sendFailed);
            return;
          }
          setError(copyRef.current.errors.sendFailed);
          const retry = Promise.reject(new Error(event.message));
          void retry.catch(() => undefined);
          subscriptionReadyRef.current = retry;
          return;
        }
        if (admission) {
          if (
            event.type === 'message_admission' &&
            event.messageId === admission.messageId
          ) {
            admission.events.push(event);
            resolveAdmission(forkId, admission, admission.messageId, true);
          } else if (event.turnId === activeTurnIdRef.current) {
            applyOwnedEvent(forkId, event);
          } else {
            admission.events.push(event);
            // This fork is producing Turn events while the panel still holds an
            // unproven Message: the transcript can say whether they are its own.
            void reconcileUnknownAdmission(forkId, admission);
          }
          return;
        }
        applyOwnedEvent(forkId, event);
      },
      resolveReady,
      rejectReady,
    );
    let disposed = false;
    unsubscribeRef.current = () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      // A send waiting for observation readiness must finish when the panel is
      // disposed; its mounted check below then turns this into a clean no-op.
      resolveReady();
    };
    return ready;
  }, [applyOwnedEvent, mountedRef, resolveAdmission, sideChat]);

  const commitFork = useCallback(
    (session: SessionSummary) => {
      pendingForkIdRef.current = null;
      companionIdRef.current = session.id;
      companionRef.current = session;
      setCompanion(session);
      subscriptionReadyRef.current = subscribeToFork(session.id);
    },
    [subscribeToFork],
  );

  const ensureFork = useCallback(
    (name: string): Promise<EnsureCompanionForkResult> => {
      if (forkSetupPromiseRef.current) return forkSetupPromiseRef.current;
      const currentSourceSession = sourceSessionRef.current;
      if (
        !currentSourceSession ||
        !sessionHasExactModelChoice(currentSourceSession, modelChoicesRef.current)
      ) {
        return Promise.resolve({ status: 'error', code: 'fork_setup_failed' });
      }
      const existing = companionRef.current;
      if (existing && sessionHasExactModelChoice(existing, modelChoicesRef.current)) {
        return Promise.resolve({ status: 'ready', session: existing });
      }
      // Never discard an accepted side conversation implicitly. An unavailable
      // empty fork can be recreated from the repaired source; a fork with its
      // own content stays inspectable until the user closes the panel. (The
      // submit lock is held by the send that drives this call, so it is not a
      // reason to refuse replacing an idle empty fork.)
      if (
        existing &&
        (hasContentRef.current ||
          pendingAdmissionRef.current !== null ||
          activeTurnIdRef.current !== null)
      ) {
        return Promise.resolve({ status: 'error', code: 'fork_setup_failed' });
      }

      const promise = (async (): Promise<EnsureCompanionForkResult> => {
        if (existing) {
          const sourceId = sourceSessionIdRef.current;
          if (!sourceId) return { status: 'error', code: 'fork_setup_failed' };
          const cleaned = await dismissCompanionCopy(sideChat, sourceId, panelId, existing.id);
          if (!cleaned) return { status: 'error', code: 'fork_setup_failed' };
          unsubscribeRef.current?.();
          unsubscribeRef.current = null;
          subscriptionReadyRef.current = Promise.resolve();
          companionIdRef.current = null;
          companionRef.current = undefined;
          clearPermissionModeIntent(existing.id);
          setCompanion(undefined);
          setAllMessages([]);
          onForkVisibilityChangeRef.current?.({
            type: 'cleanup-succeeded',
            sessionId: existing.id,
          });
        }

        const latestSource = sourceSessionRef.current;
        if (
          !latestSource ||
          !sessionHasExactModelChoice(latestSource, modelChoicesRef.current)
        ) {
          return { status: 'error', code: 'fork_setup_failed' };
        }
        return ensureCompanionFork({
          api: sideChat,
          sourceSession: latestSource,
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
        });
      })()
        .then(async (result): Promise<EnsureCompanionForkResult> => {
          if (
            result.status === 'ready' &&
            !sessionHasExactModelChoice(result.session, modelChoicesRef.current)
          ) {
            const sourceId = sourceSessionIdRef.current;
            const cleaned = sourceId
              ? await dismissCompanionCopy(sideChat, sourceId, panelId, result.session.id)
              : false;
            if (pendingForkIdRef.current === result.session.id) {
              pendingForkIdRef.current = null;
            }
            if (cleaned) {
              onForkVisibilityChangeRef.current?.({
                type: 'cleanup-succeeded',
                sessionId: result.session.id,
              });
            }
            return { status: 'error', code: 'fork_setup_failed' };
          }
          if (result.status === 'ready' && mountedRef.current) {
            setError(null);
            commitFork(result.session);
          } else if (result.status === 'error' && mountedRef.current) {
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
        });
      forkSetupPromiseRef.current = promise;
      return promise;
    },
    [clearPermissionModeIntent, commitFork, mountedRef, panelId, sideChat],
  );

  // A committed side conversation with its own content is blocked when its
  // inherited model is no longer available (the read-only model can't be sent
  // to). An EMPTY fork (e.g. a first send that failed after commit) must not
  // wedge the composer: the next send discards it and re-forks from the current
  // source model, so treat it as ready regardless of its stale inherited model.
  const companionModelReady =
    companion === undefined ||
    !hasContent ||
    sessionHasExactModelChoice(companion, modelChoices);

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

  const compact = useCallback(async (): Promise<boolean> => {
    const fork = companionRef.current;
    if (
      !mountedRef.current ||
      !fork ||
      fork.isArchived ||
      !sessionHasExactModelChoice(fork, modelChoicesRef.current) ||
      compactionRequestInFlightRef.current ||
      submitLockRef.current ||
      pendingAdmissionRef.current ||
      activeTurnIdRef.current ||
      (fork.runningTurnIds?.length ?? 0) > 0
    ) {
      return false;
    }
    compactionRequestInFlightRef.current = true;
    pendingCompactionTerminalRef.current = null;
    let awaitingTerminal = false;
    try {
      const result = await sideChat.compact(fork.id);
      if (!mountedRef.current) return false;
      awaitingTerminal = result.kind === 'started';
      compactionTurnIdRef.current = result.turn.turnId;
      onContextCompactionResultRef.current?.(fork.id, result);
      const pendingTerminal = readMutableRef(pendingCompactionTerminalRef);
      if (pendingTerminal?.turnId === result.turn.turnId) {
        pendingCompactionTerminalRef.current = null;
        compactionRequestInFlightRef.current = false;
        compactionTurnIdRef.current = null;
        if (result.kind === 'started') {
          if (pendingTerminal.kind === 'outcome') {
            onContextCompactionOutcomeRef.current?.(
              fork.id,
              pendingTerminal.turnId,
              pendingTerminal.outcome,
            );
          } else {
            onContextCompactionErrorRef.current?.(fork.id, pendingTerminal.error);
          }
        }
      } else if (result.kind === 'finished') {
        pendingCompactionTerminalRef.current = null;
        compactionRequestInFlightRef.current = false;
        compactionTurnIdRef.current = null;
      }
      return result.kind === 'started' || result.outcome.kind !== 'failed';
    } catch (error) {
      onContextCompactionErrorRef.current?.(fork.id, error);
      return false;
    } finally {
      if (!mountedRef.current || !awaitingTerminal) {
        compactionRequestInFlightRef.current = false;
        if (!awaitingTerminal) compactionTurnIdRef.current = null;
      }
    }
  }, [mountedRef, sideChat]);

  const send = useCallback(
    async (
      text: string,
      attachmentItems?: WorkbarIngestInput[],
    ): Promise<boolean> => {
      const trimmed = text.trim();
      if (isExactCompactCommand(trimmed)) return compact();
      if (
        !mountedRef.current ||
        !trimmed ||
        submitLockRef.current ||
        compactionRequestInFlightRef.current ||
        activeTurnIdRef.current ||
        pendingAdmissionRef.current ||
        !sourceSession
      ) {
        return false;
      }
      // Close the same-frame double-submit window before fork readiness can yield.
      setSubmitLocked(true);
      setError(null);
      const turnId = crypto.randomUUID();
      const quoteSnapshot = snapshotCompanionQuotes(panelId, pendingQuotes);
      const label = (quoteSnapshot.quotes[0]?.text ?? trimmed).slice(0, 24);
      // Show the user's question IMMEDIATELY as an optimistic bubble, before the
      // fork exists. On a first send `ensureFork` makes a Host round trip, and the
      // main chat renders the question the instant Send is pressed; the side panel
      // must match rather than stay blank until the fork materializes. The bubble
      // ALSO lights the running-status line — the panel derives it from
      // `streaming || transientMessages.length > 0` — so the "working" cue rises
      // in this same window WITHOUT arming the admission early. Arming it here
      // would flip `streaming` on and render the Composer's Stop button while
      // `stop()` is still a no-op (`companionIdRef` is only set at commitFork): a
      // visible-but-dead control for the whole fork round trip. So the admission
      // and live turn are armed in `onBeforeSend`, once the fork can actually be
      // stopped; the double-submit window stays closed by `submitLockRef`.
      // `abandonOptimisticSend` retires the bubble if setup fails before the send.
      const admission: PendingAdmission = {
        messageId: turnId,
        events: [],
        consumeOnAdmission: () => onQuotesConsumed(quoteSnapshot),
      };
      setPendingUserMessages((current) => [
        ...current.filter((message) => message.id !== turnId),
        {
          id: turnId,
          text: trimmed,
          ts: Date.now(),
          transientPlacement: 'current_turn',
          ...(quoteSnapshot.quotes.length > 0 ? { quotes: quoteSnapshot.quotes } : {}),
        },
      ]);
      // Setup can still fail before the send is in flight (fork unavailable,
      // fail-closed permission write, or a lost subscription). Retire the
      // optimistic bubble and release the lock so a failed first send never
      // strands a question with no turn to reconcile it away. The admission and
      // live turn are not armed until `onBeforeSend`, so nothing else to unwind.
      const abandonOptimisticSend = () => {
        dropOptimisticUserMessage(turnId);
        setSubmitLocked(false);
      };
      const fork = await ensureFork(`${copyRef.current.namePrefix}${label}`);
      if (fork.status !== 'ready') {
        abandonOptimisticSend();
        return false;
      }
      // A permission mode picked before the fork existed is applied now, before
      // the turn runs, so the run honors the user's choice. Fail CLOSED: if the
      // write fails, abort the send rather than run under the (possibly wider)
      // inherited mode; keep the staged mode and draft so the user can retry.
      if (
        pendingPermissionModeRef.current &&
        pendingPermissionModeRef.current !== fork.session.permissionMode
      ) {
        let applied = false;
        try {
          applied = await requestPermissionMode(
            fork.session.id,
            pendingPermissionModeRef.current,
          );
        } catch {
          applied = false;
        }
        if (!mountedRef.current) {
          abandonOptimisticSend();
          return false;
        }
        if (!applied) {
          setError(copyRef.current.errors.respondFailed);
          abandonOptimisticSend();
          return false;
        }
      }
      pendingPermissionModeRef.current = undefined;
      setStagedPermissionMode(undefined);
      try {
        await subscriptionReadyRef.current;
      } catch {
        if (mountedRef.current) {
          unsubscribeRef.current?.();
          subscriptionReadyRef.current = subscribeToFork(fork.session.id);
          setError(copyRef.current.errors.sendFailed);
        }
        abandonOptimisticSend();
        return false;
      }
      if (!mountedRef.current) {
        abandonOptimisticSend();
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
        // The send is now in flight against a committed fork, so the Stop button
        // can finally stop something: arm the admission (flips `streaming` on)
        // and the live turn, and release the submit lock. The optimistic bubble
        // is already on screen from before `ensureFork`.
        onBeforeSend: () => {
          stopRequestRef.current = null;
          setPendingAdmission(admission);
          setSubmitLocked(false);
          setLiveTurn(armLiveTurn(turnId));
        },
      });
      if (result.status === 'sent' || result.status === 'pending') {
        if (result.status === 'pending') {
          const outcome = resolveAdmission(result.forkId, admission, result.messageId);
          if (outcome?.kind === 'retracted') {
            return false;
          }
          void reconcileUnknownAdmission(result.forkId, admission);
        } else if (result.steered) {
          if (resolveAdmission(result.forkId, admission, result.messageId)?.kind === 'retracted') {
            return false;
          }
        } else {
          bindAdmittedTurn(result.forkId, result.turnId);
        }
        if ((await admission.stopPromise) === 'confirmed') return false;
        setHasContent(true);
        // Surface the just-sent user message, and reflect any automatic
        // connection/model rebound in the read-only model label. Wait for THIS
        // message to be durable (requiredAssistantMessageId gates on any message
        // id) rather than returning the first ready snapshot: on a follow-up the
        // transcript store is already "ready" from the prior turn, so an
        // unqualified read returns stale and the new turn never lands in
        // `messages`. Without the turn, the running-status line ("正在推敲…") has
        // nothing to attach to and only appears once the answer starts settling.
        // The Host mints the user message id from the reserved turn id (`const
        // messageId = turnId`), so a pending/steered `result.messageId` equals
        // `turnId` — one identity across every path.
        void sideChat
          .readSettledMessages(result.forkId, {
            requiredAssistantMessageId: turnId,
          })
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
        releaseAdmission(admission);
        setLiveTurn(undefined);
      }
      // 'disposed' → the panel unmounted mid-create; nothing to update.
      setSubmitLocked(false);
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
      bindAdmittedTurn,
      compact,
      dropOptimisticUserMessage,
      releaseAdmission,
      resolveAdmission,
      setPendingAdmission,
      setSubmitLocked,
      requestPermissionMode,
    ],
  );

  const stop = useCallback(async (): Promise<void> => {
    const id = companionIdRef.current;
    if (!id || stopRequestRef.current) return;
    const admission = pendingAdmissionRef.current;
    if (admission) {
      const stopPromise = sideChat.stop(id, {
        kind: 'admission',
        messageId: admission.messageId,
      }).then(
        (outcome) => {
          if (
            outcome?.kind === 'retracted' &&
            outcome.messageId === admission.messageId
          ) {
            releaseAdmission(admission);
          }
          return 'confirmed' as const;
        },
        () => {
          // A rejected Stop tells us nothing about whether the Host stopped
          // the Turn. Keep the admission alive so a late Host outcome can
          // still bind its own Turn; the user can retry Stop after this.
          if (pendingAdmissionRef.current === admission) {
            admission.stopPromise = undefined;
            resolveAdmission(id, admission, admission.messageId, true);
          }
          if (stopRequestRef.current === stopPromise) stopRequestRef.current = null;
          return 'unknown' as const;
        },
      );
      admission.stopPromise = stopPromise;
      stopRequestRef.current = stopPromise;
      await stopPromise;
      return;
    }
    const activeTurnId = activeTurnIdRef.current;
    const stopPromise = sideChat.stop(
      id,
      activeTurnId ? { kind: 'turn', turnId: activeTurnId } : undefined,
    );
    stopRequestRef.current = stopPromise;
    try {
      await stopPromise;
    } catch {
      if (stopRequestRef.current === stopPromise) stopRequestRef.current = null;
      // best-effort; the terminal event still reconciles state
    }
  }, [releaseAdmission, resolveAdmission, sideChat]);

  const steer = useCallback(async (text: string): Promise<boolean> => {
    const id = companionIdRef.current;
    const trimmed = text.trim();
    if (
      !mountedRef.current ||
      !id ||
      !trimmed ||
      !turnInFlight ||
      pendingAdmissionRef.current
    ) {
      return false;
    }
    const admissionId = crypto.randomUUID();
    const admission: PendingAdmission = {
      messageId: admissionId,
      events: [],
    };
    setPendingAdmission(admission);
    try {
      const outcome = await sideChat.steer(id, trimmed, admissionId);
      if (!mountedRef.current) return false;
      if ((await admission.stopPromise) === 'confirmed') return false;
      if (admissionOutcomeForMessage(admission.events, admission.messageId)?.kind === 'retracted') {
        return false;
      }
      if (outcome.kind === 'started') {
        bindAdmittedTurn(id, outcome.turnId, { preserveLiveTurn: true });
      } else if (resolveAdmission(id, admission, outcome.messageId, true)?.kind === 'retracted') {
        return false;
      }
      setError(null);
      return true;
    } catch {
      if (mountedRef.current) {
        if (pendingAdmissionRef.current === admission) {
          releaseAdmission(admission, copyRef.current.errors.sendFailed);
        } else if (
          admissionOutcomeForMessage(admission.events, admission.messageId)?.kind !== 'retracted'
        ) {
          setError(copyRef.current.errors.sendFailed);
        }
      }
      return false;
    }
  }, [
    bindAdmittedTurn,
    mountedRef,
    releaseAdmission,
    resolveAdmission,
    setPendingAdmission,
    sideChat,
    turnInFlight,
  ]);

  const setPermissionMode = useCallback(
    (mode: PermissionMode): Promise<boolean> => {
      const id = companionIdRef.current;
      if (turnInFlight) return Promise.resolve(false);
      setError(null);
      if (!id) {
        // No fork yet — confirm the destructive mode, then stage it so the
        // first send applies it instead of silently inheriting the source mode.
        return requestPermissionModeWithConfirmation(
          mode,
          () => confirmBypassRef.current(),
          () => {
            pendingPermissionModeRef.current = mode;
            setStagedPermissionMode(mode);
            return Promise.resolve(true);
          },
        );
      }
      return requestPermissionModeWithConfirmation(
        mode,
        () => confirmBypassRef.current(),
        () => requestPermissionMode(id, mode),
      );
    },
    [requestPermissionMode, turnInFlight],
  );

  const regenerate = useCallback(
    async (turnId: string): Promise<boolean> => {
      const id = companionIdRef.current;
      if (!id || turnInFlight || regeneratePendingTurnId) return false;
      setRegeneratePendingTurnId(turnId);
      const regenerationTurnId = crypto.randomUUID();
      stopRequestRef.current = null;
      activeTurnIdRef.current = regenerationTurnId;
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

  const respondToClientCapability = useCallback(
    async (response: ClientCapabilityResponse): Promise<void> => {
      const id = companionIdRef.current;
      if (!mountedRef.current || !id) return;
      try {
        await sideChat.respondToClientCapability(id, response);
      } catch {
        if (mountedRef.current) setError(copyRef.current.errors.respondFailed);
      }
    },
    [mountedRef, sideChat],
  );

  const respondToUserForm = useCallback(
    async (response: InteractionFormResponse): Promise<void> => {
      const id = companionIdRef.current;
      if (!mountedRef.current || !id) return;
      try {
        await sideChat.respondToUserForm(id, response);
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
  // Drop the optimistic bubble only once its durable twin will actually RENDER,
  // i.e. it is in `messages` (own-turn filtered) — not merely settled into
  // `allMessages`. Building this from `allMessages` could retire the transient on
  // an `outcome_unknown` settle while the durable message is still filtered out of
  // the render, blinking the question away until `reconcileUnknownAdmission` binds.
  const durableMessageIds = new Set(messages.map((message) => message.id));
  const transientMessages = pendingUserMessages.filter(
    (message) => !durableMessageIds.has(message.id),
  );
  // Inherited model (read-only): the fork's once created, else the source's.
  const activeModel = companion
    ? { llmConnectionSlug: companion.llmConnectionSlug, model: companion.model }
    : sourceSession
      ? { llmConnectionSlug: sourceSession.llmConnectionSlug, model: sourceSession.model }
      : undefined;
  const companionPermissionOverlay = companion?.id
    ? permissionModeIntent.overlayByChannel.permissionMode[companion.id]
    : undefined;
  // A staged mode (chosen before the fork, not yet applied) outranks the fork's
  // inherited mode so a fail-closed first send still shows the user's choice.
  const permissionMode = (companionPermissionOverlay ??
    stagedPermissionMode ??
    companion?.permissionMode ??
    sourceSession?.permissionMode) as PermissionMode | undefined;
  const activeInteraction = companionIdRef.current
    ? activeInteractionFor(interactions, companionIdRef.current)
    : undefined;
  const activeSandboxBoundary =
    activeInteraction?.type === 'sandbox_boundary_request' ? activeInteraction : undefined;
  const activeClientCapability =
    activeInteraction?.type === 'client_capability_request' ? activeInteraction : undefined;
  const activeQuestion =
    activeInteraction?.type === 'user_question_request' ? activeInteraction : undefined;
  const activeForm = activeInteraction?.type === 'form_request' ? activeInteraction : undefined;

  return {
    companionSession: companion,
    hasContent,
    messages,
    transientMessages,
    liveTurn,
    streaming,
    processing,
    modelReady: sourceModelReady && companionModelReady,
    permissionMode,
    regeneratePendingTurnId,
    error,
    activeModel,
    activeSandboxBoundary,
    activeClientCapability,
    activeQuestion,
    activeForm,
    compact,
    send,
    steer,
    setPermissionMode,
    regenerate,
    stop,
    respondToSandboxBoundary,
    respondToClientCapability,
    respondToUserQuestion,
    respondToUserForm,
  };
}
