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
  prepareActivation(
    subscription: PreparedSessionSubscription,
    recovered: boolean,
  ): Promise<() => void>;
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
  phase: 'preparing' | 'active' | 'retiring';
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
  #candidate?: SubscriptionAttempt;
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
    const candidate = this.#candidate;
    this.#attempt = undefined;
    this.#candidate = undefined;
    attempt?.fail(ownerClosed());
    candidate?.fail(ownerClosed());
    attempt?.replica?.close();
    candidate?.replica?.close();
    await Promise.all([
      attempt?.handle.close().catch(() => undefined),
      candidate?.handle.close().catch(() => undefined),
    ]);
  }

  async #refresh(): Promise<void> {
    await this.waitUntilReady();
    this.#assertOpen();
    const readyTask = this.#readyTask;
    const previous = this.#attempt;
    if (!previous) throw ownerClosed();
    let attempt: SubscriptionAttempt | undefined;
    try {
      const prepared = await this.#prepare();
      attempt = prepared.attempt;
      if (attempt.failure) throw attempt.failure;
      previous.phase = 'retiring';
      const activate = await this.#prepareActivation(attempt, prepared.prepared, false);
      if (attempt.failure) throw attempt.failure;
      if (this.#closed || this.#candidate !== attempt || this.#attempt !== previous) {
        throw ownerClosed();
      }
      activate();
      this.#candidate = undefined;
      this.#attempt = attempt;
      previous.replica?.close();
      await previous.handle.close().catch(() => undefined);
      await this.#drainPendingFrames(attempt);
      attempt.phase = 'active';
    } catch (error) {
      const failure = asError(error);
      if (attempt && this.#attempt === attempt) {
        this.#replaceReadyTask(this.#establish(attempt, failure));
        await this.waitUntilReady();
        return;
      }
      if (attempt && this.#candidate === attempt) this.#candidate = undefined;
      attempt?.replica?.close();
      await attempt?.handle.close().catch(() => undefined);
      if (this.#attempt === previous && previous.phase === 'retiring') {
        if (previous.failure) {
          this.#replaceReadyTask(this.#establish(previous, previous.failure));
          await this.waitUntilReady();
          return;
        }
        previous.phase = 'active';
        try {
          await this.#drainPendingFrames(previous);
        } catch (error) {
          const recoveryError = asError(error);
          this.#replaceReadyTask(this.#establish(previous, recoveryError));
          await this.waitUntilReady();
          return;
        }
      }
      if (this.#readyTask !== readyTask) {
        await this.waitUntilReady();
        if (this.#attempt?.replica?.resident) return;
      }
      throw failure;
    }
  }

  async #establish(failed?: SubscriptionAttempt, initialError?: Error): Promise<void> {
    let recoveryError = initialError;
    if (recoveryError) this.#deps.recoveryStarted(recoveryError);
    if (failed) {
      const candidate = this.#candidate;
      this.#candidate = undefined;
      candidate?.fail(ownerClosed());
      candidate?.replica?.close();
      await candidate?.handle.close().catch(() => undefined);
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
        const activate = await this.#prepareActivation(
          attempt,
          prepared,
          recoveryError !== undefined,
        );
        if (attempt.failure) throw attempt.failure;
        if (this.#closed || this.#candidate !== attempt) throw ownerClosed();
        activate();
        this.#candidate = undefined;
        this.#attempt = attempt;
        await this.#drainPendingFrames(attempt);
        attempt.phase = "active";
      } catch (error) {
        if (this.#candidate === attempt) this.#candidate = undefined;
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
    if (this.#candidate) {
      await handle.close().catch(() => undefined);
      throw new Error('Runtime Host Session replacement is already preparing');
    }
    this.#candidate = attempt;
    void this.#pump(attempt);

    const replicaPreparation = DesktopTranscriptReplica.prepare(
      handle,
      this.#deps.transcriptReplicaOptions,
    );
    try {
      const loaded = await Promise.race([
        replicaPreparation.then(
          (replica) => ({ kind: "replica" as const, replica }),
          (error: unknown) => ({ kind: "failure" as const, error: asError(error) }),
        ),
        failed.then((error) => ({ kind: "failure" as const, error })),
      ]);
      if (loaded.kind === "failure") throw loaded.error;
      attempt.replica = loaded.replica;
      if (attempt.failure) throw attempt.failure;
      if (this.#closed || this.#candidate !== attempt) throw ownerClosed();
      return {
        attempt,
        prepared: {
          snapshot: structuredClone(handle.snapshot),
          activeAssistantStreams: structuredClone(handle.activeAssistantStreams),
          replica: loaded.replica,
        },
      };
    } catch (error) {
      if (this.#candidate === attempt) this.#candidate = undefined;
      if (attempt.replica) attempt.replica.close();
      else void replicaPreparation.then((replica) => replica.close(), () => undefined);
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #prepareActivation(
    attempt: SubscriptionAttempt,
    subscription: PreparedSessionSubscription,
    recovered: boolean,
  ): Promise<() => void> {
    const result = await Promise.race([
      this.#deps.prepareActivation(subscription, recovered).then(
        (activate) => ({ kind: 'ready' as const, activate }),
        (error: unknown) => ({ kind: 'failure' as const, error: asError(error) }),
      ),
      attempt.failed.then((error) => ({ kind: 'failure' as const, error })),
    ]);
    if (result.kind === 'failure') throw result.error;
    return result.activate;
  }

  async #pump(attempt: SubscriptionAttempt): Promise<void> {
    try {
      for await (const frame of attempt.handle.events) {
        if (this.#closed || (this.#attempt !== attempt && this.#candidate !== attempt)) return;
        if (frame.kind === "subscription.closed") {
          throw subscriptionClosedError(frame.reason);
        }
        if (attempt.phase !== 'active') {
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
      if (this.#closed || (this.#attempt !== attempt && this.#candidate !== attempt)) return;
      const failure = asError(error);
      if (attempt.phase !== 'active') {
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

  async #drainPendingFrames(attempt: SubscriptionAttempt): Promise<void> {
    while (attempt.pendingFrames.length > 0) {
      const frame = attempt.pendingFrames.shift()!;
      attempt.pendingFrameBytes -= Buffer.byteLength(JSON.stringify(frame), 'utf8');
      await this.#deps.acceptFrame(frame);
      if (attempt.failure) throw attempt.failure;
    }
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
