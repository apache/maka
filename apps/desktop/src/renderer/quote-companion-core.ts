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

import {
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  type InteractionQueues,
  type LiveTurnProjection,
} from '@maka/ui';
import type { PermissionMode } from '@maka/core/permission';
import type { QuoteRef, SessionEvent } from '@maka/core/events';
import type { SessionSummary, TurnRecord } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { RendererIngestInput } from '../preload/bridge-contract.js';
import {
  acquireSessionCopyAttempt,
  abandonSessionCopyAttempt,
  completeSessionCopyAttempt,
  listSessionCopyAttempts,
  readSessionCopyAttempt,
  startSessionCopyAttempt,
  type SessionCopyAttemptKey,
} from './session-copy-attempt.js';
import { sessionEventErrorMessage } from './model-connection-errors.js';

/** `sessions.send` resolves (does not throw) with this shape when the run was
 *  not actually started — e.g. an unresolved `/skill:...` invocation. */
type CompanionSendResult = { ok: true } | { ok: false; reason?: string };

/**
 * The subset of the sessions bridge the quote companion drives. Extracted so the
 * fork-creation / guard / send orchestration can be unit-tested with a fake in
 * place of `window.maka.sessions` (the React hook stays a thin shell).
 */
export interface CompanionSessionApi {
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  branchFromTurn(
    sessionId: string,
    input: {
      sourceTurnId: string;
      name?: string;
      copyId: string;
      sideConversation?: boolean;
    },
  ): Promise<SessionSummary>;
  cleanupSessionCopy(sessionId: string): Promise<void>;
  abandonSessionCopy(sourceSessionId: string, copyId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  send(
    sessionId: string,
    command: {
      type: 'send';
      turnId: string;
      text: string;
      quotes?: QuoteRef[];
      attachmentItems?: RendererIngestInput[];
    },
  ): Promise<CompanionSendResult>;
}

/** Structured failure reasons the renderer localizes (no user-facing strings in
 *  core). `fork_setup_failed`: reading the source boundary or creating the fork
 *  failed; `send_failed`: `sessions.send` threw; `send_rejected`: it resolved
 *  `{ok:false}`. */
export type CompanionErrorCode =
  | 'fork_setup_failed'
  | 'send_failed'
  | 'send_rejected';

export type EnsureCompanionForkResult =
  | { status: 'ready'; session: SessionSummary }
  | { status: 'disposed' }
  | { status: 'error'; code: CompanionErrorCode };

export interface CompanionDismissalGuard {
  beginMount(): () => boolean;
}

export function createCompanionDismissalGuard(): CompanionDismissalGuard {
  let generation = 0;
  return {
    beginMount: () => {
      const mountedGeneration = ++generation;
      return () => generation === mountedGeneration;
    },
  };
}

export interface EnsureCompanionForkDeps {
  api: CompanionSessionApi;
  sourceSession: SessionSummary;
  panelId: string;
  name: string;
  /** True once the panel has unmounted — checked after every await so a fork
   *  born after disposal is torn down instead of leaking a hidden run. */
  isDisposed: () => boolean;
  /** Fired as soon as creation returns so the host can hide this ephemeral child. */
  onForkCreated?: (session: SessionSummary) => void;
  /** Fired only after the main-process cleanup authority confirms deletion. */
  onForkCleanupSucceeded?: (sessionId: string) => void;
}

/** The latest successfully completed turn of the source session.
 *  Failed and aborted turns are not reference context: branching through one
 *  makes a fresh side prompt look like a continuation of unfinished parent
 *  work. If no completed turn exists, the side conversation starts empty. */
export function latestSettledTurnId(turns: readonly TurnRecord[]): string | undefined {
  return [...turns].reverse().find((turn) => turn.status === 'completed')?.turnId;
}

function companionCopyAttemptKey(
  sourceSessionId: string,
  panelId: string,
): SessionCopyAttemptKey {
  return { scope: `quote-companion:${panelId}`, kind: 'branch', sourceSessionId };
}

export async function abandonPendingCompanionCopy(
  api: CompanionSessionApi,
  sourceSessionId: string,
  panelId: string,
): Promise<boolean> {
  const key = companionCopyAttemptKey(sourceSessionId, panelId);
  const attempt = readSessionCopyAttempt(key);
  if (!attempt) return true;
  abandonSessionCopyAttempt(key, attempt.copyId);
  try {
    await api.abandonSessionCopy(sourceSessionId, attempt.copyId);
    completeSessionCopyAttempt(key, attempt.copyId);
    return true;
  } catch {
    return false;
  }
}

export async function recoverOrphanedCompanionCopies(
  api: CompanionSessionApi,
): Promise<void> {
  const attempts = listSessionCopyAttempts('quote-companion:');
  await Promise.all(
    attempts.map(async ({ key, attempt }) => {
      abandonSessionCopyAttempt(key, attempt.copyId);
      try {
        await api.abandonSessionCopy(key.sourceSessionId, attempt.copyId);
        completeSessionCopyAttempt(key, attempt.copyId);
      } catch {
        // Keep the abandoning lease so the next renderer reload retries cleanup.
      }
    }),
  );
}

export async function cleanupCompanionCopy(
  api: CompanionSessionApi,
  sourceSessionId: string,
  panelId: string,
  companionSessionId: string,
): Promise<boolean> {
  const key = companionCopyAttemptKey(sourceSessionId, panelId);
  const attempt = readSessionCopyAttempt(key);
  if (attempt) abandonSessionCopyAttempt(key, attempt.copyId);
  try {
    await api.cleanupSessionCopy(companionSessionId);
    if (attempt) completeSessionCopyAttempt(key, attempt.copyId);
    return true;
  } catch {
    return false;
  }
}

export async function dismissCompanionCopy(
  api: CompanionSessionApi,
  sourceSessionId: string,
  panelId: string,
  companionSessionId: string,
): Promise<boolean> {
  await api.stop(companionSessionId).catch(() => undefined);
  return cleanupCompanionCopy(api, sourceSessionId, panelId, companionSessionId);
}

/**
 * The shared Composer's `streaming` input means "a turn is interruptible", not
 * merely "a text delta has arrived". Keep the companion interruptible from the
 * optimistic waiting projection through live output; `processing` only chooses
 * the quieter pre-first-token presentation inside that same in-flight window.
 */
export function deriveCompanionComposerState(
  turnInFlight: boolean,
  liveTurn: LiveTurnProjection | undefined,
): { streaming: boolean; processing: boolean } {
  const streaming = turnInFlight && liveTurn?.terminal !== true;
  return {
    streaming,
    processing: streaming && (!liveTurn || liveTurn.phase === 'waiting'),
  };
}

/**
 * The main-process cleanup authority durably records the fork before attempting
 * the complete session-removal path. A rejection here means the intent remains
 * queued for the next `sessions.list` call or Desktop restart, so renderer
 * lifecycle paths can remain fire-and-forget without losing recovery.
 */
function scheduleCompanionCleanup(deps: EnsureCompanionForkDeps, sessionId: string): void {
  void cleanupCompanionCopy(
    deps.api,
    deps.sourceSession.id,
    deps.panelId,
    sessionId,
  ).then((cleaned) => {
    if (cleaned) deps.onForkCleanupSucceeded?.(sessionId);
  });
}

/**
 * Fork the main session for a companion while preserving the source session's
 * model, collaboration mode, and permission profile. Parent history is still
 * reference-only through the side-conversation system prompt; inherited
 * permission only governs actions explicitly requested inside the side chat.
 * Source-boundary and creation failures are returned as structured errors
 * instead of escaping as unhandled promise rejections. If the panel is disposed
 * mid-flight, any created fork is removed and `disposed` is returned.
 */
export async function ensureCompanionFork(
  deps: EnsureCompanionForkDeps,
): Promise<EnsureCompanionForkResult> {
  const { api, sourceSession, name, isDisposed } = deps;

  // Branch at the latest SETTLED turn (durable), not the last message that
  // happens to carry a turnId — so a fork never starts from a mid-flight turn.
  let turns: TurnRecord[];
  try {
    turns = await api.listTurns(sourceSession.id);
  } catch {
    return { status: 'error', code: 'fork_setup_failed' };
  }
  if (isDisposed()) return { status: 'disposed' };
  const boundaryTurnId = latestSettledTurnId(turns);
  if (!boundaryTurnId) return { status: 'error', code: 'fork_setup_failed' };

  let created: SessionSummary;
  try {
    let copyAttempt = acquireSessionCopyAttempt(
      companionCopyAttemptKey(sourceSession.id, deps.panelId),
      boundaryTurnId,
    );
    if (copyAttempt.phase === 'abandoning') {
      if (!(await abandonPendingCompanionCopy(api, sourceSession.id, deps.panelId))) {
        return { status: 'error', code: 'fork_setup_failed' };
      }
      copyAttempt = acquireSessionCopyAttempt(
        companionCopyAttemptKey(sourceSession.id, deps.panelId),
        boundaryTurnId,
      );
    }
    if (
      !startSessionCopyAttempt(
        companionCopyAttemptKey(sourceSession.id, deps.panelId),
        copyAttempt.copyId,
      )
    ) {
      return { status: 'error', code: 'fork_setup_failed' };
    }
    created = await api.branchFromTurn(sourceSession.id, {
      sourceTurnId: copyAttempt.sourceTurnId,
      name,
      copyId: copyAttempt.copyId,
      sideConversation: true,
    });
  } catch {
    return { status: 'error', code: 'fork_setup_failed' };
  }
  if (isDisposed()) {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'disposed' };
  }
  // `sessions:branchFromTurn` broadcasts `sessions:changed(created)` before the
  // promise resolves. Report the id at the first renderer-visible opportunity.
  deps.onForkCreated?.(created);

