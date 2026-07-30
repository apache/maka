import {
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  type InteractionQueues,
  type LiveTurnProjection,
} from '@maka/ui';
import type {
  CreateSessionInput,
  PermissionMode,
  QuoteRef,
  SessionEvent,
  SessionSummary,
  StoredMessage,
  TurnRecord,
} from '@maka/core';

/** The companion is a read-only explanation surface: reads + local search are
 *  available and web/custom tools follow the normal permission path, while
 *  writes / shell / destructive operations are hard-blocked (not approvable). */
export const COMPANION_PERMISSION_MODE: PermissionMode = 'explore';

/** `sessions.send` resolves (does not throw) with this shape when the run was
 *  not actually started — e.g. an unresolved `/skill:...` invocation. */
type CompanionSendResult = { ok: true } | { ok: false; reason?: string };

/**
 * The subset of the sessions bridge the quote companion drives. Extracted so the
 * fork-creation / guard / send orchestration can be unit-tested with a fake in
 * place of `window.maka.sessions` (the React hook stays a thin shell).
 */
export interface CompanionSessionApi {
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  branchFromTurn(sessionId: string, input: { sourceTurnId: string; name?: string }): Promise<SessionSummary>;
  create(input: Partial<CreateSessionInput>): Promise<SessionSummary>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
  cleanupQuoteCompanion(sessionId: string): Promise<void>;
  send(
    sessionId: string,
    command: { type: 'send'; turnId: string; text: string; quotes?: QuoteRef[] },
  ): Promise<CompanionSendResult>;
}

/** Structured failure reasons the renderer localizes (no user-facing strings in
 *  core). `fork_setup_failed`: reading the source boundary or creating the fork
 *  failed; `permission_pin_failed`: the fork couldn't be confirmed read-only;
 *  `send_failed`: `sessions.send` threw; `send_rejected`: it resolved `{ok:false}`. */
export type CompanionErrorCode =
  | 'fork_setup_failed'
  | 'permission_pin_failed'
  | 'send_failed'
  | 'send_rejected';

export type EnsureCompanionForkResult =
  | { status: 'ready'; session: SessionSummary }
  | { status: 'disposed' }
  | { status: 'error'; code: CompanionErrorCode };

export interface EnsureCompanionForkDeps {
  api: CompanionSessionApi;
  sourceSession: SessionSummary;
  name: string;
  /** True once the panel has unmounted — checked after every await so a fork
   *  born after disposal is torn down instead of leaking a hidden run. */
  isDisposed: () => boolean;
  /** Fired as soon as creation returns, before the permission pin round-trip.
   *  The host uses the id to hide this ephemeral child immediately. */
  onForkCreated?: (session: SessionSummary) => void;
  /** Fired only after the main-process cleanup authority confirms deletion. */
  onForkCleanupSucceeded?: (sessionId: string) => void;
}

/** The latest durable (settled) turn of the source session — the fork boundary.
 *  A `running` turn is skipped so a fork never branches mid-turn. */
export function latestSettledTurnId(turns: readonly TurnRecord[]): string | undefined {
  return [...turns].reverse().find((turn) => turn.status !== 'running')?.turnId;
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
  void deps.api
    .cleanupQuoteCompanion(sessionId)
    .then(() => deps.onForkCleanupSucceeded?.(sessionId))
    .catch(() => {});
}

/**
 * Fork the main session for a companion and return a session that is CONFIRMED
 * read-only (`explore`): reads + local search stay available and web/custom
 * tools follow the normal permission path, but writes / shell / destructive
 * operations are hard-blocked. Fails closed: if `setPermissionMode` throws or
 * the session is not `explore`, the fork is removed and an error is returned —
 * never leaving a fork that could run with the parent's inherited execute/bypass
 * permissions. Source-boundary and creation failures are returned as structured
 * errors instead of escaping as unhandled promise rejections. If the panel is
 * disposed mid-flight, any created fork is removed and `disposed` is returned so
 * the caller aborts. The fork inherits the source model/connection (no
 * independent model picker).
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

  let created: SessionSummary;
  try {
    created = boundaryTurnId
      ? await api.branchFromTurn(sourceSession.id, { sourceTurnId: boundaryTurnId, name })
      : await api.create({
          ...(sourceSession.cwd ? { cwd: sourceSession.cwd } : {}),
          backend: sourceSession.backend,
          llmConnectionSlug: sourceSession.llmConnectionSlug,
          model: sourceSession.model,
          parentSessionId: sourceSession.id,
          name,
        });
  } catch {
    return { status: 'error', code: 'fork_setup_failed' };
  }

  if (isDisposed()) {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'disposed' };
  }
  // `sessions:branchFromTurn` broadcasts `sessions:changed(created)` before the
  // promise resolves. Report the id at the first renderer-visible opportunity,
  // rather than waiting on the potentially slow permission pin below.
  deps.onForkCreated?.(created);

  // Fail CLOSED on the read-only guardrail: the fork inherits the parent's
  // permission mode, so it MUST be confirmed `explore` before it is ever used.
  let ready: SessionSummary;
  try {
    ready = await api.setPermissionMode(created.id, COMPANION_PERMISSION_MODE);
  } catch {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'error', code: 'permission_pin_failed' };
  }
  if (ready.permissionMode !== COMPANION_PERMISSION_MODE) {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'error', code: 'permission_pin_failed' };
  }
  if (isDisposed()) {
    scheduleCompanionCleanup(deps, created.id);
    return { status: 'disposed' };
  }

  return { status: 'ready', session: ready };
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
  /** Fired once a fork is created + confirmed read-only, so the caller can commit it. */
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
