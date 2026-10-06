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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CreateScheduledTaskInput } from '@maka/core/scheduled-task';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { ScheduledTaskMutateInput } from '../protocol/index.js';
import {
  HostScheduledTaskCoordinator,
  type HostScheduledTaskCoordinatorInput,
} from '../server/scheduled-task-coordinator.js';

async function schedulerFixture() {
  const base = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-retry-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' }),
  );
  assert.ok(owner);
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  let now = 1_000;
  let providerAvailable = false;
  let timer: { callback: () => void; delayMs: number } | undefined;
  const deliveries: Record<string, unknown>[] = [];
  const input: HostScheduledTaskCoordinatorInput = {
    store,
    sessions: null as never,
    runtime: null as never,
    root: null as never,
    runtimePolicy: {
      runtimePolicy: {
        getSnapshot: async () => ({ policy: { privacy: { incognitoActive: false } } }),
      },
    } as never,
    nativeEffects: {
      hasWorkspaceService: () => providerAvailable,
      callWorkspaceService: async (request) => {
        deliveries.push(request.input);
        return {};
      },
    },
    createSession: async () => assert.fail('Notification must not create a Session'),
    changes: { publish: () => {} },
    acquireResidency: () => ({ release: () => {} }),
    requestDrain: () => assert.fail('Scheduler must not drain'),
    now: () => now,
    setTimeout: (callback, delayMs) => {
      timer = { callback, delayMs };
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle === timer) timer = undefined;
    },
  };
  let coordinator = new HostScheduledTaskCoordinator(input);
  await coordinator.prepareRecovery();
  const mutate = (command: ScheduledTaskMutateInput) =>
    coordinator.handlers['scheduled-task.mutate'](command, {} as never);
  return {
    store,
    deliveries,
    mutate,
    setNow: (at: number) => {
      now = at;
    },
    connectProvider: () => {
      providerAvailable = true;
    },
    timerDelay: () => timer?.delayMs,
    async create(patch: Partial<CreateScheduledTaskInput> = {}) {
      const outcome = await mutate({
        kind: 'create',
        input: {
          title: 'Reminder',
          intentBody: 'Review the report',
          schedule: { kind: 'once', runAt: 11_000 },
          effect: { kind: 'notify', channel: 'local' },
          ...patch,
        },
      });
      assert.equal(outcome.ok, true);
      if (!outcome.ok || outcome.result.kind !== 'task') throw new Error('Task creation failed');
      return outcome.result.task;
    },
    async start() {
      coordinator.start();
      // The public catalog query waits behind the scheduler's current lane.
      await coordinator.list();
    },
    async tick(at: number) {
      now = at;
      assert.ok(timer, 'Expected a scheduled timer');
      const callback = timer.callback;
      timer = undefined;
      callback();
      await coordinator.list();
    },
    async restart() {
      await coordinator.close();
      coordinator = new HostScheduledTaskCoordinator(input);
      await coordinator.prepareRecovery();
      await coordinator.recover();
      coordinator.start();
      await coordinator.list();
    },
    async close() {
      await coordinator.close();
      store.close();
      await owner.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('due notifications wait five seconds for a provider and deliver once after reconnect', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create();
    await fixture.start();
    assert.equal(fixture.timerDelay(), 10_000);
    await fixture.tick(11_000);
    assert.equal((await fixture.store.listPendingFires())[0]?.nativeState, 'waiting_for_provider');
    assert.equal(fixture.timerDelay(), 5_000);
    await fixture.tick(16_000);
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(21_000);
    assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
    const completed = await fixture.store.get(task.id);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.fireCount, 1);
    assert.equal(completed?.runs[0]?.outcome, 'ok');
    assert.equal(fixture.timerDelay(), undefined);
    await fixture.restart();
    assert.equal(fixture.deliveries.length, 1);
  } finally {
    await fixture.close();
  }
});

