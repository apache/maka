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

import type { PreparedOperation } from './types.js';

const ONE_SHOT_OPERATION = Symbol('maka.one-shot-prepared-operation');

type ConsumedState = 'running' | 'settled';

type BrandedPreparedOperation<Result> = PreparedOperation<Result> & {
  readonly [ONE_SHOT_OPERATION]: true;
};

/** A duplicate execute attempt is an invariant violation, not an effect retry. */
export class PreparedOperationAlreadyExecutedError extends Error {
  override readonly name = 'PreparedOperationAlreadyExecutedError';

  constructor(readonly state: ConsumedState) {
    super(`PreparedOperation has already been executed (${state})`);
  }
}

/**
 * Decorate a PreparedOperation with an atomic one-shot state transition.
 *
 * The operation is consumed before its effect is invoked. A synchronous throw,
 * asynchronous rejection, or abort therefore never makes the same prepared
 * capability reusable; retrying requires a fresh prepare call.
 */
export function oneShotOperation<Result>(
  operation: PreparedOperation<Result>,
): PreparedOperation<Result> {
  if (isOneShotOperation(operation)) return operation;

  let state: 'ready' | ConsumedState = 'ready';
  const wrapped: PreparedOperation<Result> = {
    claims: operation.claims,
    execute(signal, fallbackEffect, executionContext) {
      if (state !== 'ready') {
        return Promise.reject(new PreparedOperationAlreadyExecutedError(state));
      }

      // Move to running before invoking user/domain code so two synchronous
      // callers cannot both pass the ready check.
      state = 'running';
      let execution: Promise<Result>;
      try {
        execution = Promise.resolve(
          operation.execute(signal, fallbackEffect, executionContext),
        );
      } catch (error) {
        execution = Promise.reject(error);
      }
      return execution.finally(() => {
        state = 'settled';
      });
    },
  };
  Object.defineProperty(wrapped, ONE_SHOT_OPERATION, {
    value: true,
    enumerable: false,
  });
  return wrapped;
}

function isOneShotOperation<Result>(
  operation: PreparedOperation<Result>,
): operation is BrandedPreparedOperation<Result> {
  return (operation as Partial<BrandedPreparedOperation<Result>>)[ONE_SHOT_OPERATION] === true;
}
