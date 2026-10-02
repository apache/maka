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
import type {
  ArchiveRetentionCandidateRow,
  SessionCatalogRecord,
} from '@maka/storage/execution-stores';
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
  /** Metadata that no longer decodes. */
  undecodable?: boolean;
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
  /** The last guard the removal path ran, with the plan it ran on. */
  let lastGuard: { run: () => Promise<RetentionHoldReason | undefined> } | undefined;
  const header = (task: Task): SessionHeader =>
    ({
      id: task.id,
      isArchived: task.isArchived ?? true,
      isFlagged: task.isFlagged ?? false,
      ...(task.family ? { revisionRootSessionId: task.family } : {}),
    }) as SessionHeader;
  const order = (task: { archivedAt?: number }) => task.archivedAt ?? -1;
  const create = () =>
    new HostArchiveRetentionCoordinator({
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
            .map((task): ArchiveRetentionCandidateRow => {
              const position = task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt };
              return task.undecodable
                ? { undecodable: true, sessionId: task.id, ...position }
                : { header: header(task), revision: 1, committedAt: 0, ...position };
            });
        },
        countArchiveRetentionCandidates: async (enabledAt) => {
          const starts = new Map<string, number>();
          for (const task of tasks.values()) {
            if (task.isFlagged) continue;
            const start = Math.max(task.archivedAt ?? enabledAt, enabledAt);
            const family = task.family ?? task.id;
            starts.set(family, Math.max(starts.get(family) ?? start, start));
          }
          return starts.size === 0
            ? { families: 0 }
            : { families: starts.size, firstStart: Math.min(...starts.values()) };
        },
        readCatalogRecord: async (sessionId) =>
          ({
            summary: { archivedAt: tasks.get(sessionId)?.archivedAt },
          }) as unknown as SessionCatalogRecord,
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
            worktreeCount: 0,
          };
          lastGuard = { run: () => guard(plan) };
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
  let retention = create();
  const query = async () => {
    const result = await retention.handlers['storage.retention.query']({}, CONTEXT);
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
  /**
   * Moves the clock as a Host that keeps running sees it: a sweep at least
   * every six days on the way, so no step reads as a forward clock jump.
   */
  const advanceTo = async (to: number) => {
    while (to - clock > 6 * DAY) {
      clock += 6 * DAY;
      await retention.sweep();
    }
    clock = to;
  };
  return {
    get retention() {
      return retention;
    },
    /** A new Host process over the same State Root and catalog. */
    restart() {
      retention = create();
    },
    advanceTo,
    advance: (ms: number) => advanceTo(clock + ms),
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
    get lastGuard() {
      return lastGuard;
    },
  };
}

test('enabling or changing the days restamps enabledAt on the Host clock; disabling clears it', async () => {
  const r = rig();
  assert.deepEqual(await r.query(), {
    revision: 0,
    enabled: false,
    days: 30,
    preview: { count: 0 },
  });

  const enabled = await r.set(true, 30);
  assert.deepEqual(enabled, {
    kind: 'committed',
    setting: { revision: 1, enabled: true, days: 30, enabledAt: r.now },
  });

  const enabledAt = r.now;
  await r.advance(10 * DAY);
  const changed = await r.set(true, 60);
  assert.deepEqual(changed, {
    kind: 'committed',
    setting: { revision: 2, enabled: true, days: 60, enabledAt: enabledAt + 10 * DAY },
  });

  // Setting what is already set is no change and keeps the clock.
  r.now += DAY;
  const writesAfterChange = r.writes.length;
  assert.deepEqual(await r.set(true, 60), changed);
  assert.equal(r.writes.length, writesAfterChange);

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

test('no candidate is read and nothing is eligible until the policy is older than its days', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  const enabledAt = r.now;

  const before = { ...r.calls };
  await r.advanceTo(enabledAt + 30 * DAY);
  assert.equal(await r.retention.sweep(), false);
  assert.equal(r.calls.list, before.list);

  r.now = enabledAt + 30 * DAY + 1;
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, ['legacy']);
});

test('changing the days restarts the clock, so nothing becomes eligible at once', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 60);
  await r.advance(29 * DAY);
  // Shortening to 30 days is not immediate: the clock restarts at the change,
  // so two days later nothing is 30 days old.
  await r.set(true, 30);
  const restartedAt = r.now;
  r.now = restartedAt + 2 * DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  await r.advanceTo(restartedAt + 30 * DAY + 1);
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
  await r.advance(31 * DAY);

  assert.equal(await r.retention.sweep(), true);
  assert.equal(r.removed.length, ARCHIVE_RETENTION_FAMILIES_PER_TICK);
  assert.equal(await r.retention.sweep(), true);
  assert.equal(r.removed.length, 16);
  assert.equal(await r.retention.sweep(), false);
  // The revision shared its family with task-00 and was not tried on its own.
  assert.deepEqual(r.removed.length, 20);
  assert.ok(!r.removed.includes('task-00-revision'));
});

