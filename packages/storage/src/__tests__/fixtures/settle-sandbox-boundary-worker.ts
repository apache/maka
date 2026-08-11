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
