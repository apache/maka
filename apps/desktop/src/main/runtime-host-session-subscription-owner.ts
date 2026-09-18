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
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
} from "@maka/runtime-host/client";
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
  /**
   * Installs a reseeded replica inside the owner's swap, synchronously and
   * before the evicted replica closes — same atomicity activate() gets.
   */
  installReseededReplica(replica: DesktopTranscriptReplica): void;
  acceptFrame(frame: SubscriptionFrame): void | Promise<void>;
  recoveryStarted(error: Error): void;
  recoveryCompleted(error: Error): void;
  recoveryFailed(initialError: Error, error: Error): void;
  terminalFailure(error: Error): void;
}

interface SubscriptionAttempt {
  readonly handle: DesktopRuntimeHostSession;
  preparationFailure?: {
    readonly promise: Promise<Error>;
    readonly resolve: (error: Error) => void;
  };
  replica?: DesktopTranscriptReplica;
  phase: 'preparing' | 'active';
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
  #started = false;
  #closed = false;
  #ptyInterests: readonly string[] = [];
  #ptyUpdate: Promise<void> = Promise.resolve();

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

  setPtyInterests(refs: readonly string[]): Promise<void> {
    if (refs.length === this.#ptyInterests.length && refs.every((ref, index) => ref === this.#ptyInterests[index])) return this.#ptyUpdate;
    this.#ptyInterests = [...refs];
    const update = this.#ptyUpdate.catch(() => undefined).then(async () => {
      await this.waitUntilReady();
      if (!this.#closed) await this.#attempt?.handle.setPtyInterests?.(this.#ptyInterests);
    });
    this.#ptyUpdate = update;
    return update;
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

  /**
   * Rebuilds the transcript tail on the live subscription after the replica
   * was evicted. The commit runs inside the staleness check — the caller's
   * state moves to the new replica before the evicted one closes, so an
   * installed replica is never a closed object. Answers the new replica only
   * when this call swapped it in; a concurrent recovery installs its own
   * replica through activation instead.
   */
  async reseedTranscriptReplica(): Promise<DesktopTranscriptReplica | undefined> {
    await this.waitUntilReady();
    if (this.#closed) return undefined;
    const attempt = this.#attempt;
    if (!attempt) return undefined;
    const evicted = attempt.replica;
    if (evicted?.resident) return undefined;
    let replica: DesktopTranscriptReplica;
    try {
      replica = await DesktopTranscriptReplica.reseed(
        attempt.handle,
        this.#deps.transcriptReplicaOptions,
      );
    } catch (error) {
      // A subscription-scoped read failure means this handle is dead; the
      // attempt decides whether that means recovery or terminal, exactly like
      // a pump-frame failure does. Generic read failures stay the caller's
      // transient error.
      if (
        error instanceof RuntimeHostSubscriptionError ||
        error instanceof RuntimeHostOperationError
      ) {
        this.#failAttempt(attempt, error);
        await this.waitUntilReady();
        return undefined;
      }
      throw error;
    }
    if (this.#closed || this.#attempt !== attempt || attempt.replica !== evicted) {
      replica.close();
      // The swap lost to an in-flight recovery or a concurrent reseed; wait
      // for it to settle so the caller picks up the installed replica rather
      // than erroring on the corpse it replaced.
      await this.waitUntilReady();
      return undefined;
    }
    try {
      this.#deps.installReseededReplica(replica);
    } catch (error) {
      replica.close();
      throw error;
    }
    attempt.replica = replica;
    evicted?.close();
    // Rows committed between the reseed's fetch and this commit are still
    // unread; the catch-up is an attempt read, so a dead handle takes the
    // same recovery path as a pump-frame rejection.
    void replica.advance().catch((error) => this.#failAttempt(attempt, error));
    return replica;
  }

  async #establish(failed?: SubscriptionAttempt, initialError?: Error): Promise<void> {
    let recoveryError = initialError;
    if (recoveryError) this.#deps.recoveryStarted(recoveryError);
    if (failed) {
      // Detach before the first await: a concurrent reseed must observe the
      // attempt as gone rather than swap a replica onto this corpse.
      if (this.#attempt === failed) this.#attempt = undefined;
      const candidate = this.#candidate;
      this.#candidate = undefined;
      candidate?.fail(ownerClosed());
      candidate?.replica?.close();
      await candidate?.handle.close().catch(() => undefined);
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
        attempt.phase = "active";
        attempt.preparationFailure = undefined;
        await attempt.handle.ready();
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

    const attempt: SubscriptionAttempt = {
      handle,
      preparationFailure: createPreparationFailure(),
      phase: "preparing",
      fail(error) {
        if (attempt.failure) return;
        attempt.failure = error;
        attempt.preparationFailure?.resolve(error);
      },
    };
    if (this.#candidate) {
      await handle.close().catch(() => undefined);
      throw new Error('Runtime Host Session replacement is already preparing');
    }
    this.#candidate = attempt;
    handle.subscribePtyData?.((frame) => {
      if (this.#closed || attempt.failure || (this.#candidate !== attempt && this.#attempt !== attempt)) return;
      void Promise.resolve(this.#deps.acceptFrame(frame)).catch(() => undefined);
    });
    void this.#pump(attempt);

    const replicaPreparation = DesktopTranscriptReplica.prepare(
      handle,
      this.#deps.transcriptReplicaOptions,
    );
    try {
      if (this.#ptyInterests.length > 0) await handle.setPtyInterests?.(this.#ptyInterests);
      const loaded = await Promise.race([
        replicaPreparation.then(
          (replica) => ({ kind: "replica" as const, replica }),
          (error: unknown) => ({ kind: "failure" as const, error: asError(error) }),
        ),
        attempt.preparationFailure!.promise.then((error) => ({ kind: "failure" as const, error })),
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
      attempt.preparationFailure!.promise.then((error) => ({ kind: 'failure' as const, error })),
    ]);
    if (result.kind === 'failure') throw result.error;
    return result.activate;
  }

  async #pump(attempt: SubscriptionAttempt): Promise<void> {
    try {
      for await (const frame of attempt.handle.events) {
        if (this.#closed || (this.#attempt !== attempt && this.#candidate !== attempt)) return;
        try {
          if (frame.kind === "subscription.closed") {
            throw subscriptionClosedError(frame.reason);
          }
          if (attempt.phase === 'preparing') {
            // The Host holds frames until `ready()`, so one arriving here is a
            // broken contract rather than a consumer falling behind.
            throw new Error('Runtime Host sent a Session frame before the subscriber was ready');
          }
          await this.#deps.acceptFrame(frame);
        } catch (error) {
          // Leaving the iterator awaits its return() — the subscription's
          // close handshake — so the failure has to be on its way to teardown
          // before this loop exits, not after.
          this.#failAttempt(attempt, error);
          return;
        }
      }
      if (!this.#closed) {
        throw new Error("Runtime Host Session subscription ended unexpectedly");
      }
    } catch (error) {
      this.#failAttempt(attempt, error);
    }
  }

  #failAttempt(attempt: SubscriptionAttempt, error: unknown): void {
    if (this.#closed || (this.#attempt !== attempt && this.#candidate !== attempt)) return;
    // A transcript read that raced the subscription's death only sees its
    // dead-state mask ('connection_closed'); the subscription itself knows
    // the real reason, and it is already recorded before the mask can fire.
    const failure = asError(
      attempt.handle.terminalError ??
        (attempt.handle.closedReason === undefined
          ? undefined
          : subscriptionClosedError(attempt.handle.closedReason)) ??
        error,
    );
    if (attempt.phase !== 'active') {
      attempt.fail(failure);
    } else if (isRecoverableSubscriptionFailure(failure)) {
      this.#replaceReadyTask(this.#establish(attempt, failure));
    } else {
      this.#deps.terminalFailure(failure);
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

function createPreparationFailure(): NonNullable<SubscriptionAttempt['preparationFailure']> {
  // Keep both roots together so activation can release the completed race results.
  // In particular, the attempt's fail method must not capture this resolver.
  let resolve!: (error: Error) => void;
  const promise = new Promise<Error>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function subscriptionClosedError(
  reason: "slow_consumer" | "session_removed" | 'access_revoked',
): Error {
  if (reason === 'session_removed') {
    return new SessionRemovedSubscriptionError(
      'Runtime Host Session was removed while it was observed',
    );
  }
  if (reason === 'access_revoked') {
    return new SessionRemovedSubscriptionError(
      'Access to the shared Runtime Host Session was revoked',
    );
  }
  return new RuntimeHostSubscriptionError(
    'slow_consumer',
    'Runtime Host Session subscription closed for a slow consumer',
  );
}

function isRecoverableSubscriptionFailure(error: unknown): boolean {
  if (error instanceof RuntimeHostOperationError) {
    return error.operation === 'session.transcript.page' && error.code === 'not_found';
  }
  if (!(error instanceof RuntimeHostSubscriptionError)) return false;
  return (
    error.reason === 'slow_consumer' ||
    error.reason === 'sequence_gap' ||
    error.reason === 'projection_revision_invalid'
  );
}

function ownerClosed(): Error {
  return new Error("Runtime Host Session observer closed while opening");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
