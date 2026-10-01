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
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import type {
  ArchiveRetentionDocument,
  ArchiveRetentionDocumentRead,
} from '@maka/storage/archive-retention-store';
import type { ArchiveRetentionCandidate } from '@maka/storage/execution-stores';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  ARCHIVE_RETENTION_FAMILIES_PER_TICK,
  HostArchiveRetentionCoordinator,
} from '../server/archive-retention-coordinator.js';
import type {
  RetentionHoldReason,
  RetentionRemovalOutcome,
  RetentionRemovalPlan,
} from '../server/session-retirement-coordinator.js';

const DAY = 24 * 60 * 60 * 1000;
const CONTEXT: ConnectionContext = {
  hostEpoch: 'retention-test',
  connectionId: 'retention-test-connection',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

interface Task {
  readonly id: string;
  family?: string;
  archivedAt?: number;
  isFlagged?: boolean;
  /** False once restored. */
  isArchived?: boolean;
  /** What the removal path answers once the guard admits the task. */
  outcome?: RetentionRemovalOutcome;
}

function rig(options: { read?: ArchiveRetentionDocumentRead; tasks?: Task[] } = {}) {
  let clock = 1_000 * DAY;
  let read: ArchiveRetentionDocumentRead = options.read ?? { kind: 'absent' };
  const tasks = new Map((options.tasks ?? []).map((task) => [task.id, task]));
  const calls = { list: 0, latest: 0 };
  const writes: ArchiveRetentionDocument[] = [];
  const removed: string[] = [];
  const held: RetentionHoldReason[] = [];
  let newest: number | undefined;
  /** Runs inside a removal admission, before the guard: a mid-sweep change. */
  let beforeGuard: (() => Promise<void>) | undefined;
  const header = (task: Task): SessionHeader =>
    ({
      id: task.id,
      isArchived: task.isArchived ?? true,
      isFlagged: task.isFlagged ?? false,
      ...(task.family ? { revisionRootSessionId: task.family } : {}),
    }) as SessionHeader;
  const order = (task: { archivedAt?: number }) => task.archivedAt ?? -1;
  const retention = new HostArchiveRetentionCoordinator({
    document: {
      read: async () => read,
      write: async (document) => {
        writes.push(document);
        read = { kind: 'valid', document };
      },
    },
    catalog: {
      listArchiveRetentionCandidates: async (query) => {
        calls.list += 1;
        return [...tasks.values()]
          .filter((task) => !task.isFlagged)
          .filter(
            (task) =>
              query.archivedBefore === undefined ||
              task.archivedAt === undefined ||
              task.archivedAt < query.archivedBefore,
          )
          .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
          .filter(
            (task) =>
              !query.after ||
              order(task) > order(query.after) ||
              (order(task) === order(query.after) && task.id > query.after.sessionId),
          )
          .slice(0, query.limit)
          .map(
            (task): ArchiveRetentionCandidate => ({
              header: header(task),
              revision: 1,
              committedAt: 0,
              ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
            }),
          );
      },
      readSessionArchiveTimes: async (sessionIds) =>
        new Map(
          sessionIds.flatMap((id) => {
            const archivedAt = tasks.get(id)?.archivedAt;
            return archivedAt === undefined ? [] : [[id, archivedAt] as const];
          }),
        ),
      readLatestSessionMetadataTime: async () => {
        calls.latest += 1;
        return newest;
      },
    },
    retirement: {
      removeForRetention: async (target, guard) => {
        const task = tasks.get(target.sessionId)!;
        await beforeGuard?.();
        const plan: RetentionRemovalPlan = {
          remove: [{ header: header(task), revision: 1, committedAt: 0 }],
          archiveSessionIds: [],
        };
        const reason = await guard(plan);
        if (reason) {
          held.push(reason);
          return { kind: 'held', reason };
        }
        const outcome = task.outcome ?? { kind: 'removed', bytes: 10 };
        if (outcome.kind === 'removed') {
          removed.push(task.id);
          tasks.delete(task.id);
        }
        return outcome;
      },
    },
    now: () => clock,
    log: () => undefined,
  });
  const query = async (input: { previewDays?: 30 | 60 | 90 } = {}) => {
    const result = await retention.handlers['storage.retention.query'](input, CONTEXT);
    assert.ok(result.ok);
    return result.result;
  };
  const set = async (enabled: boolean, days: 30 | 60 | 90, expectedRevision?: number) => {
    const result = await retention.handlers['storage.retention.set'](
      { expectedRevision: expectedRevision ?? (await query()).revision, enabled, days },
      CONTEXT,
    );
    assert.ok(result.ok);
    return result.result;
  };
  return {
    retention,
    calls,
    writes,
    removed,
    held,
    tasks,
    query,
    set,
    get now() {
      return clock;
    },
    set now(value: number) {
      clock = value;
    },
    set newest(value: number | undefined) {
      newest = value;
    },
    set beforeGuard(value: (() => Promise<void>) | undefined) {
      beforeGuard = value;
    },
  };
}

test('enabling or changing the days restamps enabledAt on the Host clock; disabling clears it', async () => {
  const r = rig();
  assert.deepEqual(await r.query(), { revision: 0, enabled: false, days: 30 });

  const enabled = await r.set(true, 30);
  assert.deepEqual(enabled, {
    kind: 'committed',
    setting: { revision: 1, enabled: true, days: 30, enabledAt: r.now },
  });

  const enabledAt = r.now;
  r.now += 10 * DAY;
  const changed = await r.set(true, 60);
  assert.deepEqual(changed, {
    kind: 'committed',
    setting: { revision: 2, enabled: true, days: 60, enabledAt: enabledAt + 10 * DAY },
  });

  // Setting what is already set is no change and keeps the clock.
  r.now += DAY;
  assert.deepEqual(await r.set(true, 60), changed);
  assert.equal(r.writes.length, 2);

  const disabled = await r.set(false, 60);
  assert.deepEqual(disabled, {
    kind: 'committed',
    setting: { revision: 3, enabled: false, days: 60 },
  });
  assert.equal(r.writes.at(-1)?.enabledAt, undefined);
});

test('a stale revision is rejected without writing', async () => {
  const r = rig();
  await r.set(true, 30);
  const stale = await r.set(false, 30, 0);
  assert.deepEqual(stale, { kind: 'revision_conflict', expectedRevision: 0, actualRevision: 1 });
  assert.equal(r.writes.length, 1);
  assert.equal((await r.query()).enabled, true);
});

test('no SQL runs and nothing is eligible until the policy is older than its days', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  const enabledAt = r.now;

  r.now = enabledAt + 30 * DAY;
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.calls, { list: 0, latest: 0 });

  r.now = enabledAt + 30 * DAY + 1;
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, ['legacy']);
});

