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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  oneShotOperation,
  PreparedOperationAlreadyExecutedError,
} from '../preparation/one-shot-operation.js';

describe('oneShotOperation', () => {
  test('rejects a concurrent duplicate before it can invoke the effect', async () => {
    const gate = deferred<void>();
    let calls = 0;
    const operation = oneShotOperation({
      claims: [],
      execute: async () => {
        calls += 1;
        await gate.promise;
        return 'done';
      },
    });

    const first = operation.execute();
    await assert.rejects(
      operation.execute(),
      (error: unknown) =>
        error instanceof PreparedOperationAlreadyExecutedError && error.state === 'running',
    );
    gate.resolve();
    assert.equal(await first, 'done');
    assert.equal(calls, 1);
  });

  test('remains consumed after success', async () => {
    const operation = oneShotOperation({ claims: [], execute: async () => 'done' });

    assert.equal(await operation.execute(), 'done');
    await assert.rejects(operation.execute(), PreparedOperationAlreadyExecutedError);
  });

  test('remains consumed after a synchronous throw or asynchronous rejection', async () => {
    for (const execute of [
      () => {
        throw new Error('sync failure');
      },
      async () => {
        throw new Error('async failure');
      },
    ]) {
      const operation = oneShotOperation({ claims: [], execute });
      await assert.rejects(operation.execute(), /failure/);
      await assert.rejects(operation.execute(), PreparedOperationAlreadyExecutedError);
    }
  });

  test('is idempotent when a composition boundary wraps it again', () => {
    const operation = oneShotOperation({ claims: [], execute: async () => undefined });
    assert.strictEqual(oneShotOperation(operation), operation);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
