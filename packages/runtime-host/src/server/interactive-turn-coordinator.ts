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

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { normalizeMessageContent, type MessageContent } from '@maka/core/events';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import { RuntimeMessageAuthorityInvariantError } from '@maka/runtime/message-authority';
import { parseSkillInvocationTokens } from '@maka/runtime/skill-invocation';
import { type SessionManager } from '@maka/runtime/session-manager';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { OperationOutcome, TurnRegenerateInput, TurnStartInput } from '../protocol/index.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
import type {
  RootMessageContentPreparation,
  RootMessageStartRequest,
  RootTurnCoordinator,
  TurnStartOutcome,
} from './root-turn-coordinator.js';

const EMPTY_SKILL_INVOCATION: SkillInvocationResult = {
  loaded: [],
  failed: [],
  receipts: [],
};

type InteractiveTurnExecutionPort = Pick<
  RootTurnCoordinator,
  'prepareHostedSkillInvocationContent' | 'startInteractiveRootMessage'
>;
type InteractiveTurnStore = Pick<
  ExecutionStoresWriter<'interactive'>['agentRunStore'],
  'commitRootTurnStartRejection' | 'readRootTurnAdmission' | 'readRootTurnStartRejection'
>;
type InteractiveTurnRuntime = Pick<SessionManager, 'prepareRegenerateTurn'>;

export interface HostInteractiveTurnCoordinatorOptions {
  readonly executions: InteractiveTurnExecutionPort;
  readonly turns: InteractiveTurnStore;
  readonly runtime: InteractiveTurnRuntime;
}

/** Owns Interactive Turn start and regenerate wire semantics. */
export class HostInteractiveTurnCoordinator {
  readonly handlers: Pick<TurnOperationHandlerMap, 'turn.start' | 'turn.regenerate'> = {
    'turn.start': (input, context) => this.#start(input, context),
    'turn.regenerate': (input, context) => this.#regenerate(input, context),
  };

  readonly #executions: InteractiveTurnExecutionPort;
  readonly #turns: InteractiveTurnStore;
  readonly #runtime: InteractiveTurnRuntime;

  constructor(options: HostInteractiveTurnCoordinatorOptions) {
    this.#executions = options.executions;
    this.#turns = options.turns;
    this.#runtime = options.runtime;
  }

  async #start(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    const content = normalizeMessageContent(input.content);
    const skillIds = input.skillIds ?? [];
    if (skillIds.length > 0 || parseSkillInvocationTokens(content.text).length > 0) {
      return this.#startSkillInvocation(
        input,
        content,
        skillIds,
        {
          kind: 'external_message',
          inputDigest: hostedExternalInputDigest(content, skillIds),
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        },
        context,
      );
    }
    const outcome = await this.#executions.startInteractiveRootMessage(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        execution: {
          kind: 'external_message',
          ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
        },
        ...(input.turnOrchestration ? { turnOrchestration: { ...input.turnOrchestration } } : {}),
        archivedMessage: 'Cannot start a new Turn in an archived Session',
        content,
      },
      context,
    );
    return outcome.ok
      ? {
          ok: true,
          result: {
            kind: 'started',
            turn: outcome.result,
            skillInvocation: EMPTY_SKILL_INVOCATION,
          },
        }
      : outcome;
  }

  async #startSkillInvocation(
    input: TurnStartInput,
    content: MessageContent,
    skillIds: readonly string[],
    execution: Extract<RootExecutionDescriptor, { kind: 'external_message' }>,
    context: ConnectionContext,
  ): Promise<TurnStartOutcome> {
    const request: RootMessageStartRequest = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      execution,
      ...(input.turnOrchestration ? { turnOrchestration: { ...input.turnOrchestration } } : {}),
      archivedMessage: 'Cannot start a new Turn in an archived Session',
      prepareFreshContent: async () => {
        const existing = await this.#turns.readRootTurnStartRejection(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          if (!isDeepStrictEqual(existing.execution, execution)) {
            return rejected('Turn identity belongs to a different rejected execution payload');
          }
          return {
            ...rejected('Explicit Skill invocation was durably rejected'),
            skillInvocation: existing.skillInvocation,
          };
        }
        const prepared = await this.#executions.prepareHostedSkillInvocationContent(
          input.sessionId,
          input.turnId,
          content,
          skillIds,
          context.connectionId,
        );
        if (prepared.kind === 'ready' || !prepared.skillInvocation) return prepared;
        const committed = await this.#turns.commitRootTurnStartRejection({
          sessionId: input.sessionId,
          turnId: input.turnId,
          execution,
          skillInvocation: prepared.skillInvocation,
          rejectedAt: Date.now(),
        });
        return committed.kind === 'conflict'
          ? rejected('Turn identity belongs to a different rejected Skill invocation')
          : prepared;
      },
    };
    const outcome = await this.#executions.startInteractiveRootMessage(request, context);
    const rejection = await this.#turns.readRootTurnStartRejection(input.sessionId, input.turnId);
    if (rejection && isDeepStrictEqual(rejection.execution, execution)) {
      return {
        ok: true,
        result: { kind: 'blocked', skillInvocation: rejection.skillInvocation },
      };
    }
    if (!outcome.ok) return outcome;
    const admission = await this.#turns.readRootTurnAdmission(input.sessionId, input.turnId);
    if (!admission) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Started Skill invocation is missing its durable root Turn admission',
      );
    }
    return {
      ok: true,
      result: {
        kind: 'started',
        turn: outcome.result,
        skillInvocation: admission.skillInvocation ?? EMPTY_SKILL_INVOCATION,
      },
    };
  }

  #regenerate(
    input: TurnRegenerateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'turn.regenerate'>> {
    if (input.sourceTurnId === input.turnId) {
      return Promise.resolve(
        operationConflict('Regenerate source and target Turn identities must differ'),
      );
    }
    return this.#executions.startInteractiveRootMessage(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        execution: { kind: 'regenerate', sourceTurnId: input.sourceTurnId },
        archivedMessage: 'Cannot regenerate a Turn in an archived Session',
        prepareContent: async () =>
          (await this.#runtime.prepareRegenerateTurn(input.sessionId, input.sourceTurnId)).content,
      },
      context,
    );
  }
}

function rejected(message: string): Extract<RootMessageContentPreparation, { kind: 'rejected' }> {
  return { kind: 'rejected', outcome: operationConflict(message) };
}

function hostedExternalInputDigest(
  content: MessageContent,
  skillIds: readonly string[],
): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ content, skillIds: [...skillIds] }))
    .digest('hex')}`;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
