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
import { acquireOperationalStateDatabase } from '@maka/storage/operational-state-store';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import type { ScheduledTaskMutateInput } from '../protocol/index.js';
import {
  HostScheduledTaskCoordinator,
  type HostScheduledTaskCoordinatorInput,
} from '../server/scheduled-task-coordinator.js';

const PROVIDER_UNAVAILABLE = {
  ok: false,
  error: {
    code: 'operation_conflict',
    message: 'ScheduledTask native delivery is waiting for a Desktop provider',
  },
} as const;
const EXPIRED_BEFORE_DELIVERY = '定时任务已过期，通知没有送达。';
const CORRUPT_TASK_ID = 'corrupt-scheduled-task-row';

async function schedulerFixture() {
  const base = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-retry-'));
  const root = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(root);
  assert.ok(owner);
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  let now = 1_000;
  let providerAvailable = false;
  let afterProviderCheck: (() => void) | undefined;
  let drainAllowed = false;
  let drainRequests = 0;
  let timer: { callback: () => void; delayMs: number } | undefined;
  const deliveries: Record<string, unknown>[] = [];
  const deliveryMethods: string[] = [];
  const writeDatabase = (sql: string, taskId: string) => {
    const lease = acquireOperationalStateDatabase(root.canonicalPath);
    try {
      lease.transaction('write', () => lease.database.prepare(sql).run(taskId));
    } finally {
      lease.close();
    }
  };
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
      hasWorkspaceService: () => {
        const hook = afterProviderCheck;
        afterProviderCheck = undefined;
        hook?.();
        return providerAvailable;
      },
      callWorkspaceService: async (request) => {
        deliveries.push(request.input);
        deliveryMethods.push(request.method);
        return {};
      },
    },
    createSession: async () => assert.fail('Notification must not create a Session'),
    changes: { publish: () => {} },
    acquireResidency: () => ({ release: () => {} }),
    requestDrain: () => {
      drainRequests += 1;
      if (!drainAllowed) assert.fail('Scheduler must not drain');
      coordinator.beginDrain();
    },
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
    deliveryMethods,
    mutate,
    setNow: (at: number) => {
      now = at;
    },
    connectProvider: () => {
      providerAvailable = true;
    },
    allowDrain: () => {
      drainAllowed = true;
    },
    drainRequests: () => drainRequests,
    /** The waiting claim still persists, but catalog reads fail after the next provider check. */
    corruptCatalogAfterProviderCheck: () => {
      afterProviderCheck = () =>
        writeDatabase(
          `INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
           VALUES (?, 0, 0, '{}')`,
          CORRUPT_TASK_ID,
        );
    },
    repairCatalog: () =>
      writeDatabase('DELETE FROM workflow_scheduled_tasks WHERE task_id = ?', CORRUPT_TASK_ID),
    /** Create rejects platforms without bot delivery, so only a stored row can hold one. */
    storeBotPlatform: (taskId: string, platform: 'feishu' | 'wecom') =>
      writeDatabase(
        `UPDATE workflow_scheduled_tasks
         SET record_json = json_set(record_json, '$.effect.platform', '${platform}')
         WHERE task_id = ?`,
        taskId,
      ),
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
      assert.deepEqual(outcome, PROVIDER_UNAVAILABLE);
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

test('manual trigger of a recurring notification waits, then resumes at its next regular slot', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({
      schedule: { kind: 'interval', everySeconds: 60, startAt: 61_000 },
    });
    await fixture.start();
    assert.equal(fixture.timerDelay(), 60_000);
    fixture.setNow(21_000);
    assert.deepEqual(
      await fixture.mutate({ kind: 'trigger_now', taskId: task.id }),
      PROVIDER_UNAVAILABLE,
    );
    // The wait spans the regular 61_000 slot, which neither adds a claim nor
    // shortens the provider retry.
    for (let at = 26_000; at <= 66_000; at += 5_000) {
      assert.equal(fixture.timerDelay(), 5_000);
      await fixture.tick(at);
      assert.deepEqual(
        (await fixture.store.listPendingFires()).map((claim) => [
          claim.scheduledFor,
          claim.nativeState,
        ]),
        [[21_000, 'waiting_for_provider']],
      );
    }
    fixture.connectProvider();
    await fixture.tick(71_000);
    assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
    const delivered = await fixture.store.get(task.id);
    assert.equal(delivered?.status, 'active');
    assert.equal(delivered?.fireCount, 1);
    assert.equal(delivered?.runs[0]?.outcome, 'ok');
    assert.equal(delivered?.lastFireAt, 71_000);
    assert.equal(delivered?.nextFireAt, 121_000);
    assert.deepEqual(await fixture.store.listPendingFires(), []);
    assert.equal(fixture.timerDelay(), 50_000);
  } finally {
    await fixture.close();
  }
});

