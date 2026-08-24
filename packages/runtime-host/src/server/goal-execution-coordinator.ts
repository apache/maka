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
import type { GoalCheckpoint, GoalControlLease } from '@maka/runtime/goal-state';
import type { GoalTurnAdmission, GoalTurnOutcome } from '@maka/runtime/goal-continuation';
import type { SessionManager } from '@maka/runtime/session-manager';
import type {
  HostedExecutionAuthority,
  HostedExecutionSnapshot,
} from './hosted-execution-authority.js';
import { waitForHostedExecutionTerminal } from './hosted-execution-wait.js';

type GoalExecutionAuthority = Pick<HostedExecutionAuthority, 'prepare' | 'reconcile' | 'subscribe'>;
type GoalRuntime = Pick<SessionManager, 'sendMessage'>;

export interface HostGoalExecutionCoordinatorOptions {
  readonly executions: GoalExecutionAuthority;
  readonly runtime: GoalRuntime;
  readonly matchesActive: (
    sessionId: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ) => boolean;
  readonly newId?: () => string;
}

/** Owns the Goal Domain's mapping onto Hosted Execution admission and terminal facts. */
export class HostGoalExecutionCoordinator {
  readonly #executions: GoalExecutionAuthority;
  readonly #runtime: GoalRuntime;
  readonly #matchesActive: HostGoalExecutionCoordinatorOptions['matchesActive'];
  readonly #newId: () => string;
  readonly #prepared = new Set<
    Extract<ReturnType<GoalExecutionAuthority['prepare']>, { kind: 'prepared' }>['admission']
  >();
  #draining = false;

  constructor(options: HostGoalExecutionCoordinatorOptions) {
    this.#executions = options.executions;
    this.#runtime = options.runtime;
    this.#matchesActive = options.matchesActive;
    this.#newId = options.newId ?? randomUUID;
  }

  admitTurn(
    sessionId: string,
    text: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ): GoalTurnAdmission {
    if (this.#draining) {
      return {
        kind: 'unavailable',
        reason: 'Runtime Host Goal execution is draining.',
      };
    }
    const preparation = this.#executions.prepare(sessionId);
    if (preparation.kind === 'busy') return preparation;
    if (preparation.kind === 'unavailable') return preparation;

    const execution = {
      sessionId,
      turnId: this.#newId(),
      runId: this.#newId(),
    };
    const userMessageId = this.#newId();
    let started = false;
    let gateCancelled = false;
    const prepared = preparation.admission;
    this.#prepared.add(prepared);

    return {
      kind: 'prepared',
      turnId: execution.turnId,
      execution,
      start: async () => {
        if (started) {
          return {
            kind: 'errored',
            turnId: execution.turnId,
            reason: 'Goal continuation admission was started more than once.',
          };
        }
        started = true;
        if (this.#draining || !this.#matchesActive(sessionId, checkpoint, controlLease)) {
          prepared.release();
          this.#prepared.delete(prepared);
          return {
            kind: 'errored',
            turnId: execution.turnId,
            reason: 'Goal continuation is unavailable for this Session.',
          };
        }
        try {
          const initial = await prepared.admit({
            ...execution,
            userMessageId,
            execution: { kind: 'goal', goalId: checkpoint.goalId },
            content: { text },
            admitExecution: async () => {
              gateCancelled =
                this.#draining || !this.#matchesActive(sessionId, checkpoint, controlLease);
              return gateCancelled ? 'cancelled' : 'executing';
            },
            start: ({ runId, userMessageId: admittedMessageId, onRunStarted }) => {
              if (runId !== execution.runId || admittedMessageId !== userMessageId) {
                throw new Error('Hosted Execution changed the Goal continuation identity');
              }
              return this.#runtime.sendMessage(
                sessionId,
                {
                  turnId: execution.turnId,
                  text,
                  origin: { kind: 'goal', goalId: checkpoint.goalId },
                },
                {
                  runId,
                  userMessageId,
                  durability: 'required',
                  onRunStarted: async (startedRunId) => {
                    if (startedRunId !== runId) {
                      throw new Error('Runtime changed the Goal continuation Run identity');
                    }
                    await onRunStarted();
                  },
                },
              );
            },
          });
          const terminal = await waitForHostedExecutionTerminal(
            this.#executions,
            execution,
            initial.snapshot,
            { completion: initial.completion },
          );
          await initial.settled;
          return goalTurnOutcomeFromHostedExecution(terminal);
        } catch (error) {
          return {
            kind: 'errored',
            turnId: execution.turnId,
            reason: gateCancelled
              ? 'Goal continuation is unavailable for this Session.'
              : errorMessage(error),
          };
        } finally {
          this.#prepared.delete(prepared);
        }
      },
    };
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const prepared of this.#prepared) prepared.release();
    this.#prepared.clear();
  }
}

export function goalTurnOutcomeFromHostedExecution(
  snapshot: HostedExecutionSnapshot,
): GoalTurnOutcome {
  if (snapshot.status === 'completed') {
    return { kind: 'completed', turnId: snapshot.turnId };
  }
  if (snapshot.status === 'cancelled') {
    return { kind: 'aborted', turnId: snapshot.turnId };
  }
  if (snapshot.status === 'failed') {
    return {
      kind: 'errored',
      turnId: snapshot.turnId,
      reason: `Turn ended with ${snapshot.failureClass}`,
    };
  }
  return {
    kind: 'errored',
    turnId: snapshot.turnId,
    reason: `Turn ended in non-terminal status ${snapshot.status}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