test('a setting change pending at the admission keeps the task and waits for the tick', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }, { id: 'later' }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  let changed: Promise<unknown> | undefined;
  r.beforeGuard = async () => {
    r.beforeGuard = undefined;
    // Started, not awaited: it waits for this tick, which must not delete.
    changed = r.retention.handlers['storage.retention.set'](
      { expectedRevision: 1, enabled: true, days: 60 },
      CONTEXT,
    );
  };
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.held, ['ineligible']);
  // The tick stopped before the next family.
  assert.equal(r.tasks.has('later'), true);
  assert.deepEqual(await changed, {
    ok: true,
    result: {
      kind: 'committed',
      setting: { revision: 2, enabled: true, days: 60, enabledAt: r.now },
    },
  });
});

test('a guard run after the setting moved on holds the task by its revision alone', async () => {
  const r = rig({ tasks: [{ id: 'legacy', outcome: { kind: 'skipped' } }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  await r.retention.sweep();
  const guard = r.lastGuard!;
  // Same days, so only the revision tells the two settings apart.
  await r.set(false, 30);
  await r.set(true, 30);
  await r.advance(31 * DAY);
  assert.equal(await guard.run(), 'ineligible');
});

test('a clock that goes back between the candidate read and the admission keeps the task', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  r.beforeGuard = async () => {
    // Still past every deadline, but behind a time this sweep already saw.
    r.now -= 1;
  };
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.held, ['ineligible']);
});

test('draining stops a sweep before the next family', async () => {
  const r = rig({ tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  r.beforeGuard = async () => {
    r.beforeGuard = undefined;
    r.retention.beginDrain();
  };
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, ['a']);
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, ['a']);
});

test('a row that no longer decodes is counted as failed and passed over', async () => {
  const r = rig({
    tasks: [
      { id: 'a-bad', archivedAt: 1, undecodable: true },
      { id: 'b-good', archivedAt: 2 },
    ],
  });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, ['b-good']);
  assert.equal((await r.query()).lastSweep?.failed, 1);
});

test('a setting change clears a recorded pause and never backdates enabledAt', async () => {
  const r = rig({ tasks: [] });
  await r.set(true, 30);
  await r.advance(40 * DAY);
  await r.retention.sweep();
  const observed = r.now;
  r.now = observed - 10;
  await r.retention.sweep();
  assert.equal((await r.query()).lastSweep?.paused, true);

  // Behind what the Host saw: the new clock starts where the Host already was.
  const changed = await r.set(true, 60);
  assert.equal(changed.kind === 'committed' && changed.setting.enabledAt, observed);
  assert.equal((await r.query()).lastSweep?.paused, undefined);

  // Behind the newest metadata time: the clock starts there.
  r.newest = observed + 500;
  const enabled = await r.set(true, 90);
  assert.equal(enabled.kind === 'committed' && enabled.setting.enabledAt, observed + 500);
});

test('a restore, re-archive or pin between the candidate read and the admission keeps the task', async () => {
  const r = rig({ tasks: [{ id: 'pinned' }, { id: 'rearchived' }, { id: 'restored' }] });
  await r.set(true, 30);
  const enabledAt = r.now;
  await r.advance(31 * DAY);
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
  await r.advance(40 * DAY);
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
  await r.advance(31 * DAY);
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
  assert.deepEqual(await r.query(), {
    revision: 0,
    enabled: false,
    days: 30,
    preview: { count: 1 },
  });
  await r.advance(365 * DAY);
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.calls, { list: 0, latest: 0 });
  assert.deepEqual(r.removed, []);
  assert.equal((await r.set(true, 30)).kind, 'committed');
});

test('the document records a daily heartbeat and sweep results without duplicate writes', async () => {
  const r = rig({ tasks: [] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  const writes = r.writes.length;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 1, 'an empty sweep records the heartbeat');

  r.tasks.set('busy', { id: 'busy', outcome: { kind: 'busy' } });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 2);
  assert.deepEqual((await r.query()).lastSweep, {
    at: r.now,
    deleted: 0,
    skippedBusy: 1,
    needsReview: 0,
    failed: 0,
  });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 3, 'the next heartbeat is written once');

  r.tasks.set('legacy', { id: 'legacy', outcome: { kind: 'removed', bytes: 40 } });
  r.tasks.set('unmeasured', { id: 'unmeasured', outcome: { kind: 'removed' } });
  r.now += DAY;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 4);
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
      { id: 'early', archivedAt: 1_000 * DAY - 100 * DAY },
      { id: 'late', archivedAt: 1_000 * DAY + 5 * DAY },
    ],
  });
  const now = r.now;
  // Disabled: a count, never a date.
  assert.deepEqual((await r.query()).preview, { count: 3 });

  await r.set(true, 30);
  assert.deepEqual((await r.query()).preview, { count: 3, eligibleAt: now + 30 * DAY });
  r.tasks.clear();
  assert.deepEqual((await r.query()).preview, { count: 0 });
});

