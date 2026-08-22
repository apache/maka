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

import { parentPort, workerData } from 'node:worker_threads';

import type { SandboxBoundarySettlement } from '@maka/core/sandbox-boundary';

import { createSqliteSessionMetadataStore } from '../../sqlite-session-metadata-store.js';

interface WorkerInput {
  path: string;
  requestId: string;
  startSettlement: SharedArrayBuffer;
  holdAfterBoundaryWrite?: SharedArrayBuffer;
}

const input = workerData as WorkerInput;
const startSettlement = new Int32Array(input.startSettlement);
const release = input.holdAfterBoundaryWrite
  ? new Int32Array(input.holdAfterBoundaryWrite)
  : undefined;
const store = createSqliteSessionMetadataStore(input.path, {
  ...(release
    ? {
        failpoint: (point) => {
          if (point !== 'after_sandbox_boundary_write') return;
          parentPort?.postMessage({ type: 'holding' });
          Atomics.wait(release, 0, 0);
        },
      }
    : {}),
});

try {
  parentPort?.postMessage({ type: 'ready' });
  Atomics.wait(startSettlement, 0, 0);
  parentPort?.postMessage({ type: 'attempting' });
  const settlement: SandboxBoundarySettlement = await store.settleSandboxBoundaryRequest({
    sessionId: 'session-1',
    requestId: input.requestId,
    decision: 'allow',
  });
  parentPort?.postMessage({ type: 'settled', settlement });
} catch (error) {
  parentPort?.postMessage({
    type: 'failed',
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  store.close();
}
