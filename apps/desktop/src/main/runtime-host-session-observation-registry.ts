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

import { RuntimeHostOperationError } from "@maka/runtime-host/client";
import type {
  RuntimeHostSessionObserver,
  RuntimeHostRendererTarget,
  RuntimeHostSessionObserverTarget,
  RuntimeHostTranscriptTarget,
} from "./runtime-host-session-observer.js";
import type {
  DesktopTranscriptOpenResult,
  DesktopTranscriptRangeRequest,
} from '../preload/transcript-contract.js';

type SessionObservationSource = Pick<RuntimeHostSessionObserver, 'observe' | 'unobserve'> &
  Partial<
    Pick<
      RuntimeHostSessionObserver,
      | 'acknowledgeTranscript'
      | 'closeTranscript'
      | 'loadTranscriptAround'
      | 'loadTranscriptBefore'
      | 'openTranscript'
    >
  >;

type TranscriptSource = Required<
  Pick<
    RuntimeHostSessionObserver,
    | 'closeTranscript'
    | 'loadTranscriptAround'
    | 'loadTranscriptBefore'
    | 'openTranscript'
  >
>;

type ObservationTargetBinding = <Payload>(
  target: RuntimeHostRendererTarget<Payload>,
) => RuntimeHostRendererTarget<Payload>;

interface ObservationReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function requireTranscriptSource(
  source: SessionObservationSource | undefined,
): SessionObservationSource & TranscriptSource {
  if (
    !source?.openTranscript ||
    !source.loadTranscriptBefore ||
    !source.loadTranscriptAround ||
    !source.closeTranscript
  ) {
    throw new Error('Runtime Host transcript source is unavailable');
  }
  return source as SessionObservationSource & TranscriptSource;
}

/**
 * A `subscription.open`/`not_found` answer is deterministic: the Host no
 * longer serves this Session (Host restart with ephemeral state, Session GC,
 * or deletion by another client). Unlike `session.transcript.page`/`not_found`
 * (see `isRecoverableSubscriptionFailure` in the subscription owner), there is
 * nothing to retry — the registration must be forgotten instead of blocking
 * every reconnect.
 */
function isMissingRuntimeHostSessionError(error: unknown): boolean {
  if (!(error instanceof RuntimeHostOperationError)) return false;
  if (error.operation !== "subscription.open") return false;
  return error.code === "not_found";
}

interface SessionObservationRegistration {
  readonly sessionId: string;
  readonly messageAdmissions: boolean;
  readonly target: RuntimeHostSessionObserverTarget;
  readonly destroyedListener: () => void;
  readonly ready: ObservationReadiness;
  lifecycle: "pending" | "active";
}

interface TranscriptRegistration {
  readonly sessionId: string;
  readonly target: RuntimeHostTranscriptTarget;
  readonly destroyedListener: () => void;
  readonly ready: TranscriptReadiness;
  restore: ObservationReadiness | undefined;
  lifecycle: 'pending' | 'active';
}

interface TranscriptReadiness {
  readonly promise: Promise<DesktopTranscriptOpenResult>;
  resolve(result: DesktopTranscriptOpenResult): void;
  reject(error: Error): void;
}

