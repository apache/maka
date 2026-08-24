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
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
} from '@maka/runtime/message-authority';
import type { OperationOutcome, TurnQueryInput, TurnStopInput } from '../protocol/index.js';
import type { TurnOperationHandlerMap } from './operation-dispatcher.js';
import type { HostedExecutionAuthority } from './hosted-execution-authority.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';

type TurnControlExecutionAuthority = Pick<
  HostedExecutionAuthority,
  'lookup' | 'read' | 'requestStop'
>;

export interface HostTurnControlCoordinatorOptions {
  readonly executions: TurnControlExecutionAuthority;
  readonly sessionAdmission: SessionAdmissionGate;
}

/** Owns the Interactive wire contract for observing and stopping admitted Turns. */
export class HostTurnControlCoordinator {
  readonly handlers: Pick<TurnOperationHandlerMap, 'turn.query' | 'turn.stop'> = {
    'turn.query': (input) => this.#query(input),
    'turn.stop': (input) => this.#stop(input),
  };

  readonly #executions: TurnControlExecutionAuthority;
  readonly #sessionAdmission: SessionAdmissionGate;

  constructor(options: HostTurnControlCoordinatorOptions) {
    this.#executions = options.executions;
    this.#sessionAdmission = options.sessionAdmission;
  }

  #query(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    return this.#sessionAdmission.run(input.sessionId, async () => {
      const execution = await this.#executions.lookup(input.sessionId, input.turnId);
      if (!execution) return notFound('Turn was not admitted');
      return { ok: true, result: await this.#executions.read(execution) };
    });
  }

  async #stop(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    const execution = await this.#executions.lookup(input.sessionId, input.turnId);
    if (!execution) return notFound('Turn was not admitted');
    if (execution.runId !== input.runId) {
      return operationConflict('Run identity does not match the admitted Turn');
    }
    try {
      return {
        ok: true,
        result: await this.#executions.requestStop({ execution, source: 'stop_button' }),
      };
    } catch (error) {
      if (error instanceof RuntimeHostedRootConflictError) {
        return operationConflict(error.message);
      }
      if (error instanceof RuntimeHostedRootUnavailableError) {
        return operationUnavailable(error.message);
      }
      throw error;
    }
  }
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function operationUnavailable(message: string) {
  return { ok: false, error: { code: 'operation_unavailable', message } } as const;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
