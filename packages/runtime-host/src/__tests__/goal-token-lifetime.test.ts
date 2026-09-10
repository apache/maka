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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveGoalAuthorityForWrite } from '@maka/storage/goal-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostGoalCoordinator } from '../server/goal-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context = {
  hostEpoch: 'token-lifetime',
  connectionId: 'test',
  principal: 'local_os_user' as const,
  acquireResidency: () => ({ release() {} }),
};

// Capture only synchronously constructed maps, restoring Map before any await.
// Identify the token map by its Session key and numeric value, not source locations.
function captureMaps<T>(factory: () => T) {
  const maps: Map<unknown, unknown>[] = [];
  const NativeMap = globalThis.Map;
  globalThis.Map = new Proxy(NativeMap, {
    construct(target, args, newTarget) {
      const map = Reflect.construct(target, args, newTarget) as Map<unknown, unknown>;
      maps.push(map);
      return map;
    },
  });
  try {
    return { value: factory(), maps };
  } finally {
    globalThis.Map = NativeMap;
  }
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'maka-goal-token-lifetime-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const goalStore = await openInteractiveGoalAuthorityForWrite(owner.lease);
  const pending = new Map<string, ReturnType<typeof blockRead>>();
  const releases: (() => void)[] = [];
  let evaluations = 0;
  const { value: host, maps } = captureMaps(
    () =>
      new HostGoalCoordinator({
        store: goalStore,
        stores,
        sessionAdmission: new SessionAdmissionGate(),
        readSessionMessages: async (id) => {
          const messages = await stores.sessionStore.readMessagesSnapshot(id);
          const blocked = pending.get(id);
          if (blocked) {
            blocked.entered.resolve();
            await blocked.release.promise;
          }
          return messages;
        },
        executions: {
          reconcile: async () => assert.fail('Unexpected recovery'),
          subscribe: () => () => {},
        },
        evaluator: {
          evaluate: async () => {
            evaluations++;
            return '{"met":true,"impossible":false,"progress":true,"waiting":false,"reason":"done"}';
          },
          close: async () => {},
        },
        admitTurn: () => assert.fail('Achieved Goals cannot continue'),
        acquireResidency: () => ({ release() {} }),
        onProjectionChanged: () => {},
        requestDrain: () => assert.fail('Unexpected drain'),
      }),
  );
  t.after(async () => {
    for (const release of releases) release();
    await host.close();
    await goalStore.close();
    await owner.close();
    await rm(base, { recursive: true, force: true });
  });
  await host.prepareRecovery();
  async function append(id: string, total: number) {
    await stores.sessionStore.appendMessage(id, {
      type: 'token_usage',
      id: randomUUID(),
      turnId: randomUUID(),
      ts: Date.now(),
      input: total / 3,
      output: (total * 2) / 3,
      total,
    });
  }
  async function create() {
    const session = await stores.sessionStore.create({
      cwd: capability.canonicalPath,
      llmConnectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    await append(session.id, 30);
    return session.id;
  }
  async function arm(id: string) {
    assert.equal(
      (
        await host.handlers['goal.arm'](
          {
            sessionId: id,
            condition: 'Finish',
            maxIterations: null,
            tokenBudget: null,
          },
          context,
        )
      ).ok,
      true,
    );
  }
  function settle(id: string) {
    const turnId = randomUUID();
    const turn = host.beginObservedTurn(id, turnId);
    assert.ok(turn.kind === 'registered');
    return turn.settle({ kind: 'completed', turnId });
  }
  async function complete(id: string) {
    await arm(id);
    await settle(id);
    assert.equal(host.manager.get(id)?.status, 'achieved');
  }
  async function clear(id: string) {
    const goal = host.manager.get(id);
    assert.ok(goal);
    assert.equal(
      (
        await host.handlers['goal.control'](
          {
            sessionId: id,
            goalId: goal.id,
            expectedRevision: goal.revision,
            action: 'clear',
          },
          context,
        )
      ).ok,
      true,
    );
  }
  async function retire(id: string, kind: 'archive' | 'remove') {
    const retirement = await host.beginSessionRetirement([id], kind);
    const header = await stores.sessionStore.readHeaderRecordSnapshot(id);
    const versioned = [{ sessionId: id, expectedVersion: header.revision }];
    if (kind === 'archive') await stores.sessionStore.setSessionsArchivedVersioned(versioned, true);
    else await stores.sessionStore.removeSessionsVersioned(versioned);
    retirement.commit();
    assert.equal(await goalStore.read(id), null);
    assert.equal(host.manager.get(id), undefined);
    assert.equal(host.beginObservedTurn(id, 'stale').kind, 'unavailable');
  }
  async function unarchive(id: string) {
    const header = await stores.sessionStore.readHeaderRecordSnapshot(id);
    await stores.sessionStore.setSessionsArchivedVersioned(
      [{ sessionId: id, expectedVersion: header.revision }],
      false,
    );
    host.unarchiveSessions([id]);
  }
  function blockRead(id: string) {
    const blocked = { entered: deferred(), release: deferred() };
    releases.push(blocked.release.resolve);
    pending.set(id, blocked);
    return blocked;
  }
  async function startBlocked(id: string) {
    await arm(id);
    const blocked = blockRead(id);
    const settling = settle(id);
    await withTimeout(blocked.entered.promise, 5_000, 'Context read did not start');
    return { ...blocked, settling };
  }
  const seed = await create();
  await complete(seed);
  const candidates = maps.filter((map) => map.get(seed) === 30);
  assert.equal(candidates.length, 1, 'Exactly one Session token cache must be observed');
  const cache = candidates[0]!;
  await retire(seed, 'remove');
  return {
    host,
    cache,
    create,
    complete,
    clear,
    retire,
    unarchive,
    append,
    startBlocked,
    pending,
    evaluations: () => evaluations,
  };
}

test('retired Goal token metadata is released only on commit and on Host close', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) {
    const id = await f.create();
    await f.complete(id);
    assert.equal(f.cache.get(id), 30);
    const retirement = await f.host.beginSessionRetirement([id], 'archive');
    assert.equal(f.cache.get(id), 30);
    assert.equal(f.host.beginObservedTurn(id, 'pending').kind, 'unavailable');
    retirement.rollback();
    assert.equal(f.cache.get(id), 30);
    assert.equal(f.host.manager.get(id)?.status, 'achieved');
    await f.retire(id, i % 2 ? 'archive' : 'remove');
    assert.equal(f.cache.size, 0);
  }
  const id = await f.create();
  await f.complete(id);
  assert.equal(f.cache.size, 1);
  await f.host.close();
  assert.equal(f.cache.size, 0);
});

