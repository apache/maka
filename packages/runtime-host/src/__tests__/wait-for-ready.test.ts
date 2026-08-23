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
import test from 'node:test';
import { waitForRuntimeHostReady } from '../client/wait-for-ready.js';

test('stops a pending ready probe when its reconnect attempt is cancelled', async () => {
  const started = deferred();
  const never = new Promise<never>(() => undefined);
  const controller = new AbortController();
  const waiting = waitForRuntimeHostReady(
    {
      status: async () => {
        started.resolve();
        return never;
      },
    },
    45_000,
    controller.signal,
  );
  await started.promise;
  const reason = new Error('closed');
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) => error === reason);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
