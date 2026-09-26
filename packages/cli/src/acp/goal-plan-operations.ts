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

import { RequestError } from '@agentclientprotocol/sdk';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import type {
  GoalArmInput,
  GoalArmResult,
  GoalControlInput,
  GoalControlResult,
  GoalQueryInput,
  GoalQueryResult,
  PlanControlInput,
  PlanControlResult,
  PlanQueryInput,
  PlanQueryResult,
  PlanTurnStartInput,
  PlanTurnStartResult,
} from '@maka/runtime-host/protocol';
import type { AcpSessionRegistryConnection, AcpLoadContext } from './session-registry.js';
import type { AcpAdmittedTurnObservation } from './turn-observation.js';

export interface PreparedGoalPlanOperation {
  readonly connection: AcpSessionRegistryConnection;
  readonly observation?: AcpAdmittedTurnObservation;
  /** Host already exposed this Turn; a replay does not own its observation. */
  readonly observedReplay?: boolean;
  reconcileAdmission?(): void;
  cancelObservation?(): void;
  commit(): void;
  rollback(error?: unknown): void;
}

/** The Registry owns these resources; use cases receive only preparation and request ports. */
export interface GoalPlanOperationPort {
  prepare(
    sessionId: string,
    context: AcpLoadContext,
    turnId?: string,
    observe?: boolean,
  ): Promise<PreparedGoalPlanOperation>;
  assertCurrent(sessionId: string): void;
  mapError(
    error: unknown,
    operation: GoalPlanOperationName,
    extra?: Record<string, unknown>,
  ): RequestError;
}

export type GoalPlanOperationName =
  | 'goal.query'
  | 'goal.arm'
  | 'goal.control'
  | 'plan.query'
  | 'plan.control'
  | 'plan.turn.start';

export class AcpGoalPlanOperations {
  readonly #port: GoalPlanOperationPort;
  constructor(port: GoalPlanOperationPort) {
    this.#port = port;
  }

  goalQuery(input: GoalQueryInput, context: AcpLoadContext): Promise<GoalQueryResult> {
    return this.#run('goal.query', input, context, !!context.notifyGoalStatus);
  }
  goalArm(input: GoalArmInput, context: AcpLoadContext): Promise<GoalArmResult> {
    return this.#run('goal.arm', input, context, true);
  }
  goalControl(input: GoalControlInput, context: AcpLoadContext): Promise<GoalControlResult> {
    return this.#run('goal.control', input, context, true);
  }
  planQuery(input: PlanQueryInput, context: AcpLoadContext): Promise<PlanQueryResult> {
    return this.#run('plan.query', input, context, !!context.notifyPlanChanged);
  }
  planControl(input: PlanControlInput, context: AcpLoadContext): Promise<PlanControlResult> {
    return this.#run('plan.control', input, context, true);
  }

  async planTurnStart(
    input: PlanTurnStartInput,
    context: AcpLoadContext,
  ): Promise<PlanTurnStartResult> {
    const prepared = await this.#port.prepare(input.sessionId, context, input.turnId, true);
    let dispatched = false;
    const onAbort = () => prepared.cancelObservation?.();
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    try {
      context.signal.throwIfAborted();
      this.#port.assertCurrent(input.sessionId);
      const observation = prepared.observation;
      if (!observation && !prepared.observedReplay)
        throw new Error('Plan Turn observer was not installed');
      observation?.markDispatched();
      dispatched = true;
      const result = await prepared.connection.request('plan.turn.start', input);
      observation?.settleStartRequest(result.turn);
      prepared.commit();
      return result;
    } catch (error) {
      if (dispatched && isDispatchedUnknown(error)) {
        prepared.observation?.failStartRequest(error);
        prepared.reconcileAdmission?.();
        prepared.commit();
        throw RequestError.internalError(
          {
            source: 'runtime_host',
            operation: 'plan.turn.start',
            code: 'outcome_unknown',
            dispatch: 'dispatched',
            sessionId: input.sessionId,
            turnId: input.turnId,
            ...(input.kind === 'approve_proposal'
              ? { proposalId: input.proposalId }
              : { executionId: input.executionId }),
          },
          'Plan Turn start outcome is unknown; query the Plan and exact Turn before retrying',
        );
      }
      if (dispatched && isPersistenceUnknown(error)) {
        prepared.observation?.failStartRequest(error);
        prepared.reconcileAdmission?.();
        prepared.commit();
        throw this.#port.mapError(error, 'plan.turn.start', {
          sessionId: input.sessionId,
          turnId: input.turnId,
        });
      }
      prepared.rollback(error);
      if (error instanceof RequestError) throw error;
      throw this.#port.mapError(error, 'plan.turn.start', {
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  async #run(
    operation: 'goal.query',
    input: GoalQueryInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<GoalQueryResult>;
  async #run(
    operation: 'goal.arm',
    input: GoalArmInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<GoalArmResult>;
  async #run(
    operation: 'goal.control',
    input: GoalControlInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<GoalControlResult>;
  async #run(
    operation: 'plan.query',
    input: PlanQueryInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<PlanQueryResult>;
  async #run(
    operation: 'plan.control',
    input: PlanControlInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<PlanControlResult>;
  async #run(
    operation: GoalPlanOperationName,
    input: GoalQueryInput | GoalArmInput | GoalControlInput | PlanQueryInput | PlanControlInput,
    context: AcpLoadContext,
    observe: boolean,
  ): Promise<
    GoalQueryResult | GoalArmResult | GoalControlResult | PlanQueryResult | PlanControlResult
  > {
    const prepared = await this.#port.prepare(input.sessionId, context, undefined, observe);
    let dispatched = false;
    try {
      context.signal.throwIfAborted();
      this.#port.assertCurrent(input.sessionId);
      dispatched = true;
      // The Host protocol validates both request and response against the operation spec.
      const result = await (
        prepared.connection.request as (
          name: GoalPlanOperationName,
          value: typeof input,
        ) => Promise<
          GoalQueryResult | GoalArmResult | GoalControlResult | PlanQueryResult | PlanControlResult
        >
      )(operation, input);
      prepared.commit();
      return result;
    } catch (error) {
      if (dispatched && isDispatchedUnknown(error)) {
        prepared.commit();
        throw RequestError.internalError(
          {
            source: 'runtime_host',
            operation,
            code: 'outcome_unknown',
            dispatch: 'dispatched',
            sessionId: input.sessionId,
            ...('goalId' in input ? { goalId: input.goalId } : {}),
            ...('operationId' in input ? { operationId: input.operationId } : {}),
            ...('proposalId' in input ? { proposalId: input.proposalId } : {}),
            ...('executionId' in input ? { executionId: input.executionId } : {}),
          },
          'Runtime Host operation outcome is unknown; query authoritative state before retrying',
        );
      }
      if (dispatched && isPersistenceUnknown(error)) {
        prepared.commit();
        throw this.#port.mapError(error, operation, { sessionId: input.sessionId });
      }
      prepared.rollback(error);
      if (error instanceof RequestError) throw error;
      throw this.#port.mapError(error, operation, { sessionId: input.sessionId });
    }
  }
}

function isDispatchedUnknown(error: unknown): boolean {
  return error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'dispatched';
}

function isPersistenceUnknown(error: unknown): boolean {
  return error instanceof RuntimeHostOperationError && error.code === 'persistence_failed';
}
