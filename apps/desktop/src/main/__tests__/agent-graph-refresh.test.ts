import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createAgentGraphRefreshScheduler } from '../../renderer/agent-graph-refresh.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('agent graph refresh scheduler', () => {
  it('lets an in-flight read commit when a notification arrives mid-flight', async () => {
    const reads: Promise<void>[] = [];
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const committed: number[] = [];
    const scheduler = createAgentGraphRefreshScheduler((fence) => {
      const gate = deferred<void>();
      gates.push(gate);
      const started = fence;
      const read = gate.promise.then(() => {
        if (scheduler.isCurrent(started)) committed.push(started);
      });
      reads.push(read);
      return read;
    });

    scheduler.requestRefresh();
    assert.equal(gates.length, 1);

    // A graphs:changed notification while the read is in flight queues one
    // follow-up but must not invalidate the current read (#2991).
    scheduler.requestRefresh();
    gates[0]!.resolve();
    await tick();
    assert.deepEqual(committed, [0]);

    // The queued follow-up runs and commits too. Soft follow-ups share the
    // fence: only an explicit invalidation advances it.
    assert.equal(gates.length, 2);
    gates[1]!.resolve();
    await tick();
    assert.deepEqual(committed, [0, 0]);
    assert.equal(reads.length, 2);
    scheduler.dispose();
  });

  it('coalesces a notification storm into one follow-up read', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const scheduler = createAgentGraphRefreshScheduler(async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
    });

    scheduler.requestRefresh();
    scheduler.requestRefresh();
    scheduler.requestRefresh();
    scheduler.requestRefresh();
    gates[0]!.resolve();
    await tick();
    assert.equal(gates.length, 2);
    gates[1]!.resolve();
    await tick();
    assert.equal(gates.length, 2);
    scheduler.dispose();
  });

  it('discards an in-flight read only when the selection is invalidated', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const committed: number[] = [];
    const scheduler = createAgentGraphRefreshScheduler((fence) => {
      const gate = deferred<void>();
      gates.push(gate);
      const started = fence;
      return gate.promise.then(() => {
        if (scheduler.isCurrent(started)) committed.push(started);
      });
    });

    scheduler.requestRefresh();
    scheduler.invalidateAndRefresh();
    gates[0]!.resolve();
    await tick();
    assert.deepEqual(committed, []);

    assert.equal(gates.length, 2);
    gates[1]!.resolve();
    await tick();
    assert.deepEqual(committed, [1]);
    scheduler.dispose();
  });

  it('stops scheduling after dispose', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const scheduler = createAgentGraphRefreshScheduler(async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
    });

    scheduler.requestRefresh();
    scheduler.requestRefresh();
    scheduler.dispose();
    gates[0]!.resolve();
    await tick();
    assert.equal(gates.length, 1);
    scheduler.requestRefresh();
    scheduler.invalidateAndRefresh();
    await tick();
    assert.equal(gates.length, 1);
  });
});