  if (isDisposed()) {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'disposed' };
  }

  return { status: 'ready', session: created };
}

export type CompanionTurnResult =
  | { status: 'sent'; forkId: string }
  | { status: 'disposed' }
  | { status: 'error'; code: CompanionErrorCode };

export interface PerformCompanionTurnDeps extends EnsureCompanionForkDeps {
  /** The fork's id if one already exists (subsequent turns skip creation). */
  existingForkId: string | null;
  turnId: string;
  text: string;
  quotes: QuoteRef[] | undefined;
  attachmentItems?: RendererIngestInput[];
  /** Fired once a fork is ready, so the caller can commit it. */
  onForkCommitted: (session: SessionSummary) => void;
  /** Fired right before the send — the caller arms the optimistic live turn here. */
  onBeforeSend: (forkId: string) => void;
  /** Fired ONLY after `send` is accepted, so a failed send keeps the staged
   *  quotes (and draft) in place for a retry. */
  onQuotesConsumed: () => void;
}

/**
 * Ensure a fork exists (fail-closed, dispose-aware) then send the turn. The
 * staged quotes are consumed only after `send` resolves, and the result tells
 * the caller whether the send was accepted (so a failure can leave the draft +
 * chips for retry).
 */
export async function performCompanionTurn(
  deps: PerformCompanionTurnDeps,
): Promise<CompanionTurnResult> {
  let forkId = deps.existingForkId;
  if (forkId === null) {
    const fork = await ensureCompanionFork(deps);
    if (fork.status !== 'ready') return fork;
    forkId = fork.session.id;
    deps.onForkCommitted(fork.session);
  }

  deps.onBeforeSend(forkId);
  let result: { ok: true } | { ok: false; reason?: string };
  try {
    result = await deps.api.send(forkId, {
      type: 'send',
      turnId: deps.turnId,
      text: deps.text,
      ...(deps.quotes ? { quotes: deps.quotes } : {}),
      ...(deps.attachmentItems ? { attachmentItems: deps.attachmentItems } : {}),
    });
  } catch {
    return { status: 'error', code: 'send_failed' };
  }
  // `send` can RESOLVE with `{ ok: false }` (e.g. an unresolved /skill:...) — no
  // run was started, so surface the error and keep the quotes for retry rather
  // than reporting success and hanging in the processing state.
  if (!result.ok) {
    return { status: 'error', code: 'send_rejected' };
  }
  deps.onQuotesConsumed();
  return { status: 'sent', forkId };
}