test('due bot notifications wait for a provider and deliver once through the bot method', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({
      effect: { kind: 'notify', channel: 'bot', platform: 'telegram', chatId: 'chat-1' },
    });
    await fixture.start();
    await fixture.tick(11_000);
    assert.equal((await fixture.store.listPendingFires())[0]?.nativeState, 'waiting_for_provider');
    assert.equal(fixture.timerDelay(), 5_000);
    await fixture.tick(16_000);
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(21_000);
    assert.deepEqual(fixture.deliveryMethods, ['notify_bot']);
    assert.deepEqual(fixture.deliveries, [
      {
        taskId: task.id,
        title: 'Reminder',
        body: 'Review the report',
        platform: 'telegram',
        chatId: 'chat-1',
      },
    ]);
    const completed = await fixture.store.get(task.id);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.runs[0]?.outcome, 'ok');
    assert.equal(completed?.runs[0]?.message, '已投递到 Telegram。');
    assert.equal(fixture.timerDelay(), undefined);
    await fixture.restart();
    assert.equal(fixture.deliveries.length, 1);
  } finally {
    await fixture.close();
  }
});

test('a stored bot notification for a non-delivery platform is blocked instead of waiting', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({
      effect: { kind: 'notify', channel: 'bot', platform: 'telegram', chatId: 'chat-1' },
    });
    fixture.storeBotPlatform(task.id, 'feishu');
    await fixture.start();
    await fixture.tick(11_000);
    const blocked = await fixture.store.get(task.id);
    assert.equal(blocked?.status, 'completed');
    assert.deepEqual(
      blocked?.runs.map(({ outcome, message }) => ({ outcome, message })),
      [{ outcome: 'blocked', message: '飞书 当前不是可投递目标。' }],
    );
    assert.deepEqual(await fixture.store.listPendingFires(), []);
    assert.equal(fixture.timerDelay(), undefined);
    fixture.connectProvider();
    await fixture.restart();
    assert.deepEqual(fixture.deliveries, []);
  } finally {
    await fixture.close();
  }
});

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

test('trigger now reports the waiting provider even when its retry schedule cannot be read', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({ schedule: { kind: 'once', runAt: 3_601_000 } });
    await fixture.start();
    fixture.allowDrain();
    fixture.corruptCatalogAfterProviderCheck();
    const outcome = await fixture.mutate({ kind: 'trigger_now', taskId: task.id });
    assert.deepEqual(outcome, PROVIDER_UNAVAILABLE);
    // The Store failure drains this Host. Recovery in the next one retries the
    // durable claim, so the reminder is neither lost nor delivered twice.
    assert.equal(fixture.drainRequests(), 1);
    fixture.repairCatalog();
    assert.equal((await fixture.store.listPendingFires())[0]?.nativeState, 'waiting_for_provider');
    await fixture.restart();
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(6_000);
    assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
    assert.equal((await fixture.store.get(task.id))?.fireCount, 1);
    assert.equal(fixture.drainRequests(), 1);
  } finally {
    await fixture.close();
  }
});

for (const schedule of [
  { kind: 'once', runAt: 11_000 },
  { kind: 'interval', everySeconds: 10, startAt: 11_000 },
] as const) {
  test(`${schedule.kind} notification still waiting at expiry is blocked, not delivered late`, async () => {
    const fixture = await schedulerFixture();
    try {
      const task = await fixture.create({ schedule, expiresAt: 12_000 });
      await fixture.start();
      await fixture.tick(11_000);
      assert.equal(fixture.timerDelay(), 1_000);
      await fixture.tick(12_000);
      const blocked = await fixture.store.get(task.id);
      // Settling consumes the fire: a one-shot task completes, a recurring one
      // stays expired. Either way the poll stops and nothing is delivered.
      assert.equal(blocked?.status, schedule.kind === 'once' ? 'completed' : 'expired');
      assert.equal(blocked?.nextFireAt, null);
      assert.equal(blocked?.fireCount, 1);
      assert.deepEqual(
        blocked?.runs.map(({ at, outcome, message }) => ({ at, outcome, message })),
        [{ at: 12_000, outcome: 'blocked', message: EXPIRED_BEFORE_DELIVERY }],
      );
      assert.deepEqual(await fixture.store.listPendingFires(), []);
      assert.equal(fixture.timerDelay(), undefined);
      fixture.connectProvider();
      await fixture.restart();
      assert.deepEqual(fixture.deliveries, []);
      assert.equal(fixture.timerDelay(), undefined);
    } finally {
      await fixture.close();
    }
  });
}