test('changing the days restarts the clock, so nothing becomes eligible at once', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 60);
  r.now += 29 * DAY;
  // Shortening to 30 days is not immediate: the clock restarts at the change,
  // so two days later nothing is 30 days old.
  await r.set(true, 30);
  const restartedAt = r.now;
  r.now = restartedAt + 2 * DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  r.now = restartedAt + 30 * DAY + 1;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['legacy']);
});

test('a sweep deletes at most eight families a tick and reports when work remains', async () => {
  const tasks: Task[] = [];
  for (let index = 0; index < 20; index += 1) {
    const id = `task-${String(index).padStart(2, '0')}`;
    tasks.push({ id, archivedAt: index });
    // A revision of the first task: one family, tried once.
    if (index === 0) tasks.push({ id: 'task-00-revision', family: id, archivedAt: index });
  }
  const r = rig({ tasks });
  await r.set(true, 30);
  r.now += 31 * DAY;

  assert.equal(await r.retention.sweep(), true);
  assert.equal(r.removed.length, ARCHIVE_RETENTION_FAMILIES_PER_TICK);
  assert.equal(await r.retention.sweep(), true);
  assert.equal(r.removed.length, 16);
  assert.equal(await r.retention.sweep(), false);
  // The revision shared its family with task-00 and was not tried on its own.
  assert.deepEqual(r.removed.length, 20);
  assert.ok(!r.removed.includes('task-00-revision'));
});

test('a policy change between the candidate read and the admission keeps the task', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  r.now += 31 * DAY;
  r.beforeGuard = async () => {
    r.beforeGuard = undefined;
    await r.set(true, 60);
  };
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.held, ['ineligible']);
});

