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

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  RequestError,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationPropertySchema,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  decodeInteractionAnswer,
  isInteractionAnswerValidForRequest,
  INTERACTION_ANSWER_MAX_BYTES,
  type InteractionAnswer,
  type InteractionFormField,
} from '@maka/core/interaction';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '@maka/runtime-host/client';
import {
  INTERACTION_MAX_PENDING_PER_SESSION,
  type InteractionAnsweredSnapshot,
  type InteractionPendingSnapshot,
  type InteractionResolvedSnapshot,
  type InteractionSnapshot,
} from '@maka/runtime-host/protocol';

export interface AcpInteractionClient {
  readonly capabilities: ClientCapabilities;
  requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  createElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
}

export interface AcpSessionInteractionsOptions {
  readonly sessionId: string;
  readonly connection: Pick<RuntimeHostConnection, 'request'>;
  readonly client: AcpInteractionClient;
  /** Ensures the associated tool card is visible before requesting input. */
  readonly onPending: (pending: InteractionPendingSnapshot) => Promise<void>;
  readonly onAnswered: (
    answered: InteractionAnsweredSnapshot,
    pending: InteractionPendingSnapshot,
  ) => void;
  readonly onResolved: (
    resolved: InteractionResolvedSnapshot,
    pending: InteractionPendingSnapshot,
  ) => Promise<void> | void;
  readonly onFailure: (pending: InteractionPendingSnapshot, error: RequestError) => void;
  readonly onCancelled: (pending: InteractionPendingSnapshot) => void;
}

interface PendingInteraction {
  readonly snapshot: InteractionPendingSnapshot;
  readonly cancellation: AbortController;
  task: Promise<void>;
}

/** Connection-local presentation of Host interactions; the Host owns every answer and grant. */
export class AcpSessionInteractions {
  readonly #options: AcpSessionInteractionsOptions;
  readonly #lifetime = new AbortController();
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #resolving = new Map<string, Promise<void>>();
  readonly #published = new Set<string>();
  #cancelledTurnId: string | undefined;

  constructor(options: AcpSessionInteractionsOptions) {
    this.#options = options;
  }

  pending(snapshot: InteractionPendingSnapshot): Promise<void> {
    if (this.#lifetime.signal.aborted || snapshot.turnId === this.#cancelledTurnId) {
      return Promise.resolve();
    }
    const existing = this.#pending.get(snapshot.interactionId);
    if (existing) return existing.task;
    if (snapshot.sessionId !== this.#options.sessionId) {
      this.#fail(snapshot, interactionError(snapshot, 'invalid_interaction', 'Wrong Session'));
      return Promise.resolve();
    }
    if (this.#pending.size >= INTERACTION_MAX_PENDING_PER_SESSION) {
      this.#fail(snapshot, interactionError(snapshot, 'interaction_capacity_exceeded'));
      return Promise.resolve();
    }
    const entry: PendingInteraction = {
      snapshot,
      cancellation: new AbortController(),
      task: Promise.resolve(),
    };
    this.#pending.set(snapshot.interactionId, entry);
    entry.task = this.#present(entry)
      .catch((error: unknown) => {
        if (!entry.cancellation.signal.aborted) this.#fail(snapshot, error);
      })
      .finally(() => {
        if (this.#pending.get(snapshot.interactionId) === entry) {
          this.#pending.delete(snapshot.interactionId);
        }
      });
    return entry.task;
  }