test('recovery blocks a waiting notification whose task expired while the Host was stopped', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({ expiresAt: 12_000 });
    await fixture.start();
    await fixture.tick(11_000);
    assert.equal((await fixture.store.listPendingFires())[0]?.nativeState, 'waiting_for_provider');
    fixture.setNow(60_000);
    fixture.connectProvider();
    await fixture.restart();
    assert.deepEqual(fixture.deliveries, []);
    assert.deepEqual(
      (await fixture.store.get(task.id))?.runs.map(({ at, outcome }) => ({ at, outcome })),
      [{ at: 60_000, outcome: 'blocked' }],
    );
    assert.deepEqual(await fixture.store.listPendingFires(), []);
    assert.equal(fixture.timerDelay(), undefined);
  } finally {
    await fixture.close();
  }
});

for (const edit of [
  { change: 'shortened', from: 60_000, to: 25_000 },
  { change: 'added', from: null, to: 25_000 },
  { change: 'extended', from: 14_000, to: 60_000 },
] as const) {
  test(`expiry ${edit.change} during a provider wait replaces the waiting fire and its snapshot`, async () => {
    const fixture = await schedulerFixture();
    try {
      const task = await fixture.create({
        schedule: { kind: 'interval', everySeconds: 10, startAt: 11_000 },
        expiresAt: edit.from,
      });
      await fixture.start();
      await fixture.tick(11_000);
      assert.equal((await fixture.store.listPendingFires())[0]?.task.expiresAt, edit.from);
      fixture.setNow(13_000);
      const outcome = await fixture.mutate({
        kind: 'update',
        taskId: task.id,
        patch: { expiresAt: edit.to },
      });
      assert.equal(outcome.ok, true);
      // The Store rejects task edits while a claim exists, so the edit first
      // cancels the waiting fire. No claim is left holding the old expiry.
      assert.deepEqual(await fixture.store.listPendingFires(), []);
      assert.equal((await fixture.store.get(task.id))?.nextFireAt, 21_000);
      await fixture.tick(21_000);
      assert.equal((await fixture.store.listPendingFires())[0]?.task.expiresAt, edit.to);
      if (edit.change === 'extended') {
        fixture.connectProvider();
        await fixture.tick(26_000);
        assert.deepEqual(fixture.deliveries, [{ taskId: task.id, title: 'Reminder' }]);
        const delivered = await fixture.store.get(task.id);
        assert.equal(delivered?.status, 'active');
        assert.equal(delivered?.runs[0]?.outcome, 'ok');
        assert.equal(delivered?.nextFireAt, 31_000);
      } else {
        assert.equal(fixture.timerDelay(), 4_000);
        await fixture.tick(25_000);
        const blocked = await fixture.store.get(task.id);
        assert.equal(blocked?.status, 'expired');
        assert.deepEqual(
          blocked?.runs.map(({ at, outcome }) => ({ at, outcome })),
          [{ at: 25_000, outcome: 'blocked' }],
        );
        assert.deepEqual(await fixture.store.listPendingFires(), []);
        fixture.connectProvider();
        await fixture.restart();
        assert.deepEqual(fixture.deliveries, []);
      }
    } finally {
      await fixture.close();
    }
  });
}

test('a recurring notification delivered late resumes at its next slot without catching up', async () => {
  const fixture = await schedulerFixture();
  try {
    const task = await fixture.create({
      schedule: { kind: 'interval', everySeconds: 10, startAt: 11_000 },
    });
    await fixture.start();
    await fixture.tick(11_000);
    await fixture.tick(16_000);
    // The 21_000 slot passes while the 11_000 fire still waits; it adds no claim.
    await fixture.tick(21_000);
    const waiting = await fixture.store.listPendingFires();
    assert.deepEqual(
      waiting.map((claim) => [claim.scheduledFor, claim.nativeState]),
      [[11_000, 'waiting_for_provider']],
    );
    assert.equal(fixture.timerDelay(), 5_000);
    fixture.connectProvider();
    await fixture.tick(26_000);
    assert.equal(fixture.deliveries.length, 1);
    const delivered = await fixture.store.get(task.id);
    assert.equal(delivered?.status, 'active');
    assert.equal(delivered?.fireCount, 1);
    assert.equal(delivered?.lastFireAt, 26_000);
    assert.equal(delivered?.nextFireAt, 31_000);
    assert.deepEqual(await fixture.store.listPendingFires(), []);
    await fixture.tick(31_000);
    assert.equal(fixture.deliveries.length, 2);
    assert.equal((await fixture.store.get(task.id))?.nextFireAt, 41_000);
    assert.equal(fixture.timerDelay(), 10_000);
  } finally {
    await fixture.close();
  }
});
