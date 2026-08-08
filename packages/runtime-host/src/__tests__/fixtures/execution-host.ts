import { join } from 'node:path';
import { createSqliteRuntimeStore } from '@maka/storage';
import { startExecutionRuntimeHostCandidate } from '../../server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from '../../server/process-lifecycle.js';

const [rootPath, expectedRootId, idleGraceRaw, recoverySessionId, recoveryRunId] =
  process.argv.slice(2);
if (!rootPath || !expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
  throw new Error(
    'usage: execution-host <root> <expected-root-id> [idle-grace-ms] [recovery-session-id recovery-run-id]',
  );
}
if ((recoverySessionId === undefined) !== (recoveryRunId === undefined)) {
  throw new Error('execution-host recovery probe requires both Session and Run identities');
}
const idleGraceMs = idleGraceRaw === undefined ? 30_000 : Number(idleGraceRaw);
if (!Number.isSafeInteger(idleGraceMs) || idleGraceMs < 0) {
  throw new Error('execution-host requires a non-negative idle grace');
}

const result = await startExecutionRuntimeHostCandidate({
  rootPath,
  expectedRootId,
  idleGraceMs,
});
if (result.kind === 'loser') process.exit(2);

let recoveryOutcome: unknown;
if (recoverySessionId && recoveryRunId) {
  const store = createSqliteRuntimeStore(join(rootPath, 'runtime.sqlite'), { readOnly: true });
  try {
    recoveryOutcome = (await store.readImmutableRuntimeEvents(recoverySessionId, recoveryRunId)).at(
      -1,
    );
  } finally {
    store.close();
  }
}

process.on('message', (message: unknown) => {
  if (
    message &&
    typeof message === 'object' &&
    (message as { type?: unknown }).type === 'shutdown'
  ) {
    void result.host.close();
  }
});

try {
  await runRuntimeHostProcessLifecycle(result.host, {
    closeOnDisconnect: true,
    onReady: () =>
      process.send?.({
        type: 'ready',
        hostEpoch: result.host.hostEpoch,
        endpoint: result.host.endpoint,
        ...(recoveryOutcome ? { recoveryOutcome } : {}),
      }),
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
