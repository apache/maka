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
import { test } from 'node:test';
import { runRuntimeHostProcessLifecycle } from '../server/process-lifecycle.js';

test('process lifecycle owns termination signals before publishing readiness', async () => {
  const signalListeners = new Set(process.listeners('SIGTERM'));
  let closeCalls = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const host = {
    closed,
    close: () => {
      closeCalls += 1;
      resolveClosed();
      return closed;
    },
  };

  await runRuntimeHostProcessLifecycle(host, {
    onReady: () => {
      const terminationHandler = process
        .listeners('SIGTERM')
        .find((listener) => !signalListeners.has(listener));
      assert.ok(terminationHandler);
      terminationHandler('SIGTERM');
    },
  });

  assert.equal(closeCalls, 1);
  assert.deepEqual(new Set(process.listeners('SIGTERM')), signalListeners);
});
