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

import type {
  ExternalConversationAuthority,
  ExternalConversationResolveResult,
} from '@maka/storage/external-conversation-authority';
import type {
  ExternalConversationReconcileInput,
  OperationOutcome,
  SessionCatalogItem,
  SessionCreateInput,
} from '../protocol/index.js';
import type { ExternalConversationOperationHandlerMap } from './operation-dispatcher.js';

const RESOLUTION_ATTEMPTS = 4;

type SessionPort = {
  probe(
    sessionId: string,
  ): Promise<
    | { readonly kind: 'present'; readonly session: SessionCatalogItem }
    | { readonly kind: 'absent' | 'removed' }
  >;
  create(input: SessionCreateInput): Promise<OperationOutcome<'session.create'>>;
};

export interface HostExternalConversationCoordinatorOptions {
  readonly authority: ExternalConversationAuthority;
  readonly sessions: SessionPort;
  readonly newId: () => string;
  readonly requestDrain: () => void;
}

/** Host-owned binding lifecycle for opaque external conversation identities. */
export class HostExternalConversationCoordinator {
  readonly handlers: ExternalConversationOperationHandlerMap = {
    'external-conversation.reconcile': (input) => this.reconcile(input),
  };

  readonly #authority: ExternalConversationAuthority;
  readonly #sessions: SessionPort;
  readonly #newId: () => string;
  readonly #requestDrain: () => void;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: HostExternalConversationCoordinatorOptions) {
    this.#authority = options.authority;
    this.#sessions = options.sessions;
    this.#newId = options.newId;
    this.#requestDrain = options.requestDrain;
  }

  reconcile(
    input: ExternalConversationReconcileInput,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    return this.#runExclusive(input.conversationId, () =>
      input.kind === 'release'
        ? this.#release(input)
        : input.kind === 'claim_source_event'
          ? this.#claimSourceEvent(input)
          : this.#resolve(input),
    );
  }

  async #claimSourceEvent(
    input: Extract<ExternalConversationReconcileInput, { readonly kind: 'claim_source_event' }>,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    try {
      const disposition = await this.#authority.claimSourceEvent(
        input.conversationId,
        input.operationId,
      );
      return { ok: true, result: { kind: 'source_event_claimed', disposition } };
    } catch {
      return failure('persistence_failed', 'External source event could not be claimed');
    }
  }

  async #release(
    input: Extract<ExternalConversationReconcileInput, { readonly kind: 'release' }>,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    try {
      const result = await this.#authority.release(input.conversationId, input.operationId);
      return { ok: true, result: { kind: 'released', hadBinding: result.hadBinding } };
    } catch {
      return failure('persistence_failed', 'External conversation could not be released');
    }
  }

  async #resolve(
    input: Extract<ExternalConversationReconcileInput, { readonly kind: 'resolve' }>,
  ): Promise<OperationOutcome<'external-conversation.reconcile'>> {
    if (input.session === undefined) {
      let existingBinding;
      try {
        existingBinding = await this.#authority.lookup(input.conversationId);
      } catch {
        return failure('persistence_failed', 'External conversation binding is unavailable');
      }
      if (!existingBinding) return { ok: true, result: { kind: 'create_required' } };
      let sessionProbe: Awaited<ReturnType<SessionPort['probe']>>;
      try {
        sessionProbe = await this.#sessions.probe(existingBinding.sessionId);
      } catch {
        return failure('persistence_failed', 'Bound Session state is unavailable');
      }
      if (sessionProbe.kind === 'present' && !isRetired(sessionProbe.session)) {
        return resolved(sessionProbe.session, 'existing');
      }
      if (sessionProbe.kind !== 'absent') {
        try {
          await this.#authority.remove(input.conversationId, existingBinding.sessionId);
        } catch {
          return failure('persistence_failed', 'Retired external conversation binding remains');
        }
      }
      return { ok: true, result: { kind: 'create_required' } };
    }

    for (let attempt = 0; attempt < RESOLUTION_ATTEMPTS; attempt += 1) {
      let binding: ExternalConversationResolveResult;
      try {
        binding = await this.#authority.resolve(input.conversationId, this.#newId());
      } catch {
        return failure('persistence_failed', 'External conversation binding is unavailable');
      }
      if (binding.kind === 'limit_reached') {
        return failure('operation_conflict', 'External conversation binding capacity is full');
      }
      const sessionId = binding.binding.sessionId;
      let sessionProbe: Awaited<ReturnType<SessionPort['probe']>>;
      try {
        sessionProbe = await this.#sessions.probe(sessionId);
      } catch {
        return failure('persistence_failed', 'Bound Session state is unavailable');
      }
      if (sessionProbe.kind === 'present' && !isRetired(sessionProbe.session)) {
        return resolved(sessionProbe.session, 'existing');
      }
      if (sessionProbe.kind !== 'absent') {
        try {
          await this.#authority.remove(input.conversationId, sessionId);
        } catch {
          return failure('persistence_failed', 'Retired external conversation binding remains');
        }
        continue;
      }

      const created = await this.#sessions.create({ sessionId, ...input.session });
      if (!created.ok) {
        if (created.error.code === 'commit_outcome_unknown') {
          this.#requestDrain();
        } else {
          try {
            await this.#authority.remove(input.conversationId, sessionId);
          } catch {
            return failure(
              'persistence_failed',
              'Failed Session creation left an external conversation binding',
            );
          }
        }
        return { ok: false, error: created.error };
      }
      return resolved(created.result, 'created');
    }
    return failure(
      'operation_conflict',
      'External conversation binding changed repeatedly during resolution',
    );
  }

  async #runExclusive<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(conversationId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(conversationId) === tail) this.#tails.delete(conversationId);
    }
  }
}

function isRetired(session: SessionCatalogItem): boolean {
  return 'kind' in session || session.isArchived;
}

function resolved(
  session: SessionCatalogItem,
  disposition: 'existing' | 'created',
): OperationOutcome<'external-conversation.reconcile'> {
  return { ok: true, result: { kind: 'resolved', disposition, session } };
}

function failure(
  code: Extract<
    OperationOutcome<'external-conversation.reconcile'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'external-conversation.reconcile'> {
  return { ok: false, error: { code, message } };
}
