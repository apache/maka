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

import type { RootTurnAdmission } from '@maka/storage/execution-stores';

export interface HostedExecutionDeferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export interface HostedExecutionReservation {
  readonly kind: 'pending';
  readonly sessionId: string;
  readonly whenIdle: HostedExecutionDeferred;
  readonly admissionSettled: HostedExecutionDeferred;
  admissionPhase: 'prepared' | 'committing';
}

interface ParkedHostedExecutionReservation {
  readonly kind: 'parked_continuation';
  readonly sessionId: string;
  readonly admission: RootTurnAdmission;
  readonly whenIdle: HostedExecutionDeferred;
  readonly admissionSettled: HostedExecutionDeferred;
}

type SessionHostedExecutionReservation =
  | HostedExecutionReservation
  | ParkedHostedExecutionReservation;

export class HostedExecutionAdmissionRegistry {
  readonly #bySession = new Map<string, SessionHostedExecutionReservation>();
  #draining = false;

  constructor(private readonly isSessionActive: (sessionId: string) => boolean) {}

  get isDraining(): boolean {
    return this.#draining;
  }

  has(sessionId: string): boolean {
    return this.#bySession.has(sessionId);
  }

  get(sessionId: string): SessionHostedExecutionReservation | undefined {
    return this.#bySession.get(sessionId);
  }

  reserve(sessionId: string): HostedExecutionReservation | undefined {
    const reservation: HostedExecutionReservation = {
      kind: 'pending',
      sessionId,
      whenIdle: hostedExecutionDeferred(),
      admissionSettled: hostedExecutionDeferred(),
      admissionPhase: 'prepared',
    };
    return this.claim(reservation) ? reservation : undefined;
  }

  claim(reservation: HostedExecutionReservation): boolean {
    if (
      this.#draining ||
      this.isSessionActive(reservation.sessionId) ||
      this.#bySession.has(reservation.sessionId)
    ) {
      return false;
    }
    this.#bySession.set(reservation.sessionId, reservation);
    return true;
  }

  park(admission: RootTurnAdmission): void {
    const existing = this.#bySession.get(admission.sessionId);
    if (existing) {
      if (
        existing.kind !== 'parked_continuation' ||
        existing.admission.turnId !== admission.turnId ||
        existing.admission.runId !== admission.runId
      ) {
        throw new Error(`Session ${admission.sessionId} has conflicting parked continuations`);
      }
      return;
    }
    this.#bySession.set(admission.sessionId, {
      kind: 'parked_continuation',
      sessionId: admission.sessionId,
      admission,
      whenIdle: hostedExecutionDeferred(),
      admissionSettled: hostedExecutionDeferred(),
    });
  }

  takeParked(admission: RootTurnAdmission): HostedExecutionReservation | undefined {
    const parked = this.#bySession.get(admission.sessionId);
    if (
      parked?.kind !== 'parked_continuation' ||
      parked.admission.turnId !== admission.turnId ||
      parked.admission.runId !== admission.runId
    ) {
      return undefined;
    }
    const reservation: HostedExecutionReservation = {
      kind: 'pending',
      sessionId: parked.sessionId,
      whenIdle: parked.whenIdle,
      admissionSettled: parked.admissionSettled,
      admissionPhase: 'prepared',
    };
    this.#bySession.set(admission.sessionId, reservation);
    return reservation;
  }

  clearParked(admission: RootTurnAdmission): void {
    const reservation = this.takeParked(admission);
    if (reservation) this.release(reservation);
  }

  parked(sessionId: string): RootTurnAdmission | undefined {
    const reservation = this.#bySession.get(sessionId);
    return reservation?.kind === 'parked_continuation' ? reservation.admission : undefined;
  }

  begin(reservation: HostedExecutionReservation): boolean {
    if (this.#bySession.get(reservation.sessionId) !== reservation) return false;
    if (reservation.admissionPhase === 'committing') return true;
    if (this.#draining) return false;
    reservation.admissionPhase = 'committing';
    return true;
  }

  release(reservation: SessionHostedExecutionReservation): void {
    if (this.#bySession.get(reservation.sessionId) !== reservation) return;
    this.#bySession.delete(reservation.sessionId);
    reservation.admissionSettled.resolve();
    reservation.whenIdle.resolve();
  }

  activated(reservation: HostedExecutionReservation, executionDone: Promise<void>): void {
    if (this.#bySession.get(reservation.sessionId) !== reservation) {
      throw new Error('Hosted execution activation lost its committing reservation');
    }
    this.#bySession.delete(reservation.sessionId);
    reservation.admissionSettled.resolve();
    void executionDone.then(
      () => reservation.whenIdle.resolve(),
      () => reservation.whenIdle.resolve(),
    );
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const reservation of this.#bySession.values()) {
      if (reservation.kind === 'pending' && reservation.admissionPhase === 'committing') continue;
      this.release(reservation);
    }
  }

  waitForSettledAdmissions(): Promise<void> {
    return Promise.all(
      [...this.#bySession.values()].map((value) => value.admissionSettled.promise),
    ).then(() => undefined);
  }
}

export function hostedExecutionDeferred(): HostedExecutionDeferred {
  let settled = false;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}