test('a pending context read cannot refill token metadata after clear and removal', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  const blocked = await f.startBlocked(id);
  await f.clear(id);
  await f.retire(id, 'remove');
  assert.equal(f.cache.size, 0);
  const evaluations = f.evaluations();
  blocked.release.resolve();
  await blocked.settling;
  await setImmediate(); // Invalidated settlement can finish before the old context read.
  assert.equal(f.cache.size, 0);
  assert.equal(f.evaluations(), evaluations);
  assert.equal(f.host.beginObservedTurn(id, 'late').kind, 'unavailable');
});

test('an old context read cannot overwrite a new Goal after archive and unarchive', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  const blocked = await f.startBlocked(id);
  await f.clear(id);
  await f.retire(id, 'archive');
  await f.unarchive(id);
  f.pending.delete(id);
  await f.append(id, 90);
  await f.complete(id);
  assert.equal(f.cache.get(id), 120);
  assert.equal(f.host.manager.tokensSpent(id), 0, 'New Goal establishes its own baseline');
  blocked.release.resolve();
  await blocked.settling;
  await setImmediate();
  assert.equal(f.cache.get(id), 120);
  await f.retire(id, 'remove');
  assert.equal(f.cache.size, 0);
});

test('drain clears token metadata and rejects writes from a pending context read', async (t) => {
  const f = await fixture(t);
  await f.complete(await f.create());
  const id = await f.create();
  const blocked = await f.startBlocked(id);
  assert.equal(f.cache.size, 1);
  f.host.beginDrain();
  assert.equal(f.cache.size, 0);
  blocked.release.resolve();
  await blocked.settling;
  await f.host.close();
  assert.equal(f.cache.size, 0);
});
