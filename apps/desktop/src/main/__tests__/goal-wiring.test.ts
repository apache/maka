import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMainGoalWiring } from '../goal-wiring.js';

const SESSION = 'session-1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  return createMainGoalWiring({
    getDefaultConnectionSlug: async () => null,
    getConnection: async () => null,
    getSessionModel: async () => null,
    resolveConnectionSecret: async () => null,
    buildSubscriptionModelFetch: () => undefined,
    getAIModel: () => undefined,
    buildProviderOptions: () => undefined,
    getRecentMessages: async () => [],
    getTokenCount: async () => 0,
    admitTurn: () => ({ kind: 'unavailable', reason: 'not used by lifecycle tests' }),
  });
}

describe('Desktop Goal session lifecycle transaction', () => {
  test('failed persistence preserves Goal ownership and reopens admission', async (t) => {
    await t.test('archive', async () => {
      const wiring = setup();
      wiring.manager.create(SESSION, 'keep this Goal');
      const persisted = deferred<void>();
      const pending = wiring.archiveSession(SESSION, () => persisted.promise);

      assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-pending').kind, 'unavailable');
      persisted.reject(new Error('archive failed'));
      await assert.rejects(pending, /archive failed/);

      assert.equal(wiring.manager.get(SESSION)?.condition, 'keep this Goal');
      assert.equal(wiring.manager.get(SESSION)?.status, 'paused');
      assert.equal(
        wiring.manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session archive did not complete.',
      );
      assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-after-rollback').kind, 'registered');
      wiring.coordinator.dispose();
      wiring.manager.dispose();
    });

    await t.test('remove', async () => {
      const wiring = setup();
      wiring.manager.create(SESSION, 'keep this Goal');
      const persisted = deferred<void>();
      const pending = wiring.removeSession(SESSION, () => persisted.promise);

      assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-pending').kind, 'unavailable');
      persisted.reject(new Error('remove failed'));
      await assert.rejects(pending, /remove failed/);

      assert.equal(wiring.manager.get(SESSION)?.condition, 'keep this Goal');
      assert.equal(wiring.manager.get(SESSION)?.status, 'paused');
      assert.equal(
        wiring.manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session removal did not complete.',
      );
      assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-after-rollback').kind, 'registered');
      wiring.coordinator.dispose();
      wiring.manager.dispose();
    });
  });

  test('an overlapping remove rollback cannot reopen a committed archive', async () => {
    const wiring = setup();
    wiring.manager.create(SESSION, 'archive me');
    const archivePersisted = deferred<void>();
    const removePersisted = deferred<void>();
    const archive = wiring.archiveSession(SESSION, () => archivePersisted.promise);
    const remove = wiring.removeSession(SESSION, () => removePersisted.promise);

    archivePersisted.resolve();
    await archive;
    removePersisted.reject(new Error('remove failed'));
    await assert.rejects(remove, /remove failed/);

    assert.equal(wiring.manager.get(SESSION), undefined);
    assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-archived').kind, 'unavailable');
    await wiring.unarchiveSession(SESSION, async () => {});
    assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-restored').kind, 'registered');
    wiring.coordinator.dispose();
    wiring.manager.dispose();
  });

  test('permanent removal survives an older archive rollback and unarchive', async () => {
    const wiring = setup();
    wiring.manager.create(SESSION, 'delete me');
    const archivePersisted = deferred<void>();
    const archive = wiring.archiveSession(SESSION, () => archivePersisted.promise);

    await wiring.removeSession(SESSION, async () => {});
    archivePersisted.reject(new Error('archive failed late'));
    await assert.rejects(archive, /archive failed late/);
    await wiring.unarchiveSession(SESSION, async () => {});

    assert.equal(wiring.manager.get(SESSION), undefined);
    assert.equal(wiring.coordinator.beginObservedTurn(SESSION, 'turn-deleted').kind, 'unavailable');
    wiring.coordinator.dispose();
    wiring.manager.dispose();
  });
});
