import { failureClassFromCompleteStopReason, type SessionEvent } from '@maka/core/events';

export type GoalTurnOutcome =
  | { kind: 'completed'; turnId: string }
  | { kind: 'suspended'; turnId?: string; reason: string }
  | { kind: 'aborted'; turnId?: string }
  | { kind: 'errored'; turnId?: string; reason: string };

export interface SessionActivityLease {
  release: () => void;
}

interface SessionActivityState {
  count: number;
  whenIdle: Promise<void>;
  resolveIdle: () => void;
}

/** Tracks host work without imposing serialization on callers that use reserve(). */
export class SessionActivityRegistry {
  private readonly states = new Map<string, SessionActivityState>();

  /** Returns the current shared idle signal, or undefined when already idle. */
  whenIdle(sessionId: string): Promise<void> | undefined {
    return this.states.get(sessionId)?.whenIdle;
  }

  /** Whether any host-owned session work is currently active. */
  hasActive(): boolean {
    return this.states.size > 0;
  }

  reserve(sessionId: string): SessionActivityLease {
    let state = this.states.get(sessionId);
    if (!state) {
      let resolveIdle!: () => void;
      const whenIdle = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
      state = { count: 0, whenIdle, resolveIdle };
      this.states.set(sessionId, state);
    }
    state.count++;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.count--;
        if (state.count > 0) return;
        this.states.delete(sessionId);
        state.resolveIdle();
      },
    };
  }

  /** Atomically reserves an idle session; Goal admission uses this synchronous seam. */
  reserveIfIdle(sessionId: string): SessionActivityLease | undefined {
    if (this.states.has(sessionId)) return undefined;
    return this.reserve(sessionId);
  }

  /** Waits until the session is idle, then atomically owns the next activity slot. */
  async acquire(sessionId: string, abortSignal?: AbortSignal): Promise<SessionActivityLease> {
    for (;;) {
      throwIfAborted(abortSignal);
      const lease = this.reserveIfIdle(sessionId);
      if (lease) return lease;
      await waitForIdleOrAbort(this.whenIdle(sessionId)!, abortSignal);
    }
  }
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) return;
  throw new DOMException('Session activity acquisition was aborted', 'AbortError');
}

async function waitForIdleOrAbort(
  whenIdle: Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) return whenIdle;
  throwIfAborted(abortSignal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Session activity acquisition was aborted', 'AbortError'));
    };
    const cleanup = () => abortSignal.removeEventListener('abort', onAbort);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    void whenIdle.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export interface DrainGoalTurnInput {
  events: AsyncIterable<SessionEvent>;
  /** Canonical identity assigned by the caller before the stream starts. */
  turnId: string;
  activity?: SessionActivityLease;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  onStreamError?: (error: unknown) => void | Promise<void>;
  /** Runs after complete drain/error projection, while the activity lease is held. */
  onDrained?: (outcome: GoalTurnOutcome) => void | Promise<void>;
  /** Runs after the activity lease is released. */
  onSettled?: (outcome: GoalTurnOutcome) => void;
}

export async function drainGoalTurn(input: DrainGoalTurnInput): Promise<GoalTurnOutcome> {
  let observedOutcome: GoalTurnOutcome | undefined;
  let streamError: unknown;
  let streamFailed = false;
  const captureStreamError = (error: unknown): void => {
    if (streamFailed) return;
    streamFailed = true;
    streamError = error;
  };
  try {
    for await (const event of input.events) {
      observedOutcome = observeGoalTurnOutcome(observedOutcome, event);
      try {
        await input.onEvent?.(event);
      } catch (observerError) {
        // Projection is not the stream owner. Preserve the failure, but keep
        // consuming so activity is released only after the runtime turn drains.
        captureStreamError(observerError);
      }
    }
  } catch (error) {
    captureStreamError(error);
  }

  if (streamFailed) {
    observedOutcome = failedOutcome(streamError, input.turnId);
    try {
      await input.onStreamError?.(streamError);
    } catch (observerError) {
      observedOutcome = failedOutcome(observerError, input.turnId);
    }
  }

  let outcome: GoalTurnOutcome =
    observedOutcome ??
    failedOutcome(new Error('Session turn ended without a completion event'), input.turnId);
  outcome = { ...outcome, turnId: input.turnId };
  try {
    await input.onDrained?.(outcome);
  } catch (observerError) {
    outcome = failedOutcome(observerError, input.turnId);
  } finally {
    input.activity?.release();
  }
  input.onSettled?.(outcome);
  return outcome;
}

function observeGoalTurnOutcome(
  current: GoalTurnOutcome | undefined,
  event: SessionEvent,
): GoalTurnOutcome | undefined {
  if (current && current.kind !== 'suspended') return current;
  const failureClass =
    event.type === 'complete' ? failureClassFromCompleteStopReason(event.stopReason) : undefined;
  if (event.type === 'error' || failureClass !== undefined) {
    return {
      kind: 'errored',
      turnId: event.turnId,
      reason: event.type === 'error' ? event.message : `Turn ended with ${failureClass}`,
    };
  }
  if (event.type === 'abort' || (event.type === 'complete' && event.stopReason === 'user_stop')) {
    return { kind: 'aborted', turnId: event.turnId };
  }
  if (event.type !== 'complete') return current;
  return { kind: 'completed', turnId: event.turnId };
}

function failedOutcome(error: unknown, turnId: string): GoalTurnOutcome {
  return { kind: 'errored', turnId, reason: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
