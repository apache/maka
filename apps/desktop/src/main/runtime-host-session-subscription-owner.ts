import type { StoredMessage } from '@maka/core/session';
import { RuntimeHostSessionProjector } from "@maka/runtime-host/adapter";
import { RuntimeHostSubscriptionError } from "@maka/runtime-host/client";
import type {
  SessionAssistantStreamIdentity,
  SessionContinuitySnapshot,
  SubscriptionFrame,
} from "@maka/runtime-host/protocol";
import type {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostSession,
} from "./runtime-host-client.js";

const MAX_PENDING_FRAMES = 512;

type SessionSubscriptionClient = Pick<DesktopRuntimeHostClient, "openSession">;

export interface PreparedSessionSubscription {
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly transcript: StoredMessage[];
}

export interface RuntimeHostSessionSubscriptionOwnerDeps {
  readonly client: SessionSubscriptionClient;
  readonly sessionId: string;
  readonly now: () => number;
  commit(subscription: PreparedSessionSubscription, recovered: boolean): void;
  acceptFrame(frame: SubscriptionFrame): void;
  recoveryStarted(error: Error): void;
  recoveryCompleted(error: Error): void;
  recoveryFailed(initialError: Error, error: Error): void;
  terminalFailure(error: Error): void;
}

interface SubscriptionAttempt {
  readonly handle: DesktopRuntimeHostSession;
  readonly pendingFrames: SubscriptionFrame[];
  readonly failed: Promise<Error>;
  phase: "preparing" | "active";
  failure?: Error;
  fail(error: Error): void;
}

export class SessionRemovedSubscriptionError extends Error {
  readonly name = "SessionRemovedSubscriptionError";
}

/** Owns exactly one replaceable Host subscription for one Desktop Session. */
export class RuntimeHostSessionSubscriptionOwner {
  readonly #deps: RuntimeHostSessionSubscriptionOwnerDeps;
  #attempt?: SubscriptionAttempt;
  #readyTask: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;

  constructor(deps: RuntimeHostSessionSubscriptionOwnerDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#replaceReadyTask(this.#establish());
  }

