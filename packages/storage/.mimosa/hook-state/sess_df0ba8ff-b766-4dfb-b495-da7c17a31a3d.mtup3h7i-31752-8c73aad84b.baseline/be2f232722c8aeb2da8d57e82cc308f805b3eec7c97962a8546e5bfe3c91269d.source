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

import { parentPort, threadId, workerData } from 'node:worker_threads';
import { createWorkBoardStore } from '../../work-board-store.js';

interface WorkerInput {
  workspaceRoot: string;
  itemId: string;
}

const input = workerData as WorkerInput;
const store = createWorkBoardStore(input.workspaceRoot);

try {
  const updated = await store.update(
    input.itemId,
    { title: `worker-${threadId}` },
    { expectedRevision: 1 },
    200,
  );
  parentPort?.postMessage({ ok: true, revision: updated.revision });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code:
      error instanceof Error && 'code' in error ? (error as { code?: unknown }).code : 'unknown',
  });
} finally {
  store.close();
}