test('a forward clock jump holds deletions for a day, then they resume', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(29 * DAY);
  await r.retention.sweep();
  const before = r.now;
  // The clock leaps ahead past every deadline at once.
  r.now += 10 * DAY;
  assert.equal(await r.retention.sweep(), false);
  assert.deepEqual(r.removed, []);
  assert.deepEqual((await r.query()).hold, {
    since: before,
    detectedAt: r.now,
    until: r.now + DAY,
  });

  const until = r.now + DAY;
  r.now = until - 1;
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  r.now = until;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['legacy']);
  assert.equal((await r.query()).hold, undefined);
});

test('a further jump while held arms the hold again', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(29 * DAY);
  r.now += 10 * DAY;
  await r.retention.sweep();
  const first = r.now;
  r.now += 8 * DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, []);
  assert.deepEqual((await r.query()).hold, {
    since: first,
    detectedAt: r.now,
    until: r.now + DAY,
  });
});

test('an advance within the threshold never holds', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(25 * DAY);
  await r.retention.sweep();
  // Exactly the threshold is not more than it.
  r.now += 7 * DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['legacy']);
  assert.equal((await r.query()).hold, undefined);
});

test('a Host back after twenty days offline holds for a day and then cleans up', async () => {
  const r = rig({ tasks: [{ id: 'first' }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['first']);
  const lastRan = r.now;
  r.tasks.set('second', { id: 'second' });

  r.restart();
  r.now = lastRan + 20 * DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['first']);
  assert.equal((await r.query()).hold?.since, lastRan);
  r.now += DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['first', 'second']);
});

test('after a restart, recent metadata writes say the Host was running', async () => {
  const r = rig({ tasks: [{ id: 'first' }] });
  await r.set(true, 30);
  await r.advance(31 * DAY);
  await r.retention.sweep();
  const lastRan = r.now;
  r.tasks.set('second', { id: 'second' });

  r.restart();
  r.now = lastRan + 20 * DAY;
  r.newest = r.now - DAY;
  await r.retention.sweep();
  assert.deepEqual(r.removed, ['first', 'second']);
  assert.equal((await r.query()).hold, undefined);
});

test('a running Host records a heartbeat so an idle restart does not hold', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(6 * DAY);
  await r.retention.sweep();
  const heartbeat = r.writes.at(-1)?.latest?.observedAt;
  assert.equal(heartbeat, r.now);

  r.restart();
  r.now += 2 * DAY;
  await r.retention.sweep();
  assert.equal((await r.query()).hold, undefined);
});

test('a setting change clears a hold', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(29 * DAY);
  r.now += 10 * DAY;
  await r.retention.sweep();
  assert.ok((await r.query()).hold);
  await r.set(true, 60);
  assert.equal((await r.query()).hold, undefined);
});

test('a restart before the deadline, with recent metadata, does not hold', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(9 * DAY);
  await r.retention.sweep();
  r.restart();
  r.now += 60 * 60 * 1000;
  r.newest = r.now - 60 * 1000;
  await r.retention.sweep();
  assert.equal((await r.query()).hold, undefined);
});

test('a fresh process still holds after a genuine forward jump', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  const enabledAt = r.now;
  await r.advance(2 * DAY);
  await r.retention.sweep();
  r.restart();
  r.newest = enabledAt + 2 * DAY;
  r.now = enabledAt + 12 * DAY;
  await r.retention.sweep();
  assert.deepEqual((await r.query()).hold, {
    since: enabledAt + 2 * DAY,
    detectedAt: r.now,
    until: r.now + DAY,
  });
});

test('a hold expires before the deadline: cleared once and never reported after its day', async () => {
  const r = rig({ tasks: [{ id: 'legacy' }] });
  await r.set(true, 30);
  await r.advance(DAY);
  await r.retention.sweep();
  r.now += 8 * DAY;
  await r.retention.sweep();
  const hold = (await r.query()).hold;
  assert.ok(hold);
  r.now = hold.until;
  // Reported as over even before a sweep writes it away.
  assert.equal((await r.query()).hold, undefined);
  const writes = r.writes.length;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 1);
  assert.equal(r.writes.at(-1)?.latest?.hold, undefined);
  r.now += 1;
  await r.retention.sweep();
  assert.equal(r.writes.length, writes + 1, 'cleared once');
  assert.deepEqual(r.removed, [], 'still before the deadline');
});