  async waitUntilReady(): Promise<void> {
    while (true) {
      const task = this.#readyTask;
      await task;
      if (task === this.#readyTask) return;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const attempt = this.#attempt;
    this.#attempt = undefined;
    attempt?.fail(ownerClosed());
    await attempt?.handle.close().catch(() => undefined);
  }

  async #establish(failed?: SubscriptionAttempt, initialError?: Error): Promise<void> {
    let recoveryError = initialError;
    if (recoveryError) this.#deps.recoveryStarted(recoveryError);
    if (failed) await failed.handle.close().catch(() => undefined);

    while (true) {
      this.#assertOpen();
      let prepared: PreparedSessionSubscription;
      let attempt: SubscriptionAttempt;
      try {
        ({ attempt, prepared } = await this.#prepare());
      } catch (error) {
        const failure = asError(error);
        if (isRecoverableSubscriptionFailure(failure)) {
          if (!recoveryError) {
            recoveryError = failure;
            this.#deps.recoveryStarted(failure);
          }
          continue;
        }
        if (recoveryError) this.#deps.recoveryFailed(recoveryError, failure);
        throw failure;
      }

      try {
        if (attempt.failure) throw attempt.failure;
        this.#deps.commit(prepared, recoveryError !== undefined);
        if (attempt.failure) throw attempt.failure;
        attempt.phase = "active";
        for (const frame of attempt.pendingFrames.splice(0)) {
          this.#deps.acceptFrame(frame);
        }
      } catch (error) {
        if (this.#attempt === attempt) this.#attempt = undefined;
        await attempt.handle.close().catch(() => undefined);
        const failure = asError(error);
        if (isRecoverableSubscriptionFailure(failure)) {
          if (!recoveryError) {
            recoveryError = failure;
            this.#deps.recoveryStarted(failure);
          }
          continue;
        }
        if (recoveryError) this.#deps.recoveryFailed(recoveryError, failure);
        throw failure;
      }

      if (recoveryError) this.#deps.recoveryCompleted(recoveryError);
      return;
    }
  }

  async #prepare(): Promise<{
    attempt: SubscriptionAttempt;
    prepared: PreparedSessionSubscription;
  }> {
    const handle = await this.#deps.client.openSession(this.#deps.sessionId);
    if (this.#closed) {
      await handle.close().catch(() => undefined);
      throw ownerClosed();
    }

    let fail!: (error: Error) => void;
    const failed = new Promise<Error>((resolve) => {
      fail = resolve;
    });
    const attempt: SubscriptionAttempt = {
      handle,
      pendingFrames: [],
      failed,
      phase: "preparing",
      fail(error) {
        if (attempt.failure) return;
        attempt.failure = error;
        fail(error);
      },
    };
    this.#attempt = attempt;
    void this.#pump(attempt);

    try {
      const loaded = await Promise.race([
        handle.transcript.then(
          (transcript) => ({ kind: "transcript" as const, transcript }),
          (error: unknown) => ({ kind: "failure" as const, error: asError(error) }),
        ),
        failed.then((error) => ({ kind: "failure" as const, error })),
      ]);
      if (loaded.kind === "failure") throw loaded.error;
      if (attempt.failure) throw attempt.failure;
      if (this.#closed || this.#attempt !== attempt) throw ownerClosed();
      validatePendingFrames(
        handle.snapshot,
        handle.activeAssistantStreams,
        loaded.transcript,
        attempt.pendingFrames,
        this.#deps.now,
      );
      return {
        attempt,
        prepared: {
          snapshot: structuredClone(handle.snapshot),
          activeAssistantStreams: structuredClone(handle.activeAssistantStreams),
          transcript: loaded.transcript,
        },
      };
    } catch (error) {
      if (this.#attempt === attempt) this.#attempt = undefined;
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #pump(attempt: SubscriptionAttempt): Promise<void> {
    try {
      for await (const frame of attempt.handle.events) {
        if (this.#closed || this.#attempt !== attempt) return;
        if (frame.kind === "subscription.closed") {
          throw subscriptionClosedError(frame.reason);
        }
        if (attempt.phase === "preparing") {
          if (attempt.pendingFrames.length >= MAX_PENDING_FRAMES) {
            throw new RuntimeHostSubscriptionError(
              "slow_consumer",
              "Runtime Host Session transcript could not keep up with live events",
            );
          }
          attempt.pendingFrames.push(frame);
        } else {
          this.#deps.acceptFrame(frame);
        }
      }
      if (!this.#closed) {
        throw new Error("Runtime Host Session subscription ended unexpectedly");
      }
    } catch (error) {
      if (this.#closed || this.#attempt !== attempt) return;
      const failure = asError(error);
      if (attempt.phase === "preparing") {
        attempt.fail(failure);
      } else if (isRecoverableSubscriptionFailure(failure)) {
        this.#replaceReadyTask(this.#establish(attempt, failure));
      } else {
        this.#deps.terminalFailure(failure);
      }
    }
  }

  #replaceReadyTask(task: Promise<void>): void {
    this.#readyTask = task;
    void task.catch((error: unknown) => {
      if (this.#closed || this.#readyTask !== task) return;
      this.#deps.terminalFailure(asError(error));
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw ownerClosed();
  }
}

function validatePendingFrames(
  snapshot: SessionContinuitySnapshot,
  activeAssistantStreams: readonly SessionAssistantStreamIdentity[],
  transcript: readonly StoredMessage[],
  frames: readonly SubscriptionFrame[],
  now: () => number,
): void {
  const projector = new RuntimeHostSessionProjector(
    snapshot,
    transcript,
    now,
    activeAssistantStreams,
  );
  for (const frame of frames) projector.accept(frame);
}

function subscriptionClosedError(
  reason: "slow_consumer" | "session_removed",
): Error {
  return reason === "session_removed"
    ? new SessionRemovedSubscriptionError(
        "Runtime Host Session was removed while it was observed",
      )
    : new RuntimeHostSubscriptionError(
        "slow_consumer",
        "Runtime Host Session subscription closed for a slow consumer",
      );
}

function isRecoverableSubscriptionFailure(error: unknown): boolean {
  if (!(error instanceof RuntimeHostSubscriptionError)) return false;
  return (
    error.reason === "slow_consumer" ||
    error.reason === "sequence_gap" ||
    error.reason === "projection_revision_invalid" ||
    error.reason === "transcript_release_failed"
  );
}

function ownerClosed(): Error {
  return new Error("Runtime Host Session observer closed while opening");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
