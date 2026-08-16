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
