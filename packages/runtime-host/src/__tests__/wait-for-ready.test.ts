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