function observationReadiness(): ObservationReadiness {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transcriptReadiness(): TranscriptReadiness {
  let resolve!: (result: DesktopTranscriptOpenResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DesktopTranscriptOpenResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Keeps renderer observation intent alive while the Host connection is replaced.
 */
export class RuntimeHostSessionObservationRegistry {
  readonly #registrations = new Map<
    string,
    SessionObservationRegistration
  >();
  readonly #transcripts = new Map<string, TranscriptRegistration>();
  readonly #onError: (error: unknown) => void;
  #source: SessionObservationSource | undefined;
  #bindTarget: ObservationTargetBinding = (target) => target;
  #closed = false;

  constructor(onError: (error: unknown) => void = () => undefined) {
    this.#onError = onError;
  }

  async attach(
    source: SessionObservationSource,
    bindTarget: ObservationTargetBinding = (target) => target,
    onSessionMissing?: (sessionId: string) => void,
  ): Promise<string[]> {
    this.#assertOpen();
    if (this.#source && this.#source !== source) {
      throw new Error("Runtime Host Session observations are already attached");
    }
    this.#source = source;
    this.#bindTarget = bindTarget;
    // Transcript replay is a recoverable renderer read replica, not part of
    // the Runtime Host availability boundary. Start it alongside Session
    // observation seeding, but do not keep the whole Host in `reconnecting`
    // while a large transcript is replayed and acknowledged. The existing
    // consumer remains registered and receives its replacement generation as
    // soon as replay completes.
    this.#restoreTranscripts(source);
    const restored = await Promise.all(
      [...this.#registrations].map(async ([observerId, registration]) => {
        try {
          await source.observe(
            registration.sessionId,
            observerId,
            bindTarget(registration.target),
            registration.messageAdmissions,
          );
          if (
            this.#source !== source ||
            this.#registrations.get(observerId) !== registration
          ) {
            return undefined;
          }
          registration.lifecycle = "active";
          registration.ready.resolve();
          return registration.sessionId;
        } catch (error) {
          if (
            this.#source === source &&
            this.#registrations.get(observerId) === registration
          ) {
            if (isMissingRuntimeHostSessionError(error)) {
              // The Host no longer serves this Session. Forget the
              // registration regardless of lifecycle so the stale entry
              // cannot fail every future reconnect, and let the upper layer
              // drop the Session view.
              onSessionMissing?.(registration.sessionId);
              this.#deleteRegistration(observerId, registration);
              return undefined;
            }
            if (registration.lifecycle === "pending") {
              this.#deleteRegistration(observerId, registration);
            }
            this.#onError(error);
          }
          return undefined;
        }
      }),
    );
    return [...new Set(restored.filter((sessionId): sessionId is string => !!sessionId))];
  }

  observedSessionIds(): string[] {
    return [...new Set([...this.#registrations.values()].map((registration) => registration.sessionId))];
  }

  trackedSessionIds(): string[] {
    return [
      ...new Set([
        ...[...this.#registrations.values()].map((registration) => registration.sessionId),
        ...[...this.#transcripts.values()].map((registration) => registration.sessionId),
      ]),
    ];
  }

  async forgetSession(sessionId: string): Promise<void> {
    const source = this.#source;
    const observations = [...this.#registrations].filter(
      ([, registration]) => registration.sessionId === sessionId,
    );
    const transcripts = [...this.#transcripts].filter(
      ([, registration]) => registration.sessionId === sessionId,
    );
    for (const [observerId, registration] of observations) {
      this.#deleteRegistration(observerId, registration);
    }
    for (const [consumerId, registration] of transcripts) {
      this.#deleteTranscript(consumerId, registration);
    }
    if (source) {
      await Promise.allSettled([
        ...observations.map(([observerId]) => source.unobserve(observerId)),
        ...transcripts.map(([consumerId]) => source.closeTranscript?.(consumerId)),
      ]);
    }
  }

  async releaseTarget(targetId: number): Promise<void> {
    const source = this.#source;
    const observations = [...this.#registrations].filter(
      ([, registration]) => registration.target.id === targetId,
    );
    const transcripts = [...this.#transcripts].filter(
      ([, registration]) => registration.target.id === targetId,
    );
    for (const [observerId, registration] of observations) {
      this.#deleteRegistration(observerId, registration);
    }
    for (const [consumerId, registration] of transcripts) {
      this.#deleteTranscript(consumerId, registration);
    }
    if (!source) return;

    const cleanup = await Promise.allSettled([
      ...observations.map(([observerId]) => source.unobserve(observerId)),
      ...transcripts.map(([consumerId]) => source.closeTranscript?.(consumerId, targetId)),
    ]);
    const errors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Failed to release renderer Session observations');
    }
  }

  detach(source: SessionObservationSource): void {
    if (this.#source === source) {
      this.#source = undefined;
      this.#bindTarget = (target) => target;
      for (const registration of this.#transcripts.values()) {
        registration.restore?.resolve();
      }
    }
  }

  async observe(
    sessionId: string,
    observerId: string,
    target: RuntimeHostSessionObserverTarget,
    messageAdmissions = false,
  ): Promise<void> {
    this.#assertOpen();
    const previous = this.#registrations.get(observerId);
    if (previous) {
      if (
        previous.sessionId !== sessionId ||
        previous.target.id !== target.id ||
        previous.messageAdmissions !== messageAdmissions
      ) {
        throw new Error("Runtime Host Session observer identity was reused");
      }
      return previous.ready.promise;
    }

    const destroyedListener = () => {
      void this.#remove(observerId).catch(this.#onError);
    };
    const ready = observationReadiness();
    void ready.promise.catch(() => undefined);
    const registration: SessionObservationRegistration = {
      sessionId,
      messageAdmissions,
      target,
      destroyedListener,
      ready,
      lifecycle: "pending",
    };
    this.#registrations.set(observerId, registration);
    target.once("destroyed", destroyedListener);

    const source = this.#source;
    if (!source) return registration.ready.promise;
    try {
      await source.observe(
        sessionId,
        observerId,
        this.#bindTarget(target),
        messageAdmissions,
      );
      if (
        this.#source === source &&
        this.#registrations.get(observerId) === registration
      ) {
        registration.lifecycle = "active";
        registration.ready.resolve();
      }
    } catch (error) {
      if (
        this.#source === source &&
        this.#registrations.get(observerId) === registration
      ) {
        this.#deleteRegistration(observerId, registration);
        throw error;
      }
      return registration.ready.promise;
    }
    return registration.ready.promise;
  }

  async unobserve(observerId: string): Promise<void> {
    await this.#remove(observerId);
  }

  async openTranscript(
    sessionId: string,
    consumerId: string,
    target: RuntimeHostTranscriptTarget,
  ): Promise<DesktopTranscriptOpenResult> {
    this.#assertOpen();
    if (this.#transcripts.has(consumerId)) {
      throw new Error('Desktop transcript consumer identity was reused');
    }
    const destroyedListener = () => {
      void this.closeTranscript(consumerId).catch(this.#onError);
    };
    const ready = transcriptReadiness();
    void ready.promise.catch(() => undefined);
    const registration: TranscriptRegistration = {
      sessionId,
      target,
      destroyedListener,
      ready,
      restore: undefined,
      lifecycle: 'pending',
    };
    this.#transcripts.set(consumerId, registration);
    target.once('destroyed', destroyedListener);
    const source = this.#source;
    if (!source) return ready.promise;
    const transcriptSource = requireTranscriptSource(source);
    try {
      const result = await transcriptSource.openTranscript(
        sessionId,
        consumerId,
        this.#bindTranscriptTarget(target),
      );
      if (this.#source === source && this.#transcripts.get(consumerId) === registration) {
        registration.lifecycle = 'active';
        registration.ready.resolve(result);
      } else {
        await transcriptSource.closeTranscript(consumerId);
      }
    } catch (error) {
      if (this.#source === source && this.#transcripts.get(consumerId) === registration) {
        this.#deleteTranscript(consumerId, registration);
        throw error;
      }
      return registration.ready.promise;
    }
    return registration.ready.promise;
  }

  async loadTranscriptBefore(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    await this.#runTranscriptOperation(request.consumerId, (source) =>
      source.loadTranscriptBefore(request, targetId),
    );
  }

  async loadTranscriptAround(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    await this.#runTranscriptOperation(request.consumerId, (source) =>
      source.loadTranscriptAround(request, targetId),
    );
  }

  acknowledgeTranscript(
    consumerId: string,
    generation: string,
    deliverySequence: number,
    targetId?: number,
  ): void {
    const registration = this.#transcripts.get(consumerId);
    if (!registration) throw new Error('Desktop transcript consumer does not exist');
    if (targetId !== undefined && registration.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    const source = this.#source;
    if (!source) return;
    if (!source.acknowledgeTranscript) {
      throw new Error('Runtime Host transcript acknowledgement source is unavailable');
    }
    source.acknowledgeTranscript(
      consumerId,
      generation,
      deliverySequence,
      targetId,
    );
  }

  async closeTranscript(consumerId: string, targetId?: number): Promise<void> {
    const registration = this.#transcripts.get(consumerId);
    if (!registration) return;
    if (targetId !== undefined && registration.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    this.#deleteTranscript(consumerId, registration);
    await this.#source?.closeTranscript?.(consumerId, targetId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const source = this.#source;
    this.#source = undefined;
    this.#bindTarget = (target) => target;
    const registrations = [...this.#registrations];
    const transcripts = [...this.#transcripts];
    this.#registrations.clear();
    for (const [, registration] of registrations) {
      registration.target.off("destroyed", registration.destroyedListener);
      registration.ready.reject(
        new Error("Session observation ended before it became ready"),
      );
    }
    for (const [consumerId, registration] of transcripts) {
      this.#deleteTranscript(consumerId, registration);
    }
    if (source) {
      await Promise.allSettled([
        ...registrations.map(([observerId]) => source.unobserve(observerId)),
        ...transcripts.map(([consumerId]) => source.closeTranscript?.(consumerId)),
      ]);
    }
  }

  async #remove(observerId: string): Promise<void> {
    const registration = this.#registrations.get(observerId);
    if (!registration) return;
    this.#deleteRegistration(observerId, registration);
    await this.#source?.unobserve(observerId);
  }

  #deleteRegistration(
    observerId: string,
    registration: SessionObservationRegistration,
  ): void {
    if (this.#registrations.get(observerId) !== registration) return;
    this.#registrations.delete(observerId);
    registration.target.off("destroyed", registration.destroyedListener);
    registration.ready.reject(
      new Error("Session observation ended before it became ready"),
    );
  }

  async #runTranscriptOperation(
    consumerId: string,
    operation: (source: SessionObservationSource & TranscriptSource) => Promise<void>,
  ): Promise<void> {
    const registration = this.#transcripts.get(consumerId);
    if (!registration) {
      throw new Error('Desktop transcript consumer does not exist');
    }
    const source = requireTranscriptSource(this.#source);
    try {
      const restore = registration.restore;
      if (restore) await restore.promise;
      if (
        this.#source !== source ||
        this.#transcripts.get(consumerId) !== registration
      ) {
        return;
      }
      await operation(source);
    } catch (error) {
      // Once either owner changes, this rejection belongs to stale work and
      // must not escape as a failure of the current renderer intent.
      if (
        this.#source !== source ||
        this.#transcripts.get(consumerId) !== registration
      ) {
        return;
      }
      throw error;
    }
  }

  #restoreTranscripts(source: SessionObservationSource): void {
    for (const [consumerId, registration] of this.#transcripts) {
      registration.restore?.resolve();
      const restore = observationReadiness();
      void restore.promise.catch(() => undefined);
      registration.restore = restore;
      void this.#restoreTranscript(source, consumerId, registration, restore);
    }
  }

  async #restoreTranscript(
    source: SessionObservationSource,
    consumerId: string,
    registration: TranscriptRegistration,
    restore: ObservationReadiness,
  ): Promise<void> {
    try {
      const transcriptSource = requireTranscriptSource(source);
      const result = await transcriptSource.openTranscript(
        registration.sessionId,
        consumerId,
        this.#bindTranscriptTarget(registration.target),
      );
      if (
        this.#source === source &&
        this.#transcripts.get(consumerId) === registration &&
        registration.restore === restore
      ) {
        registration.lifecycle = 'active';
        registration.ready.resolve(result);
        registration.restore = undefined;
        restore.resolve();
      } else {
        restore.resolve();
        await transcriptSource.closeTranscript(consumerId);
      }
    } catch (error) {
      if (
        this.#source === source &&
        this.#transcripts.get(consumerId) === registration &&
        registration.restore === restore
      ) {
        if (registration.lifecycle === 'pending') {
          this.#deleteTranscript(consumerId, registration);
        } else {
          restore.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.#onError(error);
      } else {
        restore.resolve();
      }
    }
  }

  #deleteTranscript(consumerId: string, registration: TranscriptRegistration): void {
    if (this.#transcripts.get(consumerId) !== registration) return;
    this.#transcripts.delete(consumerId);
    registration.restore?.resolve();
    registration.target.off('destroyed', registration.destroyedListener);
    registration.ready.reject(new Error('Transcript observation ended before it became ready'));
  }

  #bindTranscriptTarget(target: RuntimeHostTranscriptTarget): RuntimeHostTranscriptTarget {
    return this.#bindTarget(target);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Runtime Host Session observation registry is closed");
    }
  }
}
