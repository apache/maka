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
import { preservesHostedExecutionEnvironment } from '../protocol/index.js';
import type {
  HostedExecutionAdmittedStartInput,
  HostedExecutionProjection,
  HostedExecutionReferenceInput,
  HostedExecutionStartInput,
  OperationOutcome,
} from '../protocol/index.js';
import type {
  ConnectionContext,
  HostedExecutionOperationHandlerMap,
} from './operation-dispatcher.js';

interface HostedExecutionRecord {
  readonly input: HostedExecutionStartInput;
  readonly authority: {
    readonly hostEpoch: string;
    readonly connectionId: string;
  };
  readonly abort: AbortController;
  readonly admissionToken: string;
  readonly task: Promise<HostedExecutionProjection>;
}

export class HostHostedExecutionCoordinator {
  readonly handlers: HostedExecutionOperationHandlerMap = {
    'hosted.execution.admit': (input, context) => this.#admit(input, context),
    'hosted.execution.start': (input, context) => this.#start(input, context),
    'hosted.execution.cancel': (input) => this.#cancel(input),
  };

  readonly #executions = new Map<string, HostedExecutionRecord>();
  readonly #cancelled = new Set<string>();
  #executionId: string | undefined;
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

  async #admit(
    input: HostedExecutionStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'hosted.execution.admit'>> {
    if (this.#executionId !== undefined && this.#executionId !== input.executionId) {
      return conflict();
    }
    if (this.#cancelled.has(input.executionId)) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Hosted execution was cancelled before admission',
        },
      };
    }
    const existing = this.#executions.get(input.executionId);
    if (existing) {
      if (
        !isDeepStrictEqual(existing.input, input) ||
        !sameAuthority(existing.authority, context)
      ) {
        return conflict();
      }
      return {
        ok: true,
        result: { executionId: input.executionId, admissionToken: existing.admissionToken },
      };
    }
    if (!this.#accepting) {
      return {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      };
    }

    this.#executionId = input.executionId;
    const execution = this.#createExecution(input, context);
    return {
      ok: true,
      result: { executionId: input.executionId, admissionToken: execution.admissionToken },
    };
  }

  async #start(
    input: HostedExecutionAdmittedStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'hosted.execution.start'>> {
    if (this.#executionId !== undefined && this.#executionId !== input.execution.executionId) {
      return conflict();
    }
    if (this.#cancelled.has(input.execution.executionId)) {
      this.requestDrain();
      return {
        ok: true,
        result: indeterminate(
          input.execution.executionId,
          'Hosted execution was cancelled before admission',
        ),
      };
    }
    const existing = this.#executions.get(input.execution.executionId);
    if (!existing) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Hosted execution was not admitted',
        },
      };
    }
    if (
      existing.admissionToken !== input.admissionToken ||
      !isDeepStrictEqual(existing.input, input.execution) ||
      !sameAuthority(existing.authority, context)
    ) {
      return conflict();
    }
    return { ok: true, result: structuredClone(await existing.task) };
  }

  #createExecution(
    input: HostedExecutionStartInput,
    context: ConnectionContext,
  ): HostedExecutionRecord {
    const abort = new AbortController();
    const admissionToken = randomUUID();
    const task = this.run(input, abort.signal)
      .catch(() => indeterminate(input.executionId, 'Runtime Host could not settle execution'))
      .then((result) => {
        if (!preservesHostedExecutionEnvironment(result)) this.requestDrain();
        return result;
      });
    const execution = {
      input: structuredClone(input),
      authority: { hostEpoch: context.hostEpoch, connectionId: context.connectionId },
      abort,
      admissionToken,
      task,
    };
    this.#executions.set(input.executionId, execution);
    return execution;
  }

  async #cancel(
    input: HostedExecutionReferenceInput,
  ): Promise<OperationOutcome<'hosted.execution.cancel'>> {
    if (this.#executionId !== undefined && this.#executionId !== input.executionId) {
      return conflict();
    }
    this.#executionId = input.executionId;
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
    const result = await execution.task;
    if (preservesHostedExecutionEnvironment(result)) this.requestDrain();
    return { ok: true, result: structuredClone(result) };
  }
}

function sameAuthority(
  authority: HostedExecutionRecord['authority'],
  context: ConnectionContext,
): boolean {
  return (
    authority.hostEpoch === context.hostEpoch && authority.connectionId === context.connectionId
  );
}

function conflict<
  K extends 'hosted.execution.admit' | 'hosted.execution.start' | 'hosted.execution.cancel',
>(): OperationOutcome<K> {
  return {
    ok: false,
    error: { code: 'operation_conflict', message: 'Hosted execution identity is already in use' },
  } as OperationOutcome<K>;
}

function indeterminate(executionId: string, failureReason: string): HostedExecutionProjection {
  return { executionId, kind: 'indeterminate', failureReason };
}
