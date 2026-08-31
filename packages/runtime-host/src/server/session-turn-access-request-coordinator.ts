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

import type { SessionTurnAccessRequest } from '../protocol/index.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
import type {
  ConnectionContext,
  OperationHandler,
  OperationResidency,
} from './operation-dispatcher.js';

type TurnAccessRequestAuthority = Pick<
  RuntimeHostAccessAuthority,
  'approvedTurnAccessRequests' | 'completeTurnAccessRequest' | 'subscribeApprovedTurnAccessRequests'
>;

export class SessionTurnAccessRequestCoordinator {
  readonly #authority: TurnAccessRequestAuthority;
  readonly #startTurn: OperationHandler<'turn.start'>;
  readonly #acquireResidency: () => OperationResidency;
  readonly #requestDrain: () => void;
  readonly #whenIdle: (sessionId: string) => Promise<void> | undefined;
  readonly #hostEpoch: string;
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  #draining = false;

  constructor(input: {
    readonly authority: TurnAccessRequestAuthority;
    readonly startTurn: OperationHandler<'turn.start'>;
    readonly acquireResidency: () => OperationResidency;
    readonly requestDrain: () => void;
    readonly whenIdle: (sessionId: string) => Promise<void> | undefined;
    readonly hostEpoch: string;
  }) {
    this.#authority = input.authority;
    this.#startTurn = input.startTurn;
    this.#acquireResidency = input.acquireResidency;
    this.#requestDrain = input.requestDrain;
    this.#whenIdle = input.whenIdle;
    this.#hostEpoch = input.hostEpoch;
    this.#unsubscribe = input.authority.subscribeApprovedTurnAccessRequests((request) => {
      this.#schedule(request);
    });
  }

  recover(): void {
    for (const request of this.#authority.approvedTurnAccessRequests()) {
      this.#schedule(request);
    }
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#unsubscribe();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#settled();
  }

  #schedule(request: SessionTurnAccessRequest): void {
    if (this.#draining || this.#tasks.has(request.requestId)) return;
    const task = this.#admit(request).finally(() => {
      this.#tasks.delete(request.requestId);
    });
    this.#tasks.set(request.requestId, task);
  }

  async #admit(request: SessionTurnAccessRequest): Promise<void> {
    if (request.state.kind !== 'approved' || request.state.admission !== 'pending') return;
    const residency = this.#acquireResidency();
    const context: ConnectionContext = {
      hostEpoch: this.#hostEpoch,
      connectionId: `collaboration:${request.requestId}`,
      principal: request.principalId,
      turnAdmissionAuthorization: {
        kind: 'session_turn_access_request',
        requestId: request.requestId,
        principalId: request.principalId,
        grantId: request.grantId,
        approvedAt: Date.parse(request.state.decidedAt),
        approvedBy: request.state.decidedBy,
      },
      acquireResidency: this.#acquireResidency,
    };
    try {
      let outcome: Awaited<ReturnType<OperationHandler<'turn.start'>>>;
      for (;;) {
        try {
          outcome = await this.#startTurn(request.intent, context);
        } catch {
          this.#requestDrain();
          return;
        }
        if (outcome.ok || outcome.error.code !== 'session_busy') break;
        const whenIdle = this.#whenIdle(request.intent.sessionId);
        if (whenIdle) {
          try {
            await whenIdle;
          } catch {
            this.#requestDrain();
            return;
          }
        }
        if (this.#draining) return;
      }
      if (this.#draining && !outcome.ok) return;
      try {
        await this.#authority.completeTurnAccessRequest(
          request.requestId,
          outcome.ok ? outcome.result.kind : 'failed',
        );
      } catch {
        this.#requestDrain();
      }
    } finally {
      residency.release();
    }
  }

  #settled(): Promise<void> {
    return Promise.all(this.#tasks.values()).then(() => undefined);
  }
}