export function isCompanionTurnTerminal(event: SessionEvent): boolean {
  return event.type === 'error' || event.type === 'abort' || event.type === 'complete';
}

export type CompanionRunEventEffect =
  | { kind: 'ignore' }
  | {
      kind: 'active';
      terminal: boolean;
      /** Undefined keeps the existing error, null clears it. */
      error?: string | null;
    };

/**
 * Side-chat subscriptions can outlive a turn long enough to receive its final
 * event after the next turn starts. Only the currently armed turn may mutate
 * the live projection, error banner, or settlement state.
 */
export function companionRunEventEffect(
  event: SessionEvent,
  activeTurnId: string | null,
  stopRequested: boolean,
  locale: UiLocale,
): CompanionRunEventEffect {
  if (!event.turnId || event.turnId !== activeTurnId) return { kind: 'ignore' };

  if (event.type === 'error') {
    return {
      kind: 'active',
      terminal: true,
      error: stopRequested ? null : sessionEventErrorMessage(event, locale),
    };
  }
  if (
    event.type === 'abort' ||
    (event.type === 'complete' && event.stopReason === 'user_stop')
  ) {
    return { kind: 'active', terminal: true, error: null };
  }
  return {
    kind: 'active',
    terminal: isCompanionTurnTerminal(event),
  };
}

/**
 * Route a companion event into its interaction queue, mirroring the main shell:
 * boundary / question requests enqueue, their acks / tool results dequeue, and
 * a terminal event clears the queue.
 */
export function applyCompanionInteractionEvent(
  queues: InteractionQueues,
  sessionId: string,
  event: SessionEvent,
): InteractionQueues {
  switch (event.type) {
    case 'sandbox_boundary_request':
    case 'user_question_request':
      return enqueueInteraction(queues, sessionId, event);
    case 'sandbox_boundary_decision_ack':
      return dequeueInteractionByRequestId(queues, sessionId, event.requestId);
    case 'tool_result':
      return dequeueInteractionByToolUseId(queues, sessionId, event.toolUseId);
    default:
      return isCompanionTurnTerminal(event) ? clearInteractions(queues, sessionId) : queues;
  }
}
