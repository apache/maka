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
import {
  DesktopTranscriptReplica,
  type DesktopTranscriptReplicaOptions,
} from './desktop-transcript-replica.js';

const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_FRAME_BYTES = 256 * 1024;

type SessionSubscriptionClient = Pick<DesktopRuntimeHostClient, "openSession">;

export interface PreparedSessionSubscription {
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams: readonly SessionAssistantStreamIdentity[];
  readonly replica: DesktopTranscriptReplica;
}

export interface RuntimeHostSessionSubscriptionOwnerDeps {
  readonly client: SessionSubscriptionClient;
  readonly sessionId: string;
  readonly now: () => number;
  readonly transcriptReplicaOptions?: DesktopTranscriptReplicaOptions;
  commit(subscription: PreparedSessionSubscription, recovered: boolean): void | Promise<void>;
  acceptFrame(frame: SubscriptionFrame): void | Promise<void>;
  recoveryStarted(error: Error): void;
  recoveryCompleted(error: Error): void;
  recoveryFailed(initialError: Error, error: Error): void;
  terminalFailure(error: Error): void;
}

interface SubscriptionAttempt {
  readonly handle: DesktopRuntimeHostSession;
  readonly pendingFrames: SubscriptionFrame[];
  readonly failed: Promise<Error>;
  pendingFrameBytes: number;
  replica?: DesktopTranscriptReplica;
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
  #refreshTask?: Promise<void>;
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

  refresh(): Promise<void> {
    if (this.#refreshTask) return this.#refreshTask;
    const task = this.#refresh();
    const tracked = task.finally(() => {
      if (this.#refreshTask === tracked) this.#refreshTask = undefined;
    });
    this.#refreshTask = tracked;
    return tracked;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const attempt = this.#attempt;
    this.#attempt = undefined;
    attempt?.fail(ownerClosed());
    attempt?.replica?.close();
    await attempt?.handle.close().catch(() => undefined);
  }

  async #refresh(): Promise<void> {
    await this.waitUntilReady();
    this.#assertOpen();
    const attempt = this.#attempt;
    if (!attempt) throw ownerClosed();
    const task = this.#establish(attempt);
    this.#replaceReadyTask(task);
    await this.waitUntilReady();
  }

  async #establish(failed?: SubscriptionAttempt, initialError?: Error): Promise<void> {
    let recoveryError = initialError;
    if (recoveryError) this.#deps.recoveryStarted(recoveryError);
    if (failed) {
      if (this.#attempt === failed) this.#attempt = undefined;
      failed.replica?.close();
      await failed.handle.close().catch(() => undefined);
    }

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
        await this.#deps.commit(prepared, recoveryError !== undefined);
        if (attempt.failure) throw attempt.failure;
        while (attempt.pendingFrames.length > 0) {
          const frame = attempt.pendingFrames.shift()!;
          attempt.pendingFrameBytes -= Buffer.byteLength(JSON.stringify(frame), 'utf8');
          await this.#deps.acceptFrame(frame);
          if (attempt.failure) throw attempt.failure;
        }
        attempt.phase = "active";
      } catch (error) {
        if (this.#attempt === attempt) this.#attempt = undefined;
        attempt.replica?.close();
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
      pendingFrameBytes: 0,
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
        DesktopTranscriptReplica.prepare(handle, this.#deps.transcriptReplicaOptions).then(
          (replica) => ({ kind: "replica" as const, replica }),
          (error: unknown) => ({ kind: "failure" as const, error: asError(error) }),
        ),
        failed.then((error) => ({ kind: "failure" as const, error })),
      ]);
      if (loaded.kind === "failure") throw loaded.error;
      attempt.replica = loaded.replica;
      if (attempt.failure) throw attempt.failure;
      if (this.#closed || this.#attempt !== attempt) throw ownerClosed();
      return {
        attempt,
        prepared: {
          snapshot: structuredClone(handle.snapshot),
          activeAssistantStreams: structuredClone(handle.activeAssistantStreams),
          replica: loaded.replica,
        },
      };
    } catch (error) {
      if (this.#attempt === attempt) this.#attempt = undefined;
      attempt.replica?.close();
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
        if (attempt.phase === 'preparing') {
          const frameBytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
          if (
            attempt.pendingFrames.length >= MAX_PENDING_FRAMES ||
            attempt.pendingFrameBytes + frameBytes > MAX_PENDING_FRAME_BYTES
          ) {
            throw new RuntimeHostSubscriptionError(
              'slow_consumer',
              'Runtime Host Session transcript could not keep up with live events',
            );
          }
          attempt.pendingFrames.push(frame);
          attempt.pendingFrameBytes += frameBytes;
        } else {
          await this.#deps.acceptFrame(frame);
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