for (const triggerAt of [1_000, 3_601_000]) {
  test(`manual notification at ${triggerAt} schedules provider retry independently of its due time`, async () => {
    const fixture = await schedulerFixture();
    try {
      const task = await fixture.create({ schedule: { kind: 'once', runAt: 3_601_000 } });
      await fixture.start();
      assert.equal(fixture.timerDelay(), 3_600_000);
      fixture.setNow(triggerAt);
      const outcome = await fixture.mutate({ kind: 'trigger_now', taskId: task.id });
      assert.deepEqual(outcome, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'ScheduledTask native delivery is waiting for a Desktop provider',
        },
      });
      assert.equal(
        (await fixture.store.listPendingFires())[0]?.nativeState,
        'waiting_for_provider',
      );
      assert.equal(fixture.timerDelay(), 5_000);
      fixture.connectProvider();
      await fixture.tick(triggerAt + 5_000);
      assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
      assert.equal((await fixture.store.get(task.id))?.fireCount, 1);
      assert.equal(fixture.timerDelay(), undefined);
    } finally {
      await fixture.close();
    }
  });
}

test('recovery retries a persisted waiting fire before its original future due time', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({ schedule: { kind: 'once', runAt: 3_601_000 } });
    await fixture.start();
    await fixture.mutate({ kind: 'trigger_now', taskId: task.id });
    await fixture.restart();
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(6_000);
    assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
    assert.equal((await fixture.store.get(task.id))?.runs[0]?.outcome, 'ok');
    await fixture.restart();
    assert.equal(fixture.deliveries.length, 1);
  } finally {
    await fixture.close();
  }
});

for (const kind of ['pause', 'delete'] as const) {
  test(`${kind} cancels a waiting fire without cancelling another notification`, async () => {
    const fixture = await schedulerFixture();
    try {
      const waiting = await fixture.create();
      const later = await fixture.create({
        title: 'Later reminder',
        schedule: { kind: 'once', runAt: 31_000 },
      });
      await fixture.start();
      await fixture.tick(11_000);
      const outcome = await fixture.mutate({ kind, taskId: waiting.id });
      assert.equal(outcome.ok, true);
      assert.equal(fixture.timerDelay(), 20_000);
      assert.equal((await fixture.store.listPendingFires()).length, 0);
      fixture.connectProvider();
      await fixture.tick(31_000);
      assert.deepEqual(fixture.deliveries, [{ taskId: later.id, title: 'Later reminder' }]);
      assert.equal((await fixture.store.get(later.id))?.status, 'completed');
      assert.equal(
        (await fixture.store.get(waiting.id))?.status,
        kind === 'pause' ? 'paused' : undefined,
      );
    } finally {
      await fixture.close();
    }
  });
}

test('a waiting fire does not delay another task with an earlier deadline', async () => {
  const fixture = await schedulerFixture();
  try {
    const first = await fixture.create();
    const second = await fixture.create({
      title: 'Second reminder',
      schedule: { kind: 'once', runAt: 13_000 },
    });
    await fixture.start();
    await fixture.tick(11_000);
    assert.equal(fixture.timerDelay(), 2_000);
    await fixture.tick(13_000);
    assert.deepEqual(
      (await fixture.store.listPendingFires()).map((claim) => claim.task.id).sort(),
      [first.id, second.id].sort(),
    );
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(18_000);
    assert.deepEqual(
      fixture.deliveries.map((delivery) => delivery.taskId).sort(),
      [first.id, second.id].sort(),
    );
    assert.equal((await fixture.store.get(first.id))?.fireCount, 1);
    assert.equal((await fixture.store.get(second.id))?.fireCount, 1);
  } finally {
    await fixture.close();
  }
});

test('a waiting task still expires at its earlier expiry deadline without a zero-delay loop', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({ expiresAt: 12_000 });
    await fixture.start();
    await fixture.tick(11_000);
    assert.equal(fixture.timerDelay(), 1_000);
    await fixture.tick(12_000);
    assert.equal((await fixture.store.get(task.id))?.status, 'expired');
    assert.equal((await fixture.store.get(task.id))?.nextFireAt, null);
    assert.equal((await fixture.store.listPendingFires())[0]?.nativeState, 'waiting_for_provider');
    assert.equal(fixture.timerDelay(), 5_000);
  } finally {
    await fixture.close();
  }
});
