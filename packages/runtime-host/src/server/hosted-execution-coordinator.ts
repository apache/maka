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

import { isDeepStrictEqual } from 'node:util';
import { preservesHostedExecutionEnvironment } from '../protocol/index.js';
import type {
  HostedExecutionProjection,
  HostedExecutionReferenceInput,
  HostedExecutionStartInput,
  OperationOutcome,
} from '../protocol/index.js';
import type { HostedExecutionOperationHandlerMap } from './operation-dispatcher.js';

export class HostHostedExecutionCoordinator {
  readonly handlers: HostedExecutionOperationHandlerMap = {
    'hosted.execution.start': (input) => this.#start(input),
    'hosted.execution.cancel': (input) => this.#cancel(input),
  };

  readonly #executions = new Map<
    string,
    {
      readonly input: HostedExecutionStartInput;
      readonly abort: AbortController;
      readonly task: Promise<HostedExecutionProjection>;
    }
  >();
  readonly #cancelled = new Set<string>();
  #accepting = true;

  constructor(
    private readonly run: (
      input: HostedExecutionStartInput,
      signal: AbortSignal,
    ) => Promise<HostedExecutionProjection>,
    private readonly requestDrain: () => void,
  ) {}

  beginDrain(): void {
    this.#accepting = false;
    for (const execution of this.#executions.values()) execution.abort.abort();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all([...this.#executions.values()].map(({ task }) => task));
  }

  async #start(
    input: HostedExecutionStartInput,
  ): Promise<OperationOutcome<'hosted.execution.start'>> {
    if (this.#cancelled.has(input.executionId)) {
      this.requestDrain();
      return {
        ok: true,
        result: indeterminate(input.executionId, 'Hosted execution was cancelled before admission'),
      };
    }
    const existing = this.#executions.get(input.executionId);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) return conflict();
      return { ok: true, result: structuredClone(await existing.task) };
    }
    if (!this.#accepting) {
      return { ok: false, error: { code: 'host_draining', message: 'Runtime Host is draining' } };
    }
    const abort = new AbortController();
    const task = this.run(input, abort.signal)
      .catch(() => indeterminate(input.executionId, 'Runtime Host could not settle execution'))
      .then((result) => {
        if (!preservesHostedExecutionEnvironment(result)) this.requestDrain();
        return result;
      })
      .finally(() => {
        this.#executions.delete(input.executionId);
      });
    this.#executions.set(input.executionId, { input: structuredClone(input), abort, task });
    return { ok: true, result: structuredClone(await task) };
  }

  async #cancel(
    input: HostedExecutionReferenceInput,
  ): Promise<OperationOutcome<'hosted.execution.cancel'>> {
    this.#cancelled.add(input.executionId);
    const execution = this.#executions.get(input.executionId);
    if (!execution) {
      this.requestDrain();
      return {
        ok: true,
        result: indeterminate(input.executionId, 'Hosted execution is not active'),
      };
    }
    execution.abort.abort();
    return { ok: true, result: structuredClone(await execution.task) };
  }
}

function conflict(): OperationOutcome<'hosted.execution.start'> {
  return {
    ok: false,
    error: { code: 'operation_conflict', message: 'Hosted execution identity is already in use' },
  };
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
