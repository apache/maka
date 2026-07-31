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