test('a restore, re-archive or pin between the candidate read and the admission keeps the task', async () => {
  const r = rig({ tasks: [{ id: 'pinned' }, { id: 'rearchived' }, { id: 'restored' }] });
  await r.set(true, 30);
  const enabledAt = r.now;
  r.now += 31 * DAY;
  r.beforeGuard = async () => {
    r.tasks.get('pinned')!.isFlagged = true;
    // Archived again exactly the period ago: not longer than it.
    r.tasks.get('rearchived')!.archivedAt = enabledAt + DAY;
    r.tasks.get('restored')!.isArchived = false;
  };
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.held, ['ineligible', 'ineligible', 'ineligible']);
});

test('a wall clock behind the high-water mark pauses the sweep once, with no deletions', async () => {
  const r = rig({ tasks: [] });
  await r.set(true, 30);
  r.now += 40 * DAY;
  await r.retention.sweep();
  const observed = r.now;
  r.tasks.set('legacy', { id: 'legacy' });

  r.now = observed - 1;
  const lists = r.calls.list;
  assert.equal(await r.retention.sweep(), false);
  assert.equal(r.calls.list, lists);
  assert.deepEqual(r.removed, []);
  assert.deepEqual((await r.query()).lastSweep, {
    at: observed - 1,
    deleted: 0,
    skippedBusy: 0,
    needsReview: 0,
    failed: 0,
    paused: true,
  });
  const writes = r.writes.length;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes, 'a clock that stays behind writes nothing further');

  // Once the clock catches up, the sweep resumes and clears the pause.
  r.now = observed + 1;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['legacy']);
  assert.equal((await r.query()).lastSweep?.paused, undefined);
});

test('a wall clock behind the newest recorded metadata time pauses the sweep', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  r.now += 31 * DAY;
  r.newest = r.now + 1;
  assert.equal(await r.retention.sweep(), false);
  assert.equal(r.calls.list, 0);
  assert.deepEqual(r.removed, []);
  assert.equal((await r.query()).lastSweep?.paused, true);
});

test('a document that cannot be validated is treated as disabled until it is set again', async () => {
  const r = rig({
    read: { kind: 'invalid', reason: 'unsupported version' },
    tasks: [{ id: 'legacy' }],
  });
  assert.deepEqual(await r.query(), { revision: 0, enabled: false, days: 30 });
  r.now += 365 * DAY;
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.calls, { list: 0, latest: 0 });
  assert.deepEqual(r.removed, []);
  assert.equal((await r.set(true, 30)).kind, 'committed');
});

test('the document is written only when a sweep changed something', async () => {
  const r = rig({ tasks: [] });
  await r.set(true, 30);
  r.now += 31 * DAY;
  const writes = r.writes.length;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes, 'an empty sweep writes nothing');

  r.tasks.set('busy', { id: 'busy', outcome: { kind: 'busy' } });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 1);
  assert.deepEqual((await r.query()).lastSweep, {
    at: r.now,
    deleted: 0,
    skippedBusy: 1,
    needsReview: 0,
    failed: 0,
  });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 1, 'the same result is not written again');

  r.tasks.set('legacy', { id: 'legacy', outcome: { kind: 'removed', bytes: 40 } });
  r.tasks.set('unmeasured', { id: 'unmeasured', outcome: { kind: 'removed' } });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 2);
  const result = await r.query();
  assert.equal(result.lastSweep?.deleted, 2);
  // One deletion could not be measured, so no estimate is claimed.
  assert.deepEqual(result.lastDeletion, { at: r.now, count: 2 });
});

test('the preview counts current candidates by family and says when the first is eligible', async () => {
  const r = rig({
    tasks: [
      { id: 'legacy' },
      { id: 'revision', family: 'legacy' },
      // Archived long before enablement: its clock still starts at enablement.
      { id: 'early', archivedAt: 1_000 * DAY - 100 * DAY },
      { id: 'late', archivedAt: 1_000 * DAY + 5 * DAY },
    ],
  });
  const now = r.now;
  // Disabled: what enabling now would do. Every clock starts now at the earliest.
  assert.deepEqual((await r.query({ previewDays: 60 })).preview, {
    count: 3,
    eligibleAt: now + 60 * DAY,
  });
  assert.equal((await r.query()).preview, undefined);

  await r.set(true, 30);
  assert.deepEqual((await r.query()).preview, { count: 3, eligibleAt: now + 30 * DAY });
  r.tasks.clear();
  assert.deepEqual((await r.query()).preview, { count: 0 });
});