  resolved(pending: InteractionPendingSnapshot): Promise<void> {
    if (pending.sessionId !== this.#options.sessionId) {
      this.#fail(pending, interactionError(pending, 'invalid_interaction', 'Wrong Session'));
      return Promise.resolve();
    }
    this.#retire(pending.interactionId);
    if (this.#lifetime.signal.aborted || this.#published.has(pending.interactionId)) {
      return Promise.resolve();
    }
    const existing = this.#resolving.get(pending.interactionId);
    if (existing) return existing;
    if (this.#resolving.size >= INTERACTION_MAX_PENDING_PER_SESSION) {
      this.#fail(pending, interactionError(pending, 'interaction_capacity_exceeded'));
      return Promise.resolve();
    }
    const task = this.#readResolved(pending)
      .catch((error: unknown) => this.#fail(pending, error))
      .finally(() => {
        if (this.#resolving.get(pending.interactionId) === task) {
          this.#resolving.delete(pending.interactionId);
        }
      });
    this.#resolving.set(pending.interactionId, task);
    return task;
  }

  cancelTurn(turnId: string): void {
    this.#cancelledTurnId = turnId;
    for (const entry of this.#pending.values()) {
      if (entry.snapshot.turnId === turnId) this.#retire(entry.snapshot.interactionId);
    }
  }

  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort();
    for (const id of this.#pending.keys()) this.#retire(id);
    this.#resolving.clear();
    this.#published.clear();
  }

  async #present(entry: PendingInteraction): Promise<void> {
    const pending = entry.snapshot;
    const signal = entry.cancellation.signal;
    // A replayed pending snapshot can outlive an answer. Re-query the existing
    // authority before opening another dialog rather than retaining an unbounded history.
    const queried = await whileActive(this.#query(pending), signal);
    if (!queried.active) return;
    assertSameInteraction(pending, queried.value);
    if (queried.value.status !== 'pending') {
      await this.#publishResolved(queried.value, pending, signal);
      return;
    }
    const request = pending.request;
    if (request.kind === 'permission') {
      throw interactionError(pending, 'unsupported_interaction', 'Legacy permission is not live');
    }
    if (
      (request.kind === 'question' || request.kind === 'form') &&
      this.#options.client.capabilities.elicitation?.form == null
    ) {
      throw interactionError(
        pending,
        'unsupported_interaction',
        'Client requires form elicitation',
      );
    }
    const presented = await whileActive(
      Promise.resolve().then(() => {
        if (!signal.aborted) return this.#options.onPending(pending);
      }),
      signal,
    );
    if (!presented.active) return;

    let answer: InteractionAnswer;
    if (request.kind === 'question' || request.kind === 'form') {
      const response = await whileActive(
        this.#options.client.createElicitation(elicitationRequest(pending), signal),
        signal,
      );
      if (!response.active) return;
      try {
        answer = elicitationAnswer(pending, response.value);
      } catch {
        throw interactionError(pending, 'invalid_interaction_answer');
      }
    } else {
      const allow = randomUUID();
      const deny = randomUUID();
      const response = await whileActive(
        this.#options.client.requestPermission(permissionRequest(pending, allow, deny), signal),
        signal,
      );
      if (!response.active) return;
      if (response.value.outcome.outcome === 'cancelled') {
        this.cancelTurn(pending.turnId);
        this.#options.onCancelled(pending);
        return;
      }
      const optionId = response.value.outcome.optionId;
      if (optionId !== allow && optionId !== deny) {
        throw interactionError(pending, 'invalid_interaction_answer', 'Unknown permission option');
      }
      answer = { kind: request.kind, decision: optionId === allow ? 'allow' : 'deny' };
    }
    try {
      answer = decodeInteractionAnswer(answer);
      if (!isInteractionAnswerValidForRequest(pending.request, answer)) throw new Error();
    } catch {
      throw interactionError(pending, 'invalid_interaction_answer');
    }
    if (signal.aborted) return;
    try {
      const answered = await whileActive(
        this.#options.connection.request('interaction.answer', {
          sessionId: pending.sessionId,
          interactionId: pending.interactionId,
          answer,
        }),
        signal,
      );
      if (answered.active) await this.#publishResolved(answered.value, pending, signal);
    } catch (error) {
      if (!(error instanceof RuntimeHostOperationError) || error.code !== 'already_resolved') {
        throw error;
      }
      await this.#readResolved(pending, signal);
    }
  }

  #query(pending: InteractionPendingSnapshot): Promise<InteractionSnapshot> {
    return this.#options.connection.request('interaction.query', {
      sessionId: pending.sessionId,
      interactionId: pending.interactionId,
    });
  }

  async #readResolved(
    pending: InteractionPendingSnapshot,
    signal = this.#lifetime.signal,
  ): Promise<void> {
    const active = AbortSignal.any([signal, this.#lifetime.signal]);
    const queried = await whileActive(this.#query(pending), active);
    if (!queried.active) return;
    assertSameInteraction(pending, queried.value);
    if (queried.value.status !== 'pending') {
      await this.#publishResolved(queried.value, pending, active);
    }
  }

  async #publishResolved(
    resolved: InteractionResolvedSnapshot,
    pending: InteractionPendingSnapshot,
    signal = this.#lifetime.signal,
  ): Promise<void> {
    const active = AbortSignal.any([signal, this.#lifetime.signal]);
    if (active.aborted || this.#published.has(pending.interactionId)) return;
    assertSameInteraction(pending, resolved);
    this.#published.add(pending.interactionId);
    if (this.#published.size > INTERACTION_MAX_PENDING_PER_SESSION) {
      this.#published.delete(this.#published.values().next().value!);
    }
    if (resolved.status === 'answered') this.#options.onAnswered(resolved, pending);
    await whileActive(
      Promise.resolve().then(() => {
        if (!active.aborted) return this.#options.onResolved(resolved, pending);
      }),
      active,
    );
  }

  #retire(interactionId: string): void {
    const entry = this.#pending.get(interactionId);
    this.#pending.delete(interactionId);
    entry?.cancellation.abort();
  }

  #fail(pending: InteractionPendingSnapshot, error: unknown): void {
    if (this.#lifetime.signal.aborted) return;
    let failure: RequestError;
    if (error instanceof RuntimeHostOperationError) {
      failure = RequestError.internalError(
        { source: 'runtime_host', operation: error.operation, code: error.code },
        'Runtime Host interaction failed',
      );
    } else if (error instanceof RequestError && error.code !== -32601) {
      failure = error;
    } else {
      failure = interactionError(
        pending,
        error instanceof RequestError ? 'unsupported_interaction' : 'interaction_failed',
      );
    }
    this.#options.onFailure(pending, failure);
  }
}

function elicitationRequest(pending: InteractionPendingSnapshot): CreateElicitationRequest {
  const request = pending.request;
  if (request.kind !== 'question' && request.kind !== 'form') throw new Error('Not a form');
  const properties: Record<string, ElicitationPropertySchema> = Object.create(null);
  const required: string[] = [];
  if (request.kind === 'question') {
    request.questions.forEach((question, index) => {
      properties[`q${index}`] = {
        type: 'string',
        title: question.question,
        description: [
          ...question.options.map((option) =>
            option.description ? `${option.label}: ${option.description}` : option.label,
          ),
          'Enter an option or your own answer. Leave empty to skip this question.',
        ].join('\n'),
        maxLength: INTERACTION_ANSWER_MAX_BYTES,
      };
    });
  } else {
    for (const field of request.fields) {
      properties[field.name] = formProperty(field);
      if (field.required) required.push(field.name);
    }
  }
  return {
    sessionId: pending.sessionId,
    toolCallId: request.toolUseId,
    mode: 'form',
    message:
      request.kind === 'question'
        ? 'Please answer the following questions.'
        : `${request.requester.name}${request.requester.source ? ` (${request.requester.source})` : ''}: ${request.message}`,
    requestedSchema: { type: 'object', properties, required },
  };
}

function formProperty(field: InteractionFormField): ElicitationPropertySchema {
  const base = {
    title: field.label,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.default === undefined ? {} : { default: structuredClone(field.default) }),
  };
  switch (field.kind) {
    case 'string':
      return {
        ...base,
        type: 'string',
        ...(field.minLength === undefined ? {} : { minLength: field.minLength }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
        ...(field.format === undefined ? {} : { format: field.format }),
      };
    case 'number':
      return {
        ...base,
        type: 'number',
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      };
    case 'integer':
      return {
        ...base,
        type: 'integer',
        minimum: Math.max(
          Number.MIN_SAFE_INTEGER,
          Math.ceil(field.minimum ?? Number.MIN_SAFE_INTEGER),
        ),
        maximum: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.floor(field.maximum ?? Number.MAX_SAFE_INTEGER),
        ),
      };
    case 'boolean':
      return { ...base, type: 'boolean' };
    case 'single_select':
      return {
        ...base,
        type: 'string',
        oneOf: field.options.map((option) => ({ const: option.value, title: option.label })),
      };
    case 'multi_select':
      return {
        ...base,
        type: 'array',
        items: {
          anyOf: field.options.map((option) => ({ const: option.value, title: option.label })),
        },
        ...(field.minItems === undefined ? {} : { minItems: field.minItems }),
        ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
      };
  }
}

function elicitationAnswer(
  pending: InteractionPendingSnapshot,
  response: CreateElicitationResponse,
): InteractionAnswer {
  const request = pending.request;
  const action = response.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
    throw interactionError(pending, 'invalid_interaction_answer', 'Unknown elicitation action');
  }
  if (request.kind === 'form') {
    return decodeInteractionAnswer(
      action === 'accept'
        ? { kind: 'form', action, values: response.content ?? {} }
        : { kind: 'form', action },
    );
  }
  if (request.kind !== 'question') throw new Error('Not a question');
  if (action !== 'accept') {
    return { kind: 'question', answers: request.questions.map(() => null) };
  }
  const content = response.content ?? {};
  if (
    typeof content !== 'object' ||
    Array.isArray(content) ||
    Object.keys(content).some((key) => !request.questions.some((_, index) => key === `q${index}`))
  ) {
    throw interactionError(pending, 'invalid_interaction_answer', 'Invalid question fields');
  }
  return {
    kind: 'question',
    answers: request.questions.map((_, index) => {
      const value = (content as Record<string, unknown>)[`q${index}`];
      if (value === undefined) return null;
      if (typeof value !== 'string') {
        throw interactionError(
          pending,
          'invalid_interaction_answer',
          'Question answer is not text',
        );
      }
      return value.trim() || null;
    }),
  };
}

function permissionRequest(
  pending: InteractionPendingSnapshot,
  allow: string,
  deny: string,
): RequestPermissionRequest {
  const request = pending.request;
  if (request.kind !== 'sandbox_boundary' && request.kind !== 'client_capability') {
    throw new Error('Not a permission request');
  }
  const boundary = request.kind === 'sandbox_boundary';
  return {
    sessionId: pending.sessionId,
    toolCall: {
      toolCallId: boundary ? pending.interactionId : request.toolUseId,
      title: boundary ? 'Expand this Session’s sandbox boundary' : 'Authorize a Session capability',
      status: 'pending',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: boundary
              ? `${request.justification}\n\nApply only this requested expansion to this Session’s boundary:\n${JSON.stringify(request.expansion, null, 2)}`
              : `Grant only the following exact capability target for this Session:\n${JSON.stringify(request.target, null, 2)}`,
          },
        },
      ],
    },
    options: [
      {
        optionId: allow,
        name: boundary
          ? 'Apply this expansion to this Session'
          : 'Allow this scope for this Session',
        kind: 'allow_always',
      },
      { optionId: deny, name: 'Reject', kind: 'reject_once' },
    ],
  };
}

function assertSameInteraction(
  pending: InteractionPendingSnapshot,
  actual: InteractionSnapshot,
): void {
  if (
    pending.interactionId !== actual.interactionId ||
    pending.sessionId !== actual.sessionId ||
    pending.turnId !== actual.turnId ||
    pending.runId !== actual.runId ||
    !isDeepStrictEqual(pending.request, actual.request)
  ) {
    throw interactionError(pending, 'invalid_interaction', 'Host interaction identity changed');
  }
}

function interactionError(
  pending: InteractionPendingSnapshot,
  code: string,
  detail?: string,
): RequestError {
  return RequestError.internalError(
    { source: 'adapter', code, kind: pending.request.kind, interactionId: pending.interactionId },
    detail ? `ACP interaction failed: ${detail}` : 'ACP interaction failed',
  );
}

/** SDK cancellation is cooperative; losing tasks still have a rejection handler. */
function whileActive<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<{ active: true; value: T } | { active: false }> {
  return new Promise((resolve, reject) => {
    const cancelled = () => resolve({ active: false });
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', cancelled);
        resolve(signal.aborted ? { active: false } : { active: true, value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancelled);
        if (signal.aborted) resolve({ active: false });
        else reject(error);
      },
    );
  });
}
