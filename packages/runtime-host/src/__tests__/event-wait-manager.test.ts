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
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EVENT_WAIT_LIMITS,
  eventWaitDeliveryKey,
  type EventWaitRecord,
} from '@maka/core/event-wait';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { ExecutionPersistenceProvider } from '@maka/storage/execution-persistence-provider';
import { createMemoryExecutionPersistenceProvider } from '@maka/storage/test-only/memory-execution-persistence';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
} from '@maka/storage/root-authority';
import {
  EventWaitAdapterRegistry,
  type EventWaitSourceAdapter,
  type EventWaitObservationAccess,
  type EventWaitObservationResult,
  type EventWaitReadContext,
} from '../server/event-wait-adapter.js';
import {
  HostEventWaitManager,
  type EventWaitClock,
  type HostEventWaitManagerOptions,
} from '../server/event-wait-manager.js';

async function settle() {
  // Yield to I/O, but do not treat a fixed number of turns as a completion barrier.
  // Observe the expected durable state before asserting completion or advancing past it.
  for (let n = 0; n < 40; n++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function eventually(check: () => Promise<boolean> | boolean) {
  // Host I/O needs wall-clock time; immediate turns can exhaust before it completes.
  // Keep the injected observation clock fixed so timeout/Retry-After assertions remain exact.
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Condition did not settle without advancing the observation clock');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Clock implements EventWaitClock {
  time = 1_000;
  id = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delay, callback });
    return () => {
      this.timers.delete(id);
    };
  };
  async advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      await next[1].callback();
      await settle();
    }
    this.time = target;
    await settle();
  }
}
test('eventually waits for delayed host work without advancing the observation clock', async () => {
  const clock = new Clock();
  let observationTimerRan = false;
  clock.schedule(() => {
    observationTimerRan = true;
  }, 1);
  let completed = false;
  const work = delay(200).then(() => {
    completed = true;
  });
  try {
    await eventually(() => completed);
    assert.equal(clock.now(), 1_000);
    assert.equal(observationTimerRan, false);
    assert.equal(clock.timers.size, 1);
  } finally {
    await work;
  }
});

const satisfied = (key = 'event-1'): EventWaitObservationResult => ({
  kind: 'satisfied',
  receiptKey: key,
  eventKey: key,
  evidenceRefs: ['maka://test/evidence'],
});
class Source implements EventWaitSourceAdapter {
  providerId = 'fake';
  resourceType = 'task';
  conditionType = 'terminal';
  conditionVersion = 1;
  reconciliation: EventWaitSourceAdapter['reconciliation'] = 'snapshot';
  callbacks = new Map<string, () => void>();
  calls: EventWaitReadContext[] = [];
  closes = 0;
  onSubscribe?: (input: EventWaitReadContext) => void;
  behavior: (input: EventWaitReadContext) => Promise<EventWaitObservationResult> = async () => ({
    kind: 'pending',
  });
  validate(wait: EventWaitRecord) {
    if (wait.condition.parameters.invalid) throw new Error('Invalid parameters');
  }
  async read(input: EventWaitReadContext) {
    this.calls.push(input);
    return this.behavior(input);
  }
  async subscribe(input: EventWaitReadContext, changed: () => void) {
    this.callbacks.set(input.wait.waitId, changed);
    this.onSubscribe?.(input);
    return {
      close: () => {
        this.closes++;
        this.callbacks.delete(input.wait.waitId);
      },
    };
  }
  notify(waitId: string) {
    this.callbacks.get(waitId)?.();
  }
}
const policy = {
  scanIntervalMs: 10,
  minIntervalMs: 20,
  pollIntervalMs: 100,
  maxBackoffMs: 400,
  readTimeoutMs: 80,
  closeTimeoutMs: 20,
  maxAttempts: 10,
  maxLifetimeMs: 20_000,
  maxConcurrent: 2,
  maxPerSource: 1,
  maxSubscriptions: 4,
  jitterRatio: 0,
};

async function fixture(
  t: TestContext,
  backend: 'Local' | 'Memory' = 'Memory',
  custom?: ExecutionPersistenceProvider,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-wait-observation-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const provider =
    custom ?? (backend === 'Memory' ? createMemoryExecutionPersistenceProvider() : undefined);
  let stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
  const clock = new Clock();
  const errors: unknown[] = [];
  const managers: HostEventWaitManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(root, { recursive: true, force: true });
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true });
  });
  return {
    clock,
    errors,
    owner,
    get stores() {
      return stores;
    },
    async reopen() {
      for (const manager of managers) await manager.close();
      await stores.sessionStore.close?.();
      stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
    },
    async wait(
      waitId = 'wait-1',
      patch: Partial<Extract<EventWaitRecord, { status: 'waiting' }>> = {},
    ) {
      const session = await stores.sessionStore.create({
        cwd: root,
        name: 'Wait test',
        model: 'test',
        llmConnectionSlug: 'test',
        permissionMode: 'ask',
      });
      const record: EventWaitRecord = {
        schemaVersion: 1,
        waitId,
        sessionId: session.id,
        goalControlLease: { goalId: 'goal-1', generation: 0 },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'call-1',
        resource: {
          providerId: 'fake',
          connectionId: null,
          resourceType: 'task',
          resourceId: waitId,
        },
        condition: { typeId: 'terminal', version: 1, parameters: {} },
        deliveryKey: eventWaitDeliveryKey(waitId),
        createdAt: clock.now(),
        updatedAt: clock.now(),
        deadlineAt: clock.now() + 1_000,
        status: 'waiting',
        ...patch,
      };
      await stores.eventWaitStore.commit({
        sessionId: record.sessionId,
        waitId,
        expectedAuthorityRevision: null,
        record,
      });
      return record;
    },
    manager(source: EventWaitSourceAdapter, overrides: Partial<HostEventWaitManagerOptions> = {}) {
      const manager = new HostEventWaitManager({
        store: stores.eventWaitStore,
        adapters: new EventWaitAdapterRegistry([source]),
        clock,
        policy,
        authorize: async () => ({ kind: 'allowed', context: { trusted: true } }),
        onError: (e) => errors.push(e),
        ...overrides,
      });
      managers.push(manager);
      return manager;
    },
    async read(r: EventWaitRecord) {
      return (await stores.eventWaitStore.read({ sessionId: r.sessionId, waitId: r.waitId }))
        ?.record;
    },
  };
}

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: already-satisfied facts resolve once; subscribe/read gap is reconciled`, async (t) => {
    const f = await fixture(t, backend);
    const r = await f.wait();
    const source = new Source();
    // The condition changes while subscription is being established.
    source.onSubscribe = () => {
      source.behavior = async () => satisfied();
      source.notify(r.waitId);
    };
    const manager = f.manager(source);
    await manager.start();
    await eventually(async () => (await f.read(r))?.status === 'resolved');
    const snapshot = await f.read(r);
    assert.equal(snapshot?.observation?.attempts, 1);
    assert.equal(source.calls.length, 1);
    assert.equal(
      source.calls[0].access && (source.calls[0].access as { trusted: boolean }).trusted,
      true,
    );
    for (let n = 0; n < 100; n++) source.notify(r.waitId);
    await f.clock.advance(500);
    assert.deepEqual(await f.read(r), snapshot);
    assert.equal(source.calls.length, 1);
    assert.equal(source.closes, 1);
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: polling survives missing notifications and pending conditions expire`, async (t) => {
    const f = await fixture(t, backend);
    const r = await f.wait('wait-1', { deadlineAt: 1_350 });
    const source = new Source();
    const manager = f.manager(source);
    await manager.start();
    await eventually(async () => (await f.read(r))?.observation?.outcome === 'pending');
    await f.clock.advance(400);
    await eventually(async () => (await f.read(r))?.status === 'expired');
    assert.ok(source.calls.length >= 2 && source.calls.length <= 4);
    assert.equal(
      (await f.stores.eventWaitStore.listByStatus({ status: 'expired', limit: 10 })).items.length,
      1,
    );
    assert.equal((await f.stores.eventWaitStore.listPending({ limit: 10 })).items.length, 0);
    assert.equal(source.callbacks.size, 0);
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: restart preserves cursor, consumed budget, retry timing and absolute deadline`, async (t) => {
    const f = await fixture(t, backend);
    const r = await f.wait();
    const first = new Source();
    first.behavior = async () => ({ kind: 'pending', cursor: 'history-1', eventKey: 'event-1' });
    const manager = f.manager(first);
    await manager.start();
    await eventually(async () => (await f.read(r))?.observation?.outcome === 'pending');
    const before = (await f.read(r))!;
    await f.reopen();
    const second = new Source();
    second.behavior = async () => satisfied('event-2');
    const restored = f.manager(second);
    await restored.start();
    await settle();
    assert.equal(second.calls.length, 0);
    await f.clock.advance(100);
    await eventually(async () => (await f.read(r))?.status === 'resolved');
    assert.equal(second.calls[0].cursor, 'history-1');
    assert.equal((await f.read(r))?.observation?.attempts, 2);
    assert.equal((await f.read(r))?.deadlineAt, before.deadlineAt);
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: cancellation fences an in-flight result and retains any prior resolution`, async (t) => {
    const f = await fixture(t, backend);
    const r = await f.wait();
    const gate = deferred<EventWaitObservationResult>();
    const source = new Source();
    source.behavior = () => gate.promise;
    const manager = f.manager(source);
    await manager.start();
    await eventually(() => source.calls.length === 1);
    await manager.cancel({ sessionId: r.sessionId, waitId: r.waitId }, 'user_cancelled');
    gate.resolve(satisfied());
    await settle();
    assert.equal((await f.read(r))?.status, 'cancelled');
    assert.equal(source.callbacks.size, 0);
    const next = await f.wait('wait-2');
    source.behavior = async () => satisfied();
    await f.clock.advance(50);
    await eventually(async () => (await f.read(next))?.status === 'resolved');
    await manager.cancel(
      { sessionId: next.sessionId, waitId: next.waitId },
      'revoked_before_delivery',
    );
    const revoked = await f.read(next);
    assert.equal(revoked?.status, 'cancelled');
    if (revoked?.status === 'cancelled')
      assert.equal(revoked.priorResolution?.resolution.receiptKey, 'event-1');
    assert.deepEqual(f.errors, []);
  });
}

for (const backend of ['Local', 'Memory'] as const) {
  for (const status of ['waiting', 'resolved'] as const) {
    test(`${backend}: cancellation interrupted by close rejects for a ${status} wait and can be retried after reopen`, async (t) => {
      const f = await fixture(t, backend);
      const r = await f.wait();
      const input = { sessionId: r.sessionId, waitId: r.waitId };
      const source = new Source();
      if (status === 'resolved') source.behavior = async () => satisfied();
      const manager = f.manager(source);
      await manager.start();
      await eventually(async () => {
        const record = await f.read(r);
        return status === 'resolved'
          ? record?.status === 'resolved'
          : record?.observation?.outcome === 'pending';
      });
      await settle();
      const before = await f.stores.eventWaitStore.read(input);
      assert.equal(before?.record.status, status);

      // The real writer facade yields to validate its lease before returning the
      // read. No injected storage failure is needed for close to win this race.
      const cancellation = assert.rejects(manager.cancel(input, 'user_cancelled'), /closed/);
      const closing = manager.close();
      await Promise.all([cancellation, closing]);
      assert.deepEqual(await f.stores.eventWaitStore.read(input), before);
      assert.equal(source.callbacks.size, 0);

      await f.reopen();
      assert.deepEqual(await f.stores.eventWaitStore.read(input), before);
      const reopened = f.manager(new Source());
      await reopened.cancel(input, 'user_cancelled');
      const cancelled = await f.read(r);
      assert.ok(cancelled?.status === 'cancelled');
      assert.equal(cancelled.reason, 'user_cancelled');
      assert.deepEqual(cancelled.observation, before?.record.observation);
      if (before?.record.status === 'resolved')
        assert.deepEqual(cancelled.priorResolution, {
          resolvedAt: before.record.resolvedAt,
          resolution: before.record.resolution,
        });
      else assert.equal(cancelled.priorResolution, undefined);
      assert.deepEqual(f.errors, []);
    });
  }

  for (const status of ['cancelled', 'expired', 'missing'] as const) {
    test(`${backend}: cancellation interrupted by close remains idempotent for ${status} waits`, async (t) => {
      const f = await fixture(t, backend);
      const r = await f.wait();
      const input = {
        sessionId: r.sessionId,
        waitId: status === 'missing' ? 'missing-wait' : r.waitId,
      };
      const manager = f.manager(new Source());
      if (status === 'cancelled') await manager.cancel(input, 'already_cancelled');
      if (status === 'expired') {
        f.clock.time = r.deadlineAt;
        const current = await f.stores.eventWaitStore.read(input);
        assert.ok(current);
        const committed = await f.stores.eventWaitStore.commit({
          ...input,
          expectedAuthorityRevision: current.authorityRevision,
          record: {
            ...r,
            status: 'expired',
            updatedAt: r.deadlineAt,
            expiredAt: r.deadlineAt,
          },
        });
        assert.equal(committed.kind, 'committed');
      }
      const before = await f.stores.eventWaitStore.read(input);
      const cancellation = manager.cancel(input, 'another_cancellation');
      await Promise.all([cancellation, manager.close()]);
      assert.deepEqual(await f.stores.eventWaitStore.read(input), before);
      assert.deepEqual(f.errors, []);
    });
  }
}

for (const outcome of ['revision_conflict', 'committed'] as const) {
  test(`cancellation interrupted by close after a ${outcome} response preserves the durable outcome`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const reached = deferred<void>();
    const release = deferred<void>();
    let pause = true;
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async commit(input) {
              if (pause && input.record.status === 'cancelled') {
                pause = false;
                if (outcome === 'revision_conflict') {
                  // A real concurrent CAS advances the revision before the
                  // cancellation arrives; the repository generates the conflict.
                  const current = await stores.eventWaitStore.read({
                    sessionId: input.sessionId,
                    waitId: input.waitId,
                  });
                  assert.ok(current?.record.status === 'waiting');
                  const competing = await stores.eventWaitStore.commit({
                    ...input,
                    expectedAuthorityRevision: current.authorityRevision,
                    record: {
                      ...current.record,
                      status: 'resolved',
                      resolvedAt: current.record.updatedAt,
                      resolution: {
                        outcome: 'satisfied',
                        observedAt: current.record.updatedAt,
                        receiptKey: 'concurrent-result',
                        evidenceRefs: [],
                      },
                    },
                  });
                  assert.equal(competing.kind, 'committed');
                }
                const result = await stores.eventWaitStore.commit(input);
                assert.equal(result.kind, outcome);
                reached.resolve();
                await release.promise;
                return result;
              }
              return stores.eventWaitStore.commit(input);
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const r = await f.wait();
    const input = { sessionId: r.sessionId, waitId: r.waitId };
    const manager = f.manager(new Source());
    const cancellation = manager.cancel(input, 'user_cancelled');
    try {
      await Promise.race([
        reached.promise,
        cancellation.then(() => {
          throw new Error('Cancellation completed before reaching the commit pause');
        }),
      ]);
      const before = await f.stores.eventWaitStore.read(input);
      assert.equal(before?.record.status, outcome === 'committed' ? 'cancelled' : 'resolved');
      await manager.close();
      const completed =
        outcome === 'committed' ? cancellation : assert.rejects(cancellation, /closed/);
      release.resolve();
      await completed;
      assert.deepEqual(await f.stores.eventWaitStore.read(input), before);

      await f.reopen();
      assert.deepEqual(await f.stores.eventWaitStore.read(input), before);
      const reopened = f.manager(new Source());
      await reopened.cancel(input, 'user_cancelled');
      const cancelled = await f.read(r);
      assert.ok(cancelled?.status === 'cancelled');
      if (before?.record.status === 'resolved')
        assert.deepEqual(cancelled.priorResolution, {
          resolvedAt: before.record.resolvedAt,
          resolution: before.record.resolution,
        });
      assert.deepEqual(f.errors, []);
    } finally {
      release.resolve();
      await cancellation.catch(() => undefined);
    }
  });
}

for (const backend of ['Local', 'Memory'] as const) {
  for (const scenario of [
    { outcome: 'satisfied', reason: 'revoked', label: 'short reason' },
    {
      outcome: 'satisfied',
      reason: '"'.repeat(EVENT_WAIT_LIMITS.reasonBytes),
      label: 'maximum escaped reason',
    },
    { outcome: 'invalidated', reason: 'revoked', label: 'short reason' },
    { outcome: 'source_unavailable', reason: 'revoked', label: 'short reason' },
  ] as const) {
    test(`${backend}: a large ${scenario.outcome} result remains cancellable with ${scenario.label}`, async (t) => {
      const f = await fixture(t, backend);
      const quoted = (length: number) => '"'.repeat(length);
      const r = await f.wait('large', {
        sourceToolCallId: quoted(EVENT_WAIT_LIMITS.toolCallIdBytes),
        resource: {
          providerId: 'fake',
          connectionId: null,
          resourceType: 'task',
          resourceId: quoted(EVENT_WAIT_LIMITS.resourceIdBytes),
        },
        condition: {
          typeId: 'terminal',
          version: 1,
          parameters: { x: 'x'.repeat(EVENT_WAIT_LIMITS.parameterBytes - 8) },
        },
      });
      const result = {
        kind: scenario.outcome,
        receiptKey: quoted(EVENT_WAIT_LIMITS.receiptKeyBytes),
        cursor: quoted(EVENT_WAIT_LIMITS.cursorBytes),
        eventKey: quoted(EVENT_WAIT_LIMITS.receiptKeyBytes),
        evidenceRefs: Array<string>(EVENT_WAIT_LIMITS.evidenceRefs).fill(
          quoted(EVENT_WAIT_LIMITS.evidenceRefBytes),
        ),
      };
      const now = f.clock.now();
      const projected = () => ({
        ...r,
        status: 'resolved',
        resolvedAt: now,
        observation: {
          schemaVersion: 1,
          attempts: 1,
          lastAttemptAt: now,
          lastObservedAt: now,
          nextObserveAt: now + policy.minIntervalMs,
          nextPollAt: now + policy.pollIntervalMs,
          consecutiveErrors: 0,
          outcome: result.kind,
          cursor: result.cursor,
          eventKey: result.eventKey,
          reason: null,
        },
        resolution: {
          outcome: result.kind,
          receiptKey: result.receiptKey,
          observedAt: now,
          evidenceRefs: result.evidenceRefs,
        },
      });
      // This was a legal resolved record under the original 32 KiB bound, but
      // adding even a short cancellation reason exceeded that bound. Keep the
      // historical trigger independent of any replacement record-size policy.
      const resolvedBytes = 32_749;
      const projectedBytes = () => Buffer.byteLength(JSON.stringify(projected()));
      while (projectedBytes() > resolvedBytes) {
        const excess = projectedBytes() - resolvedBytes;
        const index = result.evidenceRefs.findIndex((ref) => ref.length > 1);
        assert.ok(index >= 0);
        const ref = result.evidenceRefs[index];
        // Each removed quote frees two JSON bytes; a final plain character
        // replaces one escaped quote when the remaining difference is odd.
        result.evidenceRefs[index] =
          excess === 1
            ? `${ref.slice(0, -1)}x`
            : ref.slice(Math.min(ref.length - 1, Math.floor(excess / 2)));
      }
      const source = new Source();
      source.behavior = async () => result;
      const manager = f.manager(source);
      await manager.start();
      await eventually(async () => (await f.read(r))?.status === 'resolved');
      const resolved = await f.read(r);
      assert.ok(resolved?.status === 'resolved');
      assert.equal(Buffer.byteLength(JSON.stringify(resolved)), resolvedBytes);
      assert.equal(resolved.resolution.outcome, scenario.outcome);
      assert.equal(source.calls.length, 1);
      assert.equal(source.callbacks.size, 0);

      await manager.cancel({ sessionId: r.sessionId, waitId: r.waitId }, scenario.reason);
      const cancelled = await f.read(r);
      assert.ok(cancelled?.status === 'cancelled');
      assert.equal(cancelled.reason, scenario.reason);
      assert.deepEqual(cancelled.observation, resolved.observation);
      assert.deepEqual(cancelled.priorResolution, {
        resolvedAt: resolved.resolvedAt,
        resolution: resolved.resolution,
      });
      const nextWaitId = 'after-large-cancellation';
      const next = await f.stores.eventWaitStore.commit({
        sessionId: r.sessionId,
        waitId: nextWaitId,
        expectedAuthorityRevision: null,
        record: {
          ...r,
          waitId: nextWaitId,
          deliveryKey: eventWaitDeliveryKey(nextWaitId),
        },
      });
      assert.equal(next.kind, 'committed', 'cancellation releases the Session active wait slot');
      assert.deepEqual(f.errors, []);
    });
  }
}

test('notification storms are coalesced; a change during an in-flight read schedules another check', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  const manager = f.manager(source);
  await manager.start();
  await eventually(() => source.calls.length === 1);
  for (let n = 0; n < 1_000; n++) source.notify(r.waitId);
  gate.resolve({ kind: 'pending' });
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'pending');
  source.behavior = async () => satisfied();
  await f.clock.advance(19);
  assert.equal(source.calls.length, 1);
  await f.clock.advance(11);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal(source.calls.length, 2);
  assert.deepEqual(f.errors, []);
});

test('failed reads preserve checkpoints and honor Retry-After across restart and notifications', async (t) => {
  const f = await fixture(t);
  const r = await f.wait('retry');
  const source = new Source();
  source.behavior = async () => ({
    kind: 'unknown',
    reason: 'rate_limited',
    retryAfterMs: 300,
    cursor: 'must-not-advance',
  });
  await f.manager(source).start();
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
  assert.equal((await f.read(r))?.observation?.cursor, null);
  await f.reopen();
  const resumed = new Source();
  resumed.behavior = async () => satisfied();
  await f.manager(resumed).start();
  await f.clock.advance(299);
  assert.equal(resumed.calls.length, 0);
  await f.clock.advance(11);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal(resumed.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: restart keeps an ordinary read failure's backoff local to its wait`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a');
    const b = await f.wait('b', { deadlineAt: 1_050 });
    const source = new Source();
    const reads: { waitId: string; at: number }[] = [];
    source.behavior = async ({ wait }) => {
      reads.push({ waitId: wait.waitId, at: f.clock.now() });
      return wait.waitId === a.waitId && reads.length === 1
        ? { kind: 'unknown', reason: 'resource_temporarily_unavailable' }
        : satisfied();
    };
    await f.manager(source).start();
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    const checkpoint = (await f.read(a))!.observation;
    assert.equal(checkpoint?.nextObserveAt, 1_100);
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_020,
    );

    await f.reopen();
    await f.manager(source).start();
    await f.clock.advance(19);
    assert.deepEqual(reads, [{ waitId: a.waitId, at: 1_000 }]);
    await f.clock.advance(21);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    await f.clock.advance(20);
    assert.equal((await f.read(b))?.status, 'resolved');
    assert.equal(reads[1]?.waitId, b.waitId);
    assert.ok(reads[1].at >= 1_020 && reads[1].at < b.deadlineAt);
    assert.deepEqual((await f.read(a))?.observation, checkpoint);

    await f.clock.advance(39);
    assert.equal(reads.length, 2);
    await f.clock.advance(21);
    await eventually(async () => (await f.read(a))?.status === 'resolved');
    assert.equal(reads[2]?.waitId, a.waitId);
    assert.ok(reads[2].at >= 1_100);
    assert.deepEqual(f.errors, []);
  });
}

test('transient errors back off, successful observations reset errors, budget exhaustion is terminal', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  source.behavior = async () => {
    throw new Error('private source exception');
  };
  await f.manager(source, { policy: { ...policy, maxAttempts: 3 } }).start();
  await eventually(async () => (await f.read(r))?.observation?.consecutiveErrors === 1);
  assert.equal((await f.read(r))?.observation?.reason, 'observation_failed');
  await f.clock.advance(110);
  await eventually(async () => (await f.read(r))?.observation?.consecutiveErrors === 2);
  const second = (await f.read(r))!;
  assert.equal(second.observation!.nextPollAt - second.observation!.lastObservedAt!, 200);
  source.behavior = async () => ({ kind: 'pending' });
  await f.clock.advance(210);
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'pending');
  assert.equal((await f.read(r))?.observation?.consecutiveErrors, 0);
  await f.clock.advance(110);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  const end = await f.read(r);
  assert.equal(source.calls.length, 3);
  if (end?.status === 'resolved') assert.equal(end.resolution.outcome, 'source_unavailable');
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: healthy pending observations can exhaust the budget before the deadline`, async (t) => {
    const f = await fixture(t, backend);
    const r = await f.wait();
    const source = new Source();
    const manager = f.manager(source, { policy: { ...policy, maxAttempts: 3 } });
    // Lifetime and request count are independent limits, even for a healthy source.
    manager.validate(r);
    await manager.start();
    for (let attempts = 1; attempts <= 3; attempts++) {
      await eventually(async () => {
        const record = await f.read(r);
        return (
          record?.observation?.attempts === attempts && record.observation.outcome === 'pending'
        );
      });
      assert.equal((await f.read(r))?.observation?.consecutiveErrors, 0);
      await f.clock.advance(policy.pollIntervalMs);
    }
    await eventually(async () => (await f.read(r))?.status === 'resolved');
    const result = await f.read(r);
    assert.ok(result?.status === 'resolved');
    assert.equal(result.resolution.outcome, 'source_unavailable');
    assert.equal(result.observation?.reason, 'observation_budget_exhausted');
    assert.equal(result.observation?.attempts, 3);
    assert.ok(result.resolvedAt < result.deadlineAt);
    assert.equal(source.calls.length, 3);
    assert.deepEqual(f.errors, []);
  });
}

test('uncooperative reads time out without releasing request capacity, and cannot defeat expiry', async (t) => {
  const f = await fixture(t);
  const r = await f.wait('blocked', { deadlineAt: 1_250 });
  const gate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = () => gate.promise;
  await f.manager(source, { policy: { ...policy, maxConcurrent: 1 } }).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
  assert.equal((await f.read(r))?.observation?.reason, 'observation_timeout');
  await f.clock.advance(210);
  await eventually(async () => (await f.read(r))?.status === 'expired');
  assert.equal(source.calls.length, 1);
  gate.resolve(satisfied());
  await settle();
  assert.equal((await f.read(r))?.status, 'expired');
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: a late Retry-After survives read timeout, wait cleanup and restart`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a', { deadlineAt: 3_000 });
    const b = await f.wait('b', { deadlineAt: 3_000 });
    const gate = deferred<EventWaitObservationResult>();
    const source = new Source();
    source.behavior = ({ wait }) =>
      wait.waitId === a.waitId ? gate.promise : Promise.resolve(satisfied());
    await f.manager(source).start();
    await eventually(() => source.calls.length === 1);
    await f.clock.advance(90);
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    const checkpoint = (await f.read(a))!.observation;
    assert.equal(checkpoint?.reason, 'observation_timeout');
    assert.equal(source.calls[0].signal.aborted, true);

    gate.resolve({
      kind: 'unknown',
      reason: 'rate_limited',
      retryAfterMs: 500,
      cursor: 'must-not-advance',
    });
    await eventually(
      async () =>
        (await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        })) === 1_590,
    );
    assert.deepEqual((await f.read(a))?.observation, checkpoint);
    await f.clock.advance(100);
    assert.equal(source.calls.length, 1);
    assert.equal((await f.read(b))?.status, 'waiting');

    await f.stores.purgeConversationOperationalState(a.sessionId);
    await f.reopen();
    const restored = new Source();
    restored.behavior = async () => satisfied();
    await f.manager(restored).start();
    await f.clock.advance(399);
    assert.equal(restored.calls.length, 0);
    await f.clock.advance(31);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.equal(restored.calls.length, 1);
    assert.deepEqual(f.errors, []);
  });
}

for (const backend of ['Local', 'Memory'] as const) {
  for (const phase of [1, 2, 3]) {
    for (const stop of ['timeout', 'cancel'] as const) {
      test(`${backend}: late authorization ${phase} Retry-After survives ${stop}, cleanup and restart`, async (t) => {
        const f = await fixture(t, backend);
        const a = await f.wait('a', { deadlineAt: 3_000 });
        const b = await f.wait('b', { deadlineAt: 3_000 });
        const gate = deferred<EventWaitObservationAccess>();
        const source = new Source();
        source.behavior = async () => satisfied();
        let checks = 0;
        let signal: AbortSignal | undefined;
        const manager = f.manager(source, {
          authorize: async (wait, currentSignal) => {
            if (wait.waitId === a.waitId && ++checks === phase) {
              signal = currentSignal;
              return gate.promise;
            }
            return { kind: 'allowed', context: null };
          },
        });
        await manager.start();
        await eventually(() => checks === phase);
        if (stop === 'timeout') {
          await f.clock.advance(90);
          await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
          assert.equal((await f.read(a))?.observation?.reason, 'observation_timeout');
        } else {
          await manager.cancel({ sessionId: a.sessionId, waitId: a.waitId }, 'cancelled_for_test');
        }
        assert.equal(signal?.aborted, true);
        const checkpoint = await f.read(a);
        const until = f.clock.now() + 500;
        gate.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
        await eventually(
          async () =>
            (await f.stores.eventWaitStore.readSourceCooldown({
              providerId: 'fake',
              connectionId: null,
            })) === until,
        );
        assert.deepEqual(await f.read(a), checkpoint, 'late access only updates source facts');
        await f.clock.advance(100);
        assert.equal(
          source.calls.some(({ wait }) => wait.waitId === b.waitId),
          false,
        );

        await f.stores.purgeConversationOperationalState(a.sessionId);
        await f.reopen();
        const restored = new Source();
        restored.behavior = async () => satisfied();
        await f.manager(restored).start();
        await f.clock.advance(399);
        assert.equal(restored.calls.length, 0);
        await f.clock.advance(31);
        await eventually(async () => (await f.read(b))?.status === 'resolved');
        assert.equal(restored.calls.length, 1);
        assert.deepEqual(f.errors, []);
      });
    }
  }
}

// Cover every source-fact boundary, both completion orders, and adjacent Promise
// handoffs. The invariant is one durable cooldown without reviving the cancelled wait.
for (const phase of [1, 2, 3, 'read'] as const) {
  for (const [first, handoffSteps] of [
    ['cancellation', 0],
    ['cancellation', 1],
    ['cancellation', 4],
    ['cancellation', 8],
    ['response', 0],
    ['response', 1],
    ['response', 4],
    ['response', 8],
  ] as const) {
    test(`source boundary ${phase} with ${first} first (${handoffSteps} microtasks) preserves one cooldown`, async (t) => {
      const base = createMemoryExecutionPersistenceProvider();
      const cancelAcknowledgement = deferred<void>();
      const response = deferred<{ kind: 'unknown'; reason: string; retryAfterMs: number }>();
      let cancelling = false;
      let cooldownWrites = 0;
      const provider: ExecutionPersistenceProvider = {
        async open(input) {
          const stores = await base.open(input);
          return {
            ...stores,
            eventWaitStore: {
              ...stores.eventWaitStore,
              async commit(input) {
                const result = stores.eventWaitStore.commit(input);
                if (input.record.status === 'cancelled') {
                  cancelling = true;
                  await cancelAcknowledgement.promise;
                }
                return result;
              },
              extendSourceCooldown(input) {
                cooldownWrites++;
                return stores.eventWaitStore.extendSourceCooldown(input);
              },
            },
          };
        },
      };
      const f = await fixture(t, 'Memory', provider);
      const a = await f.wait('a', { deadlineAt: 3_000 });
      const b = await f.wait('b', { deadlineAt: 3_000 });
      const source = new Source();
      source.behavior = async () => (phase === 'read' ? response.promise : satisfied());
      let checks = 0;
      const manager = f.manager(source, {
        authorize: async () => {
          if (++checks === phase) return response.promise;
          return { kind: 'allowed', context: null };
        },
      });
      try {
        await manager.start();
        await eventually(() => (phase === 'read' ? source.calls.length === 1 : checks === phase));
        const cancellation = manager.cancel(
          { sessionId: a.sessionId, waitId: a.waitId },
          'user_cancelled',
        );
        await eventually(() => cancelling);
        const finishResponse = () =>
          response.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
        const finishCancellation = () => cancelAcknowledgement.resolve();
        const [releaseFirst, releaseSecond] =
          first === 'response'
            ? [finishResponse, finishCancellation]
            : [finishCancellation, finishResponse];
        releaseFirst();
        for (let step = 0; step < handoffSteps; step++) await Promise.resolve();
        releaseSecond();
        await cancellation;
        await eventually(
          async () =>
            (await f.stores.eventWaitStore.readSourceCooldown({
              providerId: 'fake',
              connectionId: null,
            })) === 1_500,
        );
        const cancelled = await f.read(a);
        assert.equal(cancelled?.status, 'cancelled');
        assert.equal(
          await f.stores.eventWaitStore.readSourceCooldown({
            providerId: 'fake',
            connectionId: null,
          }),
          1_500,
        );
        assert.equal(cooldownWrites, 1, 'normal and late processing must not both extend the fact');
        await f.stores.purgeConversationOperationalState(a.sessionId);
        await f.reopen();
        const restored = new Source();
        restored.behavior = async () => satisfied();
        let restoredChecks = 0;
        await f
          .manager(restored, {
            authorize: async () => {
              restoredChecks++;
              return { kind: 'allowed', context: null };
            },
          })
          .start();
        await f.clock.advance(499);
        assert.equal(restoredChecks, 0);
        assert.equal(restored.calls.length, 0);
        await f.clock.advance(31);
        await eventually(async () => (await f.read(b))?.status === 'resolved');
        assert.equal(restored.calls.length, 1);
        assert.deepEqual(f.errors, []);
      } finally {
        cancelAcknowledgement.resolve();
        response.resolve({ kind: 'unknown', reason: 'cleanup', retryAfterMs: 0 });
      }
    });
  }
}

for (const outcome of ['closed', 'malformed', 'revoked', 'allowed'] as const) {
  test(`late authorization with ${outcome} outcome does not update wait or source facts`, async (t) => {
    const f = await fixture(t);
    const a = await f.wait('a');
    const gate = deferred<EventWaitObservationAccess>();
    const source = new Source();
    let checking = false;
    const manager = f.manager(source, {
      authorize: async () => {
        checking = true;
        return gate.promise;
      },
    });
    await manager.start();
    await eventually(() => checking);
    await f.clock.advance(90);
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    const checkpoint = await f.read(a);
    if (outcome === 'closed') await manager.close();
    gate.resolve(
      outcome === 'allowed'
        ? { kind: 'allowed', context: null }
        : outcome === 'revoked'
          ? { kind: 'revoked', reason: 'stale_access_check' }
          : {
              kind: 'unknown',
              reason: outcome === 'malformed' ? 'x'.repeat(2_048) : 'rate_limited',
              retryAfterMs: 500,
            },
    );
    if (outcome === 'malformed') await eventually(() => f.errors.length === 1);
    else await settle();
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      null,
    );
    assert.deepEqual(await f.read(a), checkpoint);
    assert.equal(source.calls.length, 0);
    if (outcome === 'malformed') assert.ok(f.errors[0] instanceof TypeError);
    else assert.deepEqual(f.errors, []);
  });
}

test('late authorization retains capacity until its source cooldown is persisted', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const writeGate = deferred<void>();
  let writing = false;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async extendSourceCooldown(cooldown) {
            if (!writing) {
              writing = true;
              await writeGate.promise;
            }
            return stores.eventWaitStore.extendSourceCooldown(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  const gate = deferred<EventWaitObservationAccess>();
  const source = new Source();
  source.behavior = async () => satisfied();
  let checking = false;
  await f
    .manager(source, {
      policy: { ...policy, maxConcurrent: 1 },
      authorize: async (wait) => {
        if (wait.waitId === a.waitId) {
          checking = true;
          return gate.promise;
        }
        return { kind: 'allowed', context: null };
      },
    })
    .start();
  await eventually(() => checking);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  gate.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await eventually(() => writing);
  const b = await f.wait('b', {
    resource: { providerId: 'fake', connectionId: 'other', resourceType: 'task', resourceId: 'b' },
  });
  await f.clock.advance(30);
  assert.equal(source.calls.length, 0, 'pending late persistence still occupies capacity');
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_590,
    'a scan can persist the fact while its original write still occupies capacity',
  );
  writeGate.resolve();
  await eventually(
    async () =>
      (await f.stores.eventWaitStore.readSourceCooldown({
        providerId: 'fake',
        connectionId: null,
      })) === 1_590,
  );
  await f.clock.advance(20);
  await eventually(async () => (await f.read(b))?.status === 'resolved');
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    ['b'],
  );
  assert.deepEqual(f.errors, []);
});

test('a late Retry-After cannot change source cooldowns after manager close', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a');
  const gate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = () => gate.promise;
  const manager = f.manager(source);
  await manager.start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  const checkpoint = (await f.read(a))!.observation;
  await manager.close();

  gate.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await settle();
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_020,
  );
  assert.deepEqual((await f.read(a))?.observation, checkpoint);
  assert.deepEqual(f.errors, []);
});

test('a malformed late Retry-After cannot throttle another wait', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a');
  const b = await f.wait('b');
  const gate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = ({ wait }) =>
    wait.waitId === a.waitId ? gate.promise : Promise.resolve(satisfied());
  await f.manager(source).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  const checkpoint = (await f.read(a))!.observation;

  gate.resolve({ kind: 'unknown', reason: 'x'.repeat(2_048), retryAfterMs: 500 });
  await eventually(() => f.errors.length === 1);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_020,
  );
  await f.clock.advance(20);
  await eventually(async () => (await f.read(b))?.status === 'resolved');
  assert.deepEqual((await f.read(a))?.observation, checkpoint);
  assert.equal(f.errors.length, 1);
  assert.ok(f.errors[0] instanceof TypeError);
});

test('failed late Retry-After persistence retries the original absolute cooldown', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  let unavailable = true;
  const deadlines: number[] = [];
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async extendSourceCooldown(cooldown) {
            deadlines.push(cooldown.until);
            if (cooldown.until > 1_020 && unavailable)
              throw new Error('late cooldown storage unavailable');
            return stores.eventWaitStore.extendSourceCooldown(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  await f.wait('b');
  const gate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = ({ wait }) =>
    wait.waitId === a.waitId ? gate.promise : Promise.resolve(satisfied());
  await f.manager(source).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  const checkpoint = (await f.read(a))!.observation;

  gate.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await eventually(() => f.errors.length === 1);
  assert.ok(f.errors[0] instanceof Error);
  assert.deepEqual(deadlines, [1_590, 1_590]);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_020,
  );
  assert.deepEqual((await f.read(a))?.observation, checkpoint);

  unavailable = false;
  await f.clock.advance(10);
  await eventually(
    async () =>
      (await f.stores.eventWaitStore.readSourceCooldown({
        providerId: 'fake',
        connectionId: null,
      })) === 1_590,
  );
  assert.equal(deadlines.at(-1), 1_590);
  await f.clock.advance(100);
  assert.equal(source.calls.length, 1);
  assert.deepEqual((await f.read(a))?.observation, checkpoint);
  assert.equal(f.errors.length, 1);
});

test('close waits for an in-progress late Retry-After write with a bounded timeout', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const writeGate = deferred<void>();
  let writingLateResult = false;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async extendSourceCooldown(cooldown) {
            if (cooldown.until === 1_590) {
              writingLateResult = true;
              await writeGate.promise;
            }
            return stores.eventWaitStore.extendSourceCooldown(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  const readGate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = () => readGate.promise;
  const manager = f.manager(source);
  await manager.start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(90);
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  const checkpoint = (await f.read(a))!.observation;

  readGate.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await eventually(() => writingLateResult);
  let closed = false;
  const close = manager.close().then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false);
  await f.clock.advance(policy.closeTimeoutMs - 1);
  assert.equal(closed, false);
  await f.clock.advance(1);
  await close;
  assert.equal(closed, true);
  assert.deepEqual((await f.read(a))?.observation, checkpoint);

  writeGate.resolve();
  await eventually(
    async () =>
      (await f.stores.eventWaitStore.readSourceCooldown({
        providerId: 'fake',
        connectionId: null,
      })) === 1_590,
  );
  assert.deepEqual(f.errors, []);
});

test('authority revocation during a read wins; no further source reads follow', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  let allowed = true;
  const source = new Source();
  source.behavior = async () => {
    allowed = false;
    return satisfied();
  };
  await f
    .manager(source, {
      authorize: async () =>
        allowed
          ? { kind: 'allowed', context: null }
          : { kind: 'revoked', reason: 'goal_generation_changed' },
    })
    .start();
  await eventually(async () => (await f.read(r))?.status === 'cancelled');
  await f.clock.advance(100);
  assert.equal(source.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

test('archive removes the wait and late callbacks cannot recreate it', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  await f.manager(source).start();
  await eventually(() => source.calls.length === 1);
  await f.stores.sessionStore.setSessionsArchivedVersioned(
    [
      {
        sessionId: r.sessionId,
        expectedVersion: (await f.stores.sessionStore.readHeaderRecordSnapshot(r.sessionId))
          .revision,
      },
    ],
    true,
  );
  gate.resolve(satisfied());
  await settle();
  await f.clock.advance(30);
  assert.equal(await f.read(r), undefined);
  assert.equal(source.callbacks.size, 0);
  assert.deepEqual(f.errors, []);
});

test('close aborts source work, discards late results and cleans a late subscription handle', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<{ close(): void }>();
  let subscribed = false,
    released = false;
  source.subscribe = async () => {
    subscribed = true;
    return gate.promise;
  };
  const manager = f.manager(source);
  await manager.start();
  await eventually(() => subscribed);
  await manager.close();
  gate.resolve({
    close() {
      released = true;
    },
  });
  await eventually(() => released);
  assert.equal(source.calls.length, 0);
  assert.equal((await f.read(r))?.status, 'waiting');
  assert.equal(f.clock.timers.size, 0);
  await assert.rejects(manager.start(), /closed/);
  assert.deepEqual(f.errors, []);
});

test('bounded pages, subscription capacity and source lanes eventually observe every wait', async (t) => {
  const f = await fixture(t);
  const waits = await Promise.all(Array.from({ length: 6 }, (_, n) => f.wait(`wait-${n}`)));
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  await f.manager(source, { policy: { ...policy, pageSize: 2, maxSubscriptions: 1 } }).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(20);
  assert.equal(source.calls.length, 1, 'same source is serial even when pages advance');
  gate.resolve(satisfied());
  source.behavior = async () => satisfied();
  await f.clock.advance(250);
  await eventually(async () =>
    (await Promise.all(waits.map((r) => f.read(r)))).every((r) => r?.status === 'resolved'),
  );
  assert.equal(source.calls.length, 6);
  assert.deepEqual(f.errors, []);
});

test('unsupported adapters, invalid templates and malformed results fail independently', async (t) => {
  const f = await fixture(t);
  const unsupported = await f.wait('unsupported', {
    condition: { typeId: 'unsupported', version: 1, parameters: {} },
  });
  const invalid = await f.wait('invalid', {
    condition: { typeId: 'terminal', version: 1, parameters: { invalid: true } },
  });
  const malformed = await f.wait('malformed');
  const source = new Source();
  source.behavior = async () => ({ kind: 'satisfied', receiptKey: '', evidenceRefs: [] });
  await f.manager(source).start();
  await f.clock.advance(70);
  await eventually(async () => (await f.read(malformed))?.observation?.outcome === 'unknown');
  for (const r of [unsupported, invalid]) {
    const result = await f.read(r);
    assert.equal(result?.status, 'resolved');
    if (result?.status === 'resolved')
      assert.equal(result.resolution.outcome, 'source_unavailable');
  }
  assert.ok(source.calls.every((v) => v.wait.waitId === 'malformed'));
  assert.deepEqual(f.errors, []);
});

test('lost result acknowledgement is recovered without another source read', async (t) => {
  let fail = false;
  const provider = createMemoryExecutionPersistenceProvider({
    afterCommit(op) {
      if (op === 'eventWait.commit' && fail) {
        fail = false;
        throw new Error('lost acknowledgement');
      }
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const r = await f.wait();
  const source = new Source();
  source.behavior = async () => {
    fail = true;
    return satisfied();
  };
  await f.manager(source).start();
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  await eventually(() => f.errors.length === 1);
  await f.reopen();
  const restored = new Source();
  await f.manager(restored).start();
  await f.clock.advance(300);
  assert.equal(restored.calls.length, 0);
  assert.equal((await f.read(r))?.status, 'resolved');
});

test('an adapter result cannot impersonate a trusted access revocation', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  source.behavior = async () => ({ kind: 'revoked', reason: 'untrusted' }) as never;
  await f.manager(source).start();
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
  assert.equal((await f.read(r))?.status, 'waiting');
  assert.equal(source.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

test('failure before result commit reconciles after reopening with the consumed attempt retained', async (t) => {
  let fail = false;
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit(op) {
      if (op === 'eventWait.commit' && fail) {
        fail = false;
        throw new Error('before result commit');
      }
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const r = await f.wait();
  const source = new Source();
  source.behavior = async () => {
    fail = true;
    return satisfied();
  };
  await f.manager(source).start();
  await eventually(() => f.errors.length === 1);
  assert.equal((await f.read(r))?.observation?.attempts, 1);
  await f.reopen();
  const restored = new Source();
  restored.behavior = async () => satisfied();
  await f.manager(restored).start();
  assert.equal(restored.calls.length, 0);
  await f.clock.advance(100);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal((await f.read(r))?.observation?.attempts, 2);
});

test('adapter registry and policy reject unsupported contracts; observation has no model or admission dependency', async (t) => {
  const f = await fixture(t);
  const source = new Source();
  assert.throws(() => new EventWaitAdapterRegistry([source, source]), /Duplicate/);
  assert.throws(() => f.manager(source, { policy: { pageSize: 201 } }), /policy/);
  assert.throws(() => f.manager(source, { policy: { maxAttempts: 0 } }), /policy/);
  assert.throws(() => f.manager(source, { policy: { maxSourceCooldowns: 5_000 } }), /policy/);
  const manager = f.manager(source);
  const r = await f.wait();
  assert.throws(() => manager.validate({ ...r, deadlineAt: r.createdAt + 100_000 }), /lifetime/);
  const text = await readFile(
    new URL('../../src/server/event-wait-manager.ts', import.meta.url),
    'utf8',
  );
  const imports = [...text.matchAll(/from ['"]([^'"]+)['"]/g)].map((v) => v[1]);
  assert.deepEqual(imports, [
    'node:crypto',
    '@maka/core/event-wait',
    '@maka/storage/event-wait-authority',
    '@maka/storage/root-authority',
    './event-wait-adapter.js',
  ]);
});

test('a lost reservation acknowledgement cannot issue an unaccounted read or reset the budget', async (t) => {
  let fail = false;
  const provider = createMemoryExecutionPersistenceProvider({
    afterCommit(op) {
      if (op === 'eventWait.commit' && fail) {
        fail = false;
        throw new Error('lost reservation acknowledgement');
      }
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const r = await f.wait();
  const source = new Source();
  fail = true;
  await f.manager(source, { policy: { ...policy, maxAttempts: 1 } }).start();
  await eventually(() => f.errors.length === 1);
  assert.equal(source.calls.length, 0);
  assert.equal((await f.read(r))?.observation?.attempts, 1);
  await f.reopen();
  await f.manager(source, { policy: { ...policy, maxAttempts: 1 } }).start();
  await f.clock.advance(100);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal(source.calls.length, 0);
  const end = await f.read(r);
  if (end?.status === 'resolved') assert.equal(end.resolution.outcome, 'source_unavailable');
});

test('revoked storage access stops the scheduler and subscriptions', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const manager = f.manager(source);
  await manager.start();
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'pending');
  await f.stores.eventWaitStore.close();
  await f.clock.advance(30);
  await eventually(() => f.errors.length === 1);
  await manager.close();
  assert.equal(source.callbacks.size, 0);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(source.calls.length, 1);
});

test('source failure does not delay a different connection and repeated dirty hints cannot starve peers', async (t) => {
  const f = await fixture(t);
  const first = await f.wait('a');
  const second = await f.wait('b');
  const other = await f.wait('c', {
    resource: { providerId: 'fake', resourceType: 'task', resourceId: 'c', connectionId: 'other' },
  });
  const source = new Source();
  source.behavior = async (input) => {
    if (input.wait.waitId === 'a') {
      source.notify(first.waitId);
      return { kind: 'pending' };
    }
    return satisfied();
  };
  await f.manager(source).start();
  await eventually(async () => (await f.read(other))?.status === 'resolved');
  await f.clock.advance(60);
  await eventually(async () => (await f.read(second))?.status === 'resolved');
  assert.equal((await f.read(first))?.status, 'waiting');
  assert.deepEqual(f.errors, []);
});

test('an overdue recovered wait expires before subscription or source access', async (t) => {
  const f = await fixture(t, 'Local');
  const r = await f.wait('overdue', { deadlineAt: 1_010 });
  await f.reopen();
  f.clock.time = 1_100;
  const source = new Source();
  let authorizations = 0;
  await f
    .manager(source, {
      authorize: async () => {
        authorizations++;
        return { kind: 'allowed', context: null };
      },
    })
    .start();
  assert.equal((await f.read(r))?.status, 'expired');
  assert.equal(source.calls.length, 0);
  assert.equal(source.callbacks.size, 0);
  assert.equal(authorizations, 0);
});

test('cancellation is scoped to the owning Session and releases resources after a lost acknowledgement', async (t) => {
  let fail = false;
  const provider = createMemoryExecutionPersistenceProvider({
    afterCommit(op) {
      if (op === 'eventWait.commit' && fail) {
        fail = false;
        throw new Error('cancel acknowledgement lost');
      }
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  const manager = f.manager(source);
  await manager.start();
  await eventually(() => source.calls.length === 1);
  await manager.cancel({ sessionId: 'another-session', waitId: r.waitId }, 'wrong_owner');
  assert.equal(source.calls[0].signal.aborted, false);
  assert.equal(source.callbacks.size, 1);
  fail = true;
  await assert.rejects(
    manager.cancel({ sessionId: r.sessionId, waitId: r.waitId }, 'cancelled'),
    /acknowledgement lost/,
  );
  assert.equal((await f.read(r))?.status, 'cancelled');
  assert.equal(source.calls[0].signal.aborted, true);
  assert.equal(source.callbacks.size, 0);
  gate.resolve(satisfied());
  await settle();
  assert.equal((await f.read(r))?.status, 'cancelled');
});

test('malformed authorization cannot grant source access, and elapsed deadlines prevent a new read', async (t) => {
  const f = await fixture(t);
  const r = await f.wait('invalid-access');
  const source = new Source();
  const bad = f.manager(source, {
    authorize: async () => ({ kind: 'unexpected', context: null }) as never,
  });
  await bad.start();
  await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
  assert.equal(source.calls.length, 0);
  await bad.close();
  const deadline = await f.wait('deadline', {
    deadlineAt: f.clock.now() + 50,
    // This scenario exercises the deadline, independently of the first wait's
    // deliberately persisted source cooldown recovered by the new manager.
    resource: {
      providerId: 'fake',
      resourceType: 'task',
      resourceId: 'deadline',
      connectionId: 'deadline',
    },
  });
  const manager = f.manager(source, {
    authorize: async () => {
      f.clock.time = deadline.deadlineAt;
      return { kind: 'allowed', context: null };
    },
  });
  await manager.start();
  await eventually(async () => (await f.read(deadline))?.status === 'expired');
  assert.equal(source.calls.length, 0);
});

test('a failed optional notification transport falls back to authoritative reads', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  source.subscribe = async () => {
    throw new Error('notification transport unavailable');
  };
  source.behavior = async () => satisfied();
  await f.manager(source).start();
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal(source.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

for (const [dirty, pageSize, minIntervalMs] of [
  [false, 2, 10],
  [true, 2, 10],
  [false, 1, 20],
  [true, 1, 20],
] as const) {
  test(`persistent waits receive turns across page boundaries (notifications=${dirty}, pageSize=${pageSize})`, async (t) => {
    const f = await fixture(t);
    const waits = await Promise.all(Array.from({ length: 4 }, (_, n) => f.wait(`wait-${n}`)));
    const source = new Source();
    source.behavior = async ({ wait }) => {
      if (dirty) source.notify(wait.waitId);
      return { kind: 'pending' };
    };
    await f
      .manager(source, {
        policy: { ...policy, pageSize, minIntervalMs, pollIntervalMs: 20, maxAttempts: 100 },
      })
      .start();
    await eventually(() => source.calls.length === 1);
    await f.clock.advance(600);
    const counts = waits.map(
      (r) => source.calls.filter(({ wait }) => wait.waitId === r.waitId).length,
    );
    assert.ok(
      counts.every((count) => count >= 3),
      JSON.stringify(counts),
    );
    assert.deepEqual(f.errors, []);
  });
}

test('later launches on another connection do not skip unserved page peers', async (t) => {
  const f = await fixture(t);
  const waits = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      f.wait(`wait-${n}`, {
        resource: {
          providerId: 'fake',
          connectionId: n % 4 < 2 ? 'a' : 'b',
          resourceType: 'task',
          resourceId: `task-${n}`,
        },
      }),
    ),
  );
  const source = new Source();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 4, minIntervalMs: 10, pollIntervalMs: 20, maxAttempts: 100 },
    })
    .start();
  await eventually(() => source.calls.length === 2);
  await f.clock.advance(300);
  for (const r of waits)
    assert.ok(
      source.calls.some(({ wait }) => wait.waitId === r.waitId),
      r.waitId,
    );
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  for (const retirement of ['expire', 'cancel', 'purge'] as const) {
    test(`${backend}: source Retry-After survives ${retirement} and restart`, async (t) => {
      const f = await fixture(t, backend);
      const a = await f.wait('a', { deadlineAt: retirement === 'expire' ? 1_050 : 2_000 });
      const b = await f.wait('b', { deadlineAt: 2_000 });
      const source = new Source();
      source.behavior = async () => ({
        kind: 'unknown',
        reason: 'rate_limited',
        retryAfterMs: 500,
      });
      const manager = f.manager(source);
      await manager.start();
      await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
      // The shared source delay exceeds local maxBackoffMs (400), and may also
      // outlive the originating wait. Neither boundary may shorten it for peers.
      assert.equal(
        await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        }),
        1_500,
      );
      await f.clock.advance(60);
      assert.equal(source.calls.filter(({ wait }) => wait.waitId === b.waitId).length, 0);
      if (retirement === 'cancel')
        await manager.cancel({ sessionId: a.sessionId, waitId: a.waitId }, 'user_cancelled');
      else if (retirement === 'purge')
        await f.stores.purgeConversationOperationalState(a.sessionId);
      else assert.equal((await f.read(a))?.status, 'expired');
      await f.reopen();
      const other = await f.wait('c', {
        resource: {
          providerId: 'fake',
          connectionId: 'other',
          resourceType: 'task',
          resourceId: 'c',
        },
      });
      const resumed = new Source();
      const readAt = new Map<string, number>();
      resumed.behavior = async ({ wait }) => {
        readAt.set(wait.waitId, f.clock.now());
        return satisfied();
      };
      await f.manager(resumed).start();
      await eventually(async () => (await f.read(other))?.status === 'resolved');
      await f.clock.advance(1_499 - f.clock.now());
      assert.equal(readAt.has(b.waitId), false);
      assert.equal((await f.read(b))?.observation, undefined, 'throttled reads consume no budget');
      await f.clock.advance(50);
      await eventually(async () => (await f.read(b))?.status === 'resolved');
      assert.ok(readAt.get(b.waitId)! >= 1_500);
      assert.deepEqual(f.errors, []);
    });
  }
}

for (const reconciliation of ['snapshot', 'history'] as const) {
  test(`${reconciliation}: a cooperative subscription timeout falls back to polling`, async (t) => {
    const f = await fixture(t);
    const r = await f.wait('timeout', { deadlineAt: 1_700 });
    const source = new Source();
    source.reconciliation = reconciliation;
    let setups = 0,
      active = 0;
    source.subscribe = ({ signal }) =>
      new Promise((_resolve, reject) => {
        setups++;
        active++;
        signal.addEventListener(
          'abort',
          () => {
            active--;
            reject(new Error('subscription aborted'));
          },
          { once: true },
        );
      });
    source.behavior = async () => {
      assert.equal(active, 0, 'subscription request must settle before reading');
      return satisfied();
    };
    await f.manager(source).start();
    await eventually(() => setups === 1);
    await f.clock.advance(600);
    assert.equal((await f.read(r))?.status, 'resolved');
    assert.equal(setups, 1);
    assert.equal(source.calls.length, 1);
    assert.deepEqual(f.errors, []);
  });
}

for (const backend of ['Memory', 'Local'] as const) {
  for (const failure of ['unknown', 'throw'] as const) {
    test(`${backend}: subscription fallback survives a transient ${failure} read`, async (t) => {
      const f = await fixture(t, backend);
      const r = await f.wait('timeout', { deadlineAt: 1_600 });
      const source = new Source();
      let setups = 0,
        active = 0;
      source.subscribe = ({ signal }) =>
        new Promise((_resolve, reject) => {
          setups++;
          active++;
          signal.addEventListener(
            'abort',
            () => {
              active--;
              reject(new Error('subscription aborted'));
            },
            { once: true },
          );
        });
      source.behavior = async () => {
        assert.equal(active, 0, 'subscription request must settle before reading');
        if (source.calls.length === 1) {
          if (failure === 'throw') throw new Error('transient read failure');
          return { kind: 'unknown', reason: 'transient_read_failure' };
        }
        return satisfied();
      };
      await f.manager(source).start();
      await eventually(() => setups === 1);
      await f.clock.advance(600);
      assert.equal((await f.read(r))?.status, 'resolved');
      assert.equal(source.calls.length, 2);
      assert.equal(setups, 1, 'a failed optional subscription must not block polling retries');
      assert.deepEqual(f.errors, []);
    });
  }
}

test('a lingering subscription retains capacity, then polling resumes after it settles', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<{ close(): void }>();
  let setups = 0,
    closes = 0;
  source.subscribe = async () => {
    setups++;
    return gate.promise;
  };
  source.behavior = async () => satisfied();
  await f.manager(source, { policy: { ...policy, maxConcurrent: 2, maxPerSource: 2 } }).start();
  await eventually(() => setups === 1);
  await f.clock.advance(300);
  assert.equal(source.calls.length, 0);
  assert.equal(setups, 1);
  gate.resolve({
    close: () => {
      closes++;
    },
  });
  await settle();
  await f.clock.advance(100);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  assert.equal(source.calls.length, 1);
  assert.equal(setups, 1);
  assert.equal(closes, 1);
  assert.deepEqual(f.errors, []);
});

test('source throttling defers control revalidation until the cooldown ends', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a');
  const b = await f.wait('b');
  const source = new Source();
  source.behavior = async ({ wait }) =>
    wait.waitId === a.waitId
      ? { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 }
      : satisfied();
  const checks: number[] = [];
  await f
    .manager(source, {
      authorize: async (wait) => {
        checks.push(f.clock.now());
        return wait.waitId === a.waitId &&
          source.calls.some((call) => call.wait.waitId === a.waitId)
          ? { kind: 'revoked', reason: 'goal_replaced' }
          : { kind: 'allowed', context: null };
      },
    })
    .start();
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_500,
  );
  await f.clock.advance(499);
  assert.deepEqual(checks, [1_000, 1_000]);
  assert.equal((await f.read(a))?.status, 'waiting');
  assert.equal(source.calls.length, 1);
  assert.equal(source.callbacks.size, 0);
  await f.clock.advance(31);
  await eventually(async () => (await f.read(a))?.status === 'cancelled');
  await eventually(async () => (await f.read(b))?.status === 'resolved');
  assert.equal(source.calls.filter(({ wait }) => wait.waitId === a.waitId).length, 1);
  assert.equal(source.calls.filter(({ wait }) => wait.waitId === b.waitId).length, 1);
  assert.ok(checks.slice(2).every((at) => at >= 1_500));
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  for (const outcome of ['pending', 'satisfied'] as const) {
    test(`${backend}: peer Retry-After defers post-read authorization of a ${outcome} result`, async (t) => {
      const f = await fixture(t, backend);
      const a = await f.wait('a');
      const b = await f.wait('b');
      const source = new Source();
      const first = deferred<EventWaitObservationResult>();
      const second = deferred<EventWaitObservationResult>();
      source.behavior = ({ wait }) => (wait.waitId === a.waitId ? first.promise : second.promise);
      const checks: number[] = [];
      const manager = f.manager(source, {
        policy: { ...policy, maxPerSource: 2, maxSourceCooldowns: 1 },
        authorize: async (wait) => {
          if (wait.waitId === b.waitId) checks.push(f.clock.now());
          return { kind: 'allowed', context: null };
        },
      });
      await manager.start();
      await eventually(() => source.calls.length === 1);
      await f.clock.advance(policy.minIntervalMs);
      await eventually(() => source.calls.length === 2);
      first.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
      await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
      const until = f.clock.now() + 500;
      await manager.cancel({ sessionId: a.sessionId, waitId: a.waitId }, 'user_cancelled');
      second.resolve(outcome === 'pending' ? { kind: 'pending' } : satisfied());

      // An independent connection must progress, even while B retains its read result.
      // Its dispatch also evicts the persisted Retry-After from the bounded source cache.
      source.behavior = async () => satisfied();
      const other = await f.wait('other', {
        resource: { ...a.resource, connectionId: 'other' },
      });
      await manager.reconcile();
      await eventually(async () => (await f.read(other))?.status === 'resolved');
      await f.clock.advance(499);
      assert.equal(checks.length, 2, 'the third authorization must honor the peer cooldown');
      assert.equal((await f.read(b))?.observation?.outcome, 'checking');
      assert.equal((await f.read(b))?.observation?.attempts, 1);
      await f.clock.advance(1);
      await eventually(async () => (await f.read(b))?.observation?.outcome === outcome);
      assert.equal(checks.length, 3);
      assert.equal(checks[2], until);
      assert.equal((await f.read(b))?.observation?.attempts, 1);
      assert.equal(source.calls.filter(({ wait }) => wait.waitId === b.waitId).length, 1);
      assert.deepEqual(f.errors, []);
    });
  }
}

for (const stop of ['cancel', 'expire', 'close'] as const) {
  test(`${stop} interrupts post-read authorization deferred by peer Retry-After`, async (t) => {
    const f = await fixture(t);
    const a = await f.wait('a');
    const b = await f.wait('b', { deadlineAt: stop === 'expire' ? 1_100 : 2_000 });
    const source = new Source();
    const first = deferred<EventWaitObservationResult>();
    const second = deferred<EventWaitObservationResult>();
    source.behavior = ({ wait }) => (wait.waitId === a.waitId ? first.promise : second.promise);
    let checks = 0;
    const manager = f.manager(source, {
      policy: { ...policy, maxPerSource: 2 },
      authorize: async (wait) => {
        if (wait.waitId === b.waitId) checks++;
        return { kind: 'allowed', context: null };
      },
    });
    await manager.start();
    await eventually(() => source.calls.length === 1);
    await f.clock.advance(policy.minIntervalMs);
    await eventually(() => source.calls.length === 2);
    first.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    await manager.cancel({ sessionId: a.sessionId, waitId: a.waitId }, 'user_cancelled');
    second.resolve(satisfied());
    await f.clock.advance(10);
    assert.equal(checks, 2);
    if (stop === 'cancel')
      await manager.cancel({ sessionId: b.sessionId, waitId: b.waitId }, 'user_cancelled');
    else if (stop === 'close') await manager.close();
    await f.clock.advance(600);
    assert.equal(checks, 2, 'an interrupted wait must not authorize when the cooldown ends');
    assert.equal(
      (await f.read(b))?.status,
      stop === 'cancel' ? 'cancelled' : stop === 'expire' ? 'expired' : 'waiting',
    );
    assert.equal(source.callbacks.size, 0);
    assert.deepEqual(f.errors, []);
  });
}

test('a timed-out read blocks only its own wait until the underlying request settles', async (t) => {
  const f = await fixture(t);
  const r = await f.wait('blocked');
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  const manager = f.manager(source, { policy: { ...policy, maxPerSource: 2 } });
  await manager.start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(300);
  assert.equal(source.calls.length, 1);
  assert.equal((await f.read(r))?.observation?.attempts, 1);
  assert.equal(source.calls[0].signal.aborted, true);

  const peer = await f.wait('peer');
  source.behavior = async () => satisfied('new-result');
  await manager.reconcile();
  await eventually(async () => (await f.read(peer))?.status === 'resolved');
  assert.equal(source.calls.filter((call) => call.wait.waitId === r.waitId).length, 1);
  gate.resolve(satisfied('late-result'));
  await settle();
  assert.equal((await f.read(r))?.status, 'waiting');
  await f.clock.advance(100);
  await eventually(async () => (await f.read(r))?.status === 'resolved');
  const result = await f.read(r);
  assert.equal(result?.observation?.attempts, 2);
  if (result?.status === 'resolved') assert.equal(result.resolution.receiptKey, 'new-result');
  assert.deepEqual(f.errors, []);
});

for (const capacity of ['global', 'source'] as const) {
  for (const phase of ['initial', 'subscription', 'pre-read', 'read', 'post-read'] as const) {
    for (const completionOrder of ['checkpoint-first', 'request-first'] as const) {
      test(`${capacity} capacity counts a timed-out ${phase} operation once (${completionOrder})`, async (t) => {
        const base = createMemoryExecutionPersistenceProvider();
        const checkpoint = deferred<void>();
        const interrupted = deferred<void>();
        const peerRead = deferred<void>();
        let writingCheckpoint = false;
        let interruptedOperationStarted = false;
        const provider: ExecutionPersistenceProvider = {
          async open(input) {
            const stores = await base.open(input);
            return {
              ...stores,
              eventWaitStore: {
                ...stores.eventWaitStore,
                async commit(input) {
                  if (
                    input.waitId === 'a' &&
                    input.record.observation?.reason === 'observation_timeout'
                  ) {
                    writingCheckpoint = true;
                    await checkpoint.promise;
                  }
                  return stores.eventWaitStore.commit(input);
                },
              },
            };
          },
        };
        const f = await fixture(t, 'Memory', provider);
        const a = await f.wait('a');
        const source = new Source();
        source.behavior = async ({ wait }) => {
          if (wait.waitId === a.waitId && phase === 'read') {
            interruptedOperationStarted = true;
            await interrupted.promise;
          } else if (wait.waitId === 'b') await peerRead.promise;
          return wait.waitId === a.waitId ? { kind: 'pending' } : satisfied();
        };
        if (phase === 'subscription') {
          source.subscribe = async ({ wait }) => {
            if (wait.waitId === a.waitId) {
              interruptedOperationStarted = true;
              await interrupted.promise;
            }
            return { close() {} };
          };
        }
        let aChecks = 0;
        const authorizationPhase = { initial: 1, 'pre-read': 2, 'post-read': 3 };
        const manager = f.manager(source, {
          policy: {
            ...policy,
            maxConcurrent: capacity === 'global' ? 2 : 3,
            maxPerSource: capacity === 'global' ? 1 : 2,
          },
          authorize: async (wait) => {
            if (
              wait.waitId === a.waitId &&
              ++aChecks ===
                (phase === 'subscription' || phase === 'read' ? 0 : authorizationPhase[phase])
            ) {
              interruptedOperationStarted = true;
              await interrupted.promise;
            }
            return { kind: 'allowed', context: null };
          },
        });
        try {
          await manager.start();
          await eventually(() => interruptedOperationStarted);
          await f.clock.advance(policy.readTimeoutMs);
          await eventually(() => writingCheckpoint);
          const b = await f.wait('b', {
            resource: {
              ...a.resource,
              connectionId: capacity === 'global' ? 'b' : a.resource.connectionId,
              resourceId: 'b',
            },
            deadlineAt: f.clock.now() + policy.readTimeoutMs - 10,
          });
          const c = await f.wait('c', {
            resource: {
              ...a.resource,
              connectionId: capacity === 'global' ? 'c' : a.resource.connectionId,
              resourceId: 'c',
            },
          });
          await manager.reconcile();
          await eventually(() => source.calls.some(({ wait }) => wait.waitId === b.waitId));
          // Let ordinary read spacing elapse, so C is blocked by capacity alone.
          await f.clock.advance(policy.minIntervalMs);
          assert.equal(
            source.calls.filter(({ wait }) => wait.waitId === b.waitId).length,
            1,
            'A occupies one slot while its interrupted call and checkpoint are both pending',
          );
          assert.equal((await f.read(c))?.observation, undefined, 'A and B fill the capacity');

          if (completionOrder === 'checkpoint-first') {
            checkpoint.resolve();
            await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
          } else {
            interrupted.resolve();
            await settle();
          }
          await manager.reconcile();
          await settle();
          assert.equal(
            (await f.read(c))?.observation,
            undefined,
            'the remaining checkpoint or interrupted request must retain its capacity',
          );

          peerRead.resolve();
          await eventually(async () => (await f.read(b))?.status === 'resolved');
          assert.ok(f.clock.now() < b.deadlineAt, 'the peer must be observed before its deadline');
          await manager.reconcile();
          await eventually(async () => (await f.read(c))?.status === 'resolved');
          assert.equal((await f.read(a))?.observation?.attempts, 1);
          assert.deepEqual(f.errors, []);
        } finally {
          checkpoint.resolve();
          interrupted.resolve();
          peerRead.resolve();
          await settle();
        }
      });
    }
  }
}

for (const setup of ['authorization', 'subscription'] as const) {
  test(`slow ${setup} cannot compress the interval between source reads`, async (t) => {
    const f = await fixture(t);
    const a = await f.wait('a');
    const b = await f.wait('b');
    const source = new Source();
    const gate = deferred<void>();
    let preparing = false;
    const subscribe = source.subscribe.bind(source);
    source.subscribe = async (input, changed) => {
      if (setup === 'subscription' && input.wait.waitId === a.waitId) {
        preparing = true;
        await gate.promise;
      }
      return subscribe(input, changed);
    };
    const reads: number[] = [];
    source.behavior = async () => {
      reads.push(f.clock.now());
      return satisfied();
    };
    await f
      .manager(source, {
        authorize: async (wait) => {
          if (setup === 'authorization' && wait.waitId === a.waitId) {
            preparing = true;
            await gate.promise;
          }
          return { kind: 'allowed', context: null };
        },
      })
      .start();
    await eventually(() => preparing);
    await f.clock.advance(19);
    gate.resolve();
    await eventually(async () => (await f.read(a))?.status === 'resolved');
    await f.clock.advance(1);
    assert.deepEqual(reads, [1_019]);
    await f.clock.advance(30);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.equal(reads.length, 2);
    assert.ok(reads[1] - reads[0] >= policy.minIntervalMs);
    assert.equal((await f.read(b))?.observation?.attempts, 1);
    assert.deepEqual(f.errors, []);
  });
}

test('concurrently authorized reads reserve the source interval at dispatch', async (t) => {
  const f = await fixture(t);
  await f.wait('a');
  await f.wait('b');
  const source = new Source();
  const gate = deferred<void>();
  let preparing = 0;
  const reads: number[] = [];
  source.behavior = async () => {
    reads.push(f.clock.now());
    return satisfied();
  };
  await f
    .manager(source, {
      policy: { ...policy, maxPerSource: 2 },
      authorize: async () => {
        preparing++;
        await gate.promise;
        return { kind: 'allowed', context: null };
      },
    })
    .start();
  await eventually(() => preparing === 2);
  gate.resolve();
  await eventually(() => reads.length === 1);
  await f.clock.advance(19);
  assert.equal(reads.length, 1);
  await f.clock.advance(1);
  await eventually(() => reads.length === 2);
  assert.ok(reads[1] - reads[0] >= policy.minIntervalMs);
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  for (const accessAfterCooldown of ['allowed', 'revoked'] as const) {
    test(`${backend}: a subscription deferred by peer Retry-After rechecks ${accessAfterCooldown} access`, async (t) => {
      const f = await fixture(t, backend);
      const a = await f.wait('a', { deadlineAt: 3_000 });
      const b = await f.wait('b', { deadlineAt: 3_000 });
      const gate = deferred<void>();
      const source = new Source();
      source.behavior = async ({ wait }) =>
        wait.waitId === a.waitId
          ? { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 }
          : satisfied();
      const subscriptions: { waitId: string; at: number; access: unknown }[] = [];
      source.onSubscribe = ({ wait, access }) => {
        subscriptions.push({ waitId: wait.waitId, at: f.clock.now(), access });
      };
      const checks: number[] = [];
      const manager = f.manager(source, {
        policy: { ...policy, maxPerSource: 2 },
        authorize: async (wait) => {
          if (wait.waitId === b.waitId) {
            checks.push(f.clock.now());
            if (checks.length === 1) {
              await gate.promise;
              return { kind: 'allowed', context: 'before_cooldown' };
            }
            if (accessAfterCooldown === 'revoked')
              return { kind: 'revoked', reason: 'goal_replaced' };
          }
          return { kind: 'allowed', context: f.clock.now() };
        },
      });
      try {
        await manager.start();
        await eventually(
          async () => checks.length === 1 && (await f.read(a))?.observation?.outcome === 'unknown',
        );
        await manager.cancel({ sessionId: a.sessionId, waitId: a.waitId }, 'user_cancelled');
        gate.resolve();
        await settle();
        assert.equal(
          subscriptions.some(({ waitId }) => waitId === b.waitId),
          false,
        );
        await f.clock.advance(499);
        assert.deepEqual(checks, [1_000], 'waiting for cooldown is outside the request timeout');
        assert.equal(
          source.calls.some(({ wait }) => wait.waitId === b.waitId),
          false,
        );
        assert.equal((await f.read(b))?.observation?.attempts, 1);
        await f.clock.advance(31);
        await eventually(
          async () =>
            (await f.read(b))?.status ===
            (accessAfterCooldown === 'allowed' ? 'resolved' : 'cancelled'),
        );
        const resumed = subscriptions.filter(({ waitId }) => waitId === b.waitId);
        assert.equal(resumed.length, accessAfterCooldown === 'allowed' ? 1 : 0);
        if (resumed.length) {
          assert.ok(resumed[0].at >= 1_500);
          assert.equal(resumed[0].access, resumed[0].at, 'subscription uses fresh access');
        }
        assert.ok(checks.slice(1).every((at) => at >= 1_500));
        assert.equal((await f.read(b))?.observation?.attempts, 1);
        assert.deepEqual(f.errors, []);
      } finally {
        gate.resolve();
      }
    });
  }
}

for (const setup of ['subscription', 'authorization'] as const) {
  test(`Retry-After blocks a peer still preparing ${setup}`, async (t) => {
    const f = await fixture(t, 'Local');
    const a = await f.wait('a');
    const b = await f.wait('b');
    const source = new Source();
    const firstRead = deferred<EventWaitObservationResult>();
    const setupGate = deferred<void>();
    let preparing = false;
    const subscribe = source.subscribe.bind(source);
    source.subscribe = async (input, changed) => {
      if (setup === 'subscription' && input.wait.waitId === b.waitId) {
        preparing = true;
        await setupGate.promise;
      }
      return subscribe(input, changed);
    };
    const reads: { waitId: string; at: number }[] = [];
    source.behavior = async ({ wait, access }) => {
      assert.equal(access, f.clock.now());
      reads.push({ waitId: wait.waitId, at: f.clock.now() });
      return wait.waitId === a.waitId && reads.length === 1 ? firstRead.promise : satisfied();
    };
    await f
      .manager(source, {
        policy: { ...policy, maxPerSource: 2 },
        authorize: async (wait) => {
          if (
            setup === 'authorization' &&
            wait.waitId === b.waitId &&
            source.callbacks.has(b.waitId)
          ) {
            preparing = true;
            await setupGate.promise;
          }
          return { kind: 'allowed', context: f.clock.now() };
        },
      })
      .start();
    await eventually(() => reads.length === 1);
    await f.clock.advance(20);
    await eventually(() => preparing);
    await f.clock.advance(20);
    firstRead.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_540,
    );
    await f.clock.advance(20);
    setupGate.resolve();
    await settle();
    await f.clock.advance(479);
    assert.equal(reads.length, 1);
    assert.equal((await f.read(b))?.observation?.attempts, 1);
    await f.clock.advance(61);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.ok(reads.find((read) => read.waitId === b.waitId)!.at >= 1_540);
    assert.equal((await f.read(b))?.observation?.attempts, 1);
    assert.deepEqual(f.errors, []);
  });
}

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: source Retry-After defers authorization through restart until the cooldown ends`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a');
    const b = await f.wait('b');
    const source = new Source();
    source.behavior = async () => ({
      kind: 'unknown',
      reason: 'rate_limited',
      retryAfterMs: 500,
    });
    const checks: { waitId: string; at: number }[] = [];
    const authorize = async (wait: EventWaitRecord): Promise<EventWaitObservationAccess> => {
      checks.push({ waitId: wait.waitId, at: f.clock.now() });
      return { kind: 'allowed', context: null };
    };
    await f.manager(source, { authorize }).start();
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    assert.deepEqual(checks, [
      { waitId: a.waitId, at: 1_000 },
      { waitId: a.waitId, at: 1_000 },
    ]);
    assert.equal(source.calls.length, 1);
    assert.equal(source.callbacks.size, 0);
    assert.equal((await f.read(a))?.observation?.reason, 'rate_limited');
    assert.equal((await f.read(a))?.observation?.nextObserveAt, 1_500);
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_500,
    );

    await f.clock.advance(200);
    assert.equal(checks.length, 2);
    await f.reopen();
    const resumed = new Source();
    resumed.behavior = async () => satisfied();
    await f.manager(resumed, { authorize }).start();
    await f.clock.advance(299);
    assert.equal(checks.length, 2, 'neither wait may authorize during the shared cooldown');
    assert.equal(resumed.calls.length, 0);
    await f.clock.advance(31);
    await eventually(async () => (await f.read(a))?.status === 'resolved');
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.equal(resumed.calls.length, 2);
    assert.equal(checks.length, 8, 'successful results still revalidate access after reading');
    assert.ok(checks.slice(2).every(({ at }) => at >= 1_500));
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: pre-read authorization Retry-After prevents further authorization until due`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a');
    const b = await f.wait('b');
    const source = new Source();
    source.behavior = async () => satisfied();
    const checks: number[] = [];
    await f
      .manager(source, {
        authorize: async () => {
          checks.push(f.clock.now());
          return checks.length === 2
            ? { kind: 'unknown', reason: 'auth_rate_limited', retryAfterMs: 500 }
            : { kind: 'allowed', context: null };
        },
      })
      .start();
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    assert.deepEqual(checks, [1_000, 1_000]);
    assert.equal(source.calls.length, 0);
    assert.equal(source.callbacks.size, 0);
    assert.equal((await f.read(a))?.observation?.reason, 'auth_rate_limited');
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_500,
    );
    await f.clock.advance(499);
    assert.equal(checks.length, 2);
    assert.equal(source.calls.length, 0);
    await f.clock.advance(31);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.ok(checks.slice(2).every((at) => at >= 1_500));
    assert.deepEqual(f.errors, []);
  });
}

for (const eligibility of ['revoked', 'unknown', 'allowed'] as const) {
  test(`subscription completion rechecks ${eligibility} access before reading`, async (t) => {
    const f = await fixture(t);
    const r = await f.wait();
    const source = new Source();
    let subscribed = false;
    source.onSubscribe = (input) => {
      assert.equal(input.access, 'original-context');
      subscribed = true;
    };
    source.behavior = async (input) => {
      assert.equal(input.access, 'current-context');
      return satisfied();
    };
    await f
      .manager(source, {
        authorize: async () => {
          if (!subscribed) return { kind: 'allowed', context: 'original-context' };
          if (eligibility !== 'allowed') return { kind: eligibility, reason: 'access_changed' };
          return { kind: 'allowed', context: 'current-context' };
        },
      })
      .start();
    const status =
      eligibility === 'allowed' ? 'resolved' : eligibility === 'revoked' ? 'cancelled' : 'waiting';
    await eventually(async () => {
      const record = await f.read(r);
      return (
        record?.status === status &&
        (status !== 'waiting' || record.observation?.outcome === 'unknown')
      );
    });
    assert.equal(source.calls.length, eligibility === 'allowed' ? 1 : 0);
    assert.equal(source.closes, 1);
    assert.equal(source.callbacks.has(r.waitId), false);
    assert.deepEqual(f.errors, []);
  });
}

for (const stop of ['cancel', 'expire', 'close'] as const) {
  test(`${stop} interrupts a prepared read waiting for source cooldown`, async (t) => {
    const f = await fixture(t);
    const a = await f.wait('a');
    const b = await f.wait('b', { deadlineAt: 1_250 });
    const source = new Source();
    const gate = deferred<void>();
    const subscribe = source.subscribe.bind(source);
    source.subscribe = async (input, changed) => {
      if (input.wait.waitId === b.waitId) await gate.promise;
      return subscribe(input, changed);
    };
    source.behavior = async () => ({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
    const manager = f.manager(source, { policy: { ...policy, maxPerSource: 2 } });
    await manager.start();
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
    gate.resolve();
    await eventually(() => [...f.clock.timers.values()].some((timer) => timer.at === b.deadlineAt));
    if (stop === 'cancel')
      await manager.cancel({ sessionId: b.sessionId, waitId: b.waitId }, 'user_cancelled');
    else if (stop === 'close') await manager.close();
    await f.clock.advance(300);
    assert.equal(source.calls.filter((call) => call.wait.waitId === b.waitId).length, 0);
    assert.equal(source.callbacks.has(b.waitId), false);
    assert.equal(
      (await f.read(b))?.status,
      stop === 'cancel' ? 'cancelled' : stop === 'expire' ? 'expired' : 'waiting',
    );
    if (stop === 'close') assert.equal(f.clock.timers.size, 0);
    assert.deepEqual(f.errors, []);
  });
}

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: mixed-source pagination observes every peer before expiry`, async (t) => {
    const f = await fixture(t, backend);
    const waits: EventWaitRecord[] = [];
    for (const [waitId, connectionId] of [
      ['a', 'same'],
      ['b', 'same'],
      ['c', 'same'],
      ['d', 'other'],
    ]) {
      waits.push(
        await f.wait(waitId, {
          deadlineAt: 1_500,
          resource: { providerId: 'fake', connectionId, resourceType: 'task', resourceId: waitId },
        }),
      );
    }
    const source = new Source();
    source.behavior = async ({ wait }) => (wait.waitId === 'c' ? satisfied() : { kind: 'pending' });
    await f
      .manager(source, {
        policy: {
          ...policy,
          pageSize: 3,
          maxConcurrent: 1,
          minIntervalMs: 30,
          pollIntervalMs: 30,
          maxAttempts: 100,
        },
      })
      .start();
    // Finish each page's observation before advancing virtual time. Otherwise real
    // lease I/O can still be pending when the clock passes the waits' deadlines.
    for (let observed = 1; observed <= waits.length; observed++) {
      await eventually(async () => {
        const records = await Promise.all(waits.map((wait) => f.read(wait)));
        return (
          records.filter((record) => record?.observation?.lastObservedAt != null).length >= observed
        );
      });
      if (observed < waits.length) await f.clock.advance(30);
    }
    await f.clock.advance(1_600 - f.clock.now());
    assert.equal((await f.read(waits[2]))?.status, 'resolved');
    for (const wait of waits)
      assert.ok(source.calls.some((call) => call.wait.waitId === wait.waitId));
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: resolved reads retain their source interval after restart and cleanup`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a');
    await f.wait('b');
    const source = new Source();
    const reads: number[] = [];
    source.behavior = async () => {
      reads.push(f.clock.now());
      return satisfied();
    };
    await f.manager(source).start();
    await eventually(async () => (await f.read(a))?.status === 'resolved');
    await f.stores.purgeConversationOperationalState(a.sessionId);
    await f.reopen();
    await f.manager(source).start();
    await f.clock.advance(19);
    assert.deepEqual(reads, [1_000]);
    await f.clock.advance(21);
    await eventually(() => reads.length === 2);
    assert.ok(reads[1] - reads[0] >= policy.minIntervalMs);
    assert.deepEqual(f.errors, []);
  });

  test(`${backend}: restart measures source interval from actual read dispatch`, async (t) => {
    const f = await fixture(t, backend);
    const a = await f.wait('a');
    await f.wait('b');
    const source = new Source();
    const gate = deferred<void>();
    let preparing = false;
    const reads: number[] = [];
    source.behavior = async () => {
      reads.push(f.clock.now());
      return { kind: 'pending' };
    };
    await f
      .manager(source, {
        authorize: async (wait) => {
          if (wait.waitId === a.waitId) {
            preparing = true;
            await gate.promise;
          }
          return { kind: 'allowed', context: null };
        },
      })
      .start();
    await eventually(() => preparing);
    await f.clock.advance(19);
    gate.resolve();
    await eventually(async () => (await f.read(a))?.observation?.outcome === 'pending');
    await f.reopen();
    await f.manager(source).start();
    await f.clock.advance(19);
    assert.deepEqual(reads, [1_019]);
    await f.clock.advance(21);
    await eventually(() => reads.length === 2);
    assert.ok(reads[1] - reads[0] >= policy.minIntervalMs);
    assert.deepEqual(f.errors, []);
  });
}

for (const subscriptions of [true, false]) {
  test(`archive aborts cooperative reads and frees capacity (subscriptions=${subscriptions})`, async (t) => {
    const f = await fixture(t);
    const a = await f.wait('a');
    const b = await f.wait('b', {
      resource: {
        providerId: 'fake',
        connectionId: 'other',
        resourceType: 'task',
        resourceId: 'b',
      },
    });
    const source = new Source();
    source.behavior = ({ wait, signal }) =>
      wait.waitId === a.waitId
        ? new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ kind: 'pending' }), { once: true });
          })
        : Promise.resolve(satisfied());
    const adapter: EventWaitSourceAdapter = subscriptions
      ? source
      : {
          providerId: source.providerId,
          resourceType: source.resourceType,
          conditionType: source.conditionType,
          conditionVersion: source.conditionVersion,
          reconciliation: source.reconciliation,
          validate: (wait) => source.validate(wait),
          read: (input) => source.read(input),
        };
    await f.manager(adapter, { policy: { ...policy, maxConcurrent: 1 } }).start();
    await eventually(() => source.calls.length === 1);
    await f.stores.sessionStore.setSessionsArchivedVersioned(
      [
        {
          sessionId: a.sessionId,
          expectedVersion: (await f.stores.sessionStore.readHeaderRecordSnapshot(a.sessionId))
            .revision,
        },
      ],
      true,
    );
    await f.clock.advance(40);
    assert.equal(await f.read(a), undefined);
    assert.equal(source.calls[0].signal.aborted, true);
    assert.equal(source.callbacks.has(a.waitId), false);
    assert.equal((await f.read(b))?.status, 'resolved');
    assert.deepEqual(f.errors, []);
  });
}

test('cleanup interrupts a prepared read waiting for cooldown and releases capacity', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a', { deadlineAt: 3_000 });
  const b = await f.wait('b', { deadlineAt: 3_000 });
  const source = new Source();
  const firstRead = deferred<EventWaitObservationResult>();
  const setupGate = deferred<void>();
  const subscribe = source.subscribe.bind(source);
  source.subscribe = async (input, changed) => {
    if (input.wait.waitId === b.waitId) await setupGate.promise;
    return subscribe(input, changed);
  };
  source.behavior = async () => firstRead.promise;
  await f.manager(source, { policy: { ...policy, maxPerSource: 2 } }).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(40);
  firstRead.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  setupGate.resolve();
  await eventually(() => [...f.clock.timers.values()].some((timer) => timer.at === 1_540));
  await f.stores.purgeConversationOperationalState(b.sessionId);
  await f.clock.advance(20);
  const c = await f.wait('c', {
    resource: { providerId: 'fake', connectionId: 'C', resourceType: 'task', resourceId: 'c' },
  });
  const d = await f.wait('d', {
    resource: { providerId: 'fake', connectionId: 'D', resourceType: 'task', resourceId: 'd' },
  });
  source.behavior = ({ wait, signal }) =>
    wait.waitId === c.waitId
      ? new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'pending' }), { once: true });
        })
      : Promise.resolve(satisfied());
  await f.clock.advance(30);
  assert.equal(source.callbacks.has(b.waitId), false);
  assert.equal(
    source.calls.some((call) => call.wait.waitId === b.waitId),
    false,
  );
  assert.equal((await f.read(d))?.status, 'resolved');
  assert.deepEqual(f.errors, []);
});

test('a transient Retry-After persistence failure preserves the source limit across restart', async (t) => {
  let writes = 0;
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit(op) {
      // Dispatch reservations are separate; fail the first Retry-After fact write.
      if (op === 'eventWait.extendSourceCooldown' && ++writes === 1)
        throw new Error('transient cooldown write failure');
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a', { deadlineAt: 3_000 });
  await f.wait('b', { deadlineAt: 3_000 });
  const source = new Source();
  source.behavior = async () => ({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await f.manager(source).start();
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  assert.equal((await f.read(a))?.observation?.reason, 'rate_limited');
  assert.equal((await f.read(a))?.observation?.nextObserveAt, 1_500);
  await f.stores.purgeConversationOperationalState(a.sessionId);
  await f.reopen();
  const restored = new Source();
  restored.behavior = async () => satisfied();
  await f.manager(restored).start();
  await f.clock.advance(499);
  assert.equal(restored.calls.length, 0);
  await f.clock.advance(31);
  await eventually(() => restored.calls.length === 1);
  assert.deepEqual(f.errors, []);
});

test('failed Retry-After writes remain retryable after their wait is removed', async (t) => {
  let unavailable = true;
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit(op) {
      if (op === 'eventWait.extendSourceCooldown' && unavailable)
        throw new Error('cooldown storage unavailable');
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a', { deadlineAt: 3_000 });
  await f.wait('b', { deadlineAt: 3_000 });
  const source = new Source();
  source.behavior = async () => ({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await f.manager(source).start();
  await eventually(() => f.errors.length === 1);
  assert.equal((await f.read(a))?.observation?.outcome, 'checking');
  await f.stores.purgeConversationOperationalState(a.sessionId);
  unavailable = false;
  await f.clock.advance(10);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_500,
  );
  await f.reopen();
  const restored = new Source();
  restored.behavior = async () => satisfied();
  await f.manager(restored).start();
  await f.clock.advance(489);
  assert.equal(restored.calls.length, 0);
  await f.clock.advance(31);
  await eventually(() => restored.calls.length === 1);
  assert.equal(f.errors.length, 1);
});

for (const recovery of ['write_recovers', 'cooldown_expires'] as const) {
  test(`a saturated pending cooldown buffer pauses new observation until ${recovery}`, async (t) => {
    let unavailable = true;
    const deadlines: number[] = [];
    const base = createMemoryExecutionPersistenceProvider();
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async extendSourceCooldown(cooldown) {
              deadlines.push(cooldown.until);
              if (unavailable) throw new Error('cooldown storage unavailable');
              return stores.eventWaitStore.extendSourceCooldown(cooldown);
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const a = await f.wait('a', { deadlineAt: 3_000 });
    const source = new Source();
    source.behavior = async ({ wait }) =>
      wait.waitId === a.waitId
        ? { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 }
        : satisfied();
    await f.manager(source, { policy: { ...policy, maxSourceCooldowns: 1 } }).start();
    await eventually(() => f.errors.length === 1);
    // Keep the source fact even after the originating wait is removed.
    await f.stores.purgeConversationOperationalState(a.sessionId);
    const healthy = {
      providerId: 'fake',
      connectionId: 'healthy',
      resourceType: 'task',
      resourceId: 'ready',
    };
    const expiring = await f.wait('b', { resource: healthy, deadlineAt: 1_200 });
    const healthyWait = await f.wait('c', { resource: healthy, deadlineAt: 3_000 });
    const sameSourceWait = await f.wait('d', { deadlineAt: 3_000 });
    await f.clock.advance(210);
    assert.deepEqual(
      source.calls.map(({ wait }) => wait.waitId),
      ['a'],
    );
    assert.equal((await f.read(expiring))?.status, 'expired', 'expiry continues while saturated');
    assert.equal((await f.read(healthyWait))?.observation, undefined);

    if (recovery === 'write_recovers') {
      unavailable = false;
      await f.clock.advance(10);
      await eventually(async () => (await f.read(healthyWait))?.status === 'resolved');
      assert.equal(
        await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        }),
        1_500,
        'retrying persistence must not restart the source cooldown',
      );
    }
    await f.clock.advance(1_499 - f.clock.now());
    assert.equal(
      source.calls.some(({ wait }) => wait.waitId === sameSourceWait.waitId),
      false,
    );
    if (recovery === 'cooldown_expires') {
      assert.equal((await f.read(healthyWait))?.status, 'waiting');
      assert.equal(source.calls.length, 1);
    }
    const writesBeforeExpiry = deadlines.length;
    const errorsBeforeExpiry = f.errors.length;
    await f.clock.advance(31);
    await eventually(async () => (await f.read(healthyWait))?.status === 'resolved');
    await eventually(async () => (await f.read(sameSourceWait))?.status === 'resolved');
    assert.deepEqual(source.calls.map(({ wait }) => wait.waitId).sort(), ['a', 'c', 'd']);
    assert.equal(deadlines.length, writesBeforeExpiry, 'expired pending facts are not retried');
    assert.equal(f.errors.length, errorsBeforeExpiry);
    assert.ok(deadlines.every((until) => until === 1_500));
    assert.equal((await f.read(expiring))?.status, 'expired');
  });
}

test('failed dispatch completion does not release an uncooperative source request', async (t) => {
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit(op) {
      if (op === 'eventWait.completeSourceDispatch') throw new Error('completion write failure');
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  await f.wait('b');
  const source = new Source();
  const gate = deferred<EventWaitObservationResult>();
  source.behavior = () => gate.promise;
  await f.manager(source, { policy: { ...policy, maxConcurrent: 1 } }).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(200);
  assert.equal(source.calls.length, 1);
  assert.equal(source.calls[0].signal.aborted, true);
  assert.equal((await f.read(a))?.status, 'waiting');
  gate.resolve(satisfied());
  await settle();
});

test('interleaved source turns do not wrap before later pages are scanned', async (t) => {
  const f = await fixture(t);
  const waits: EventWaitRecord[] = [];
  for (const [n, connectionId] of [...'aabcbb'].entries()) {
    const waitId = `wait-${n}`;
    waits.push(
      await f.wait(waitId, {
        deadlineAt: 2_500,
        resource: { providerId: 'fake', connectionId, resourceType: 'task', resourceId: waitId },
      }),
    );
  }
  const source = new Source();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 3, minIntervalMs: 30, pollIntervalMs: 30, maxAttempts: 100 },
    })
    .start();
  await eventually(() => source.calls.length > 0);
  await f.clock.advance(900);
  for (const wait of waits)
    assert.ok(
      source.calls.filter((call) => call.wait.waitId === wait.waitId).length >= 2,
      wait.waitId,
    );
  assert.deepEqual(f.errors, []);
});

for (const failCooldown of [false, true]) {
  test(`pre-read authorization Retry-After survives failed dispatch completion (cooldown write fails=${failCooldown})`, async (t) => {
    let completions = 0;
    let cooldownUnavailable = failCooldown;
    const provider = createMemoryExecutionPersistenceProvider({
      beforeCommit(op) {
        if (op === 'eventWait.completeSourceDispatch' && ++completions <= 2)
          throw new Error('completion write failure');
        if (op === 'eventWait.extendSourceCooldown' && cooldownUnavailable)
          throw new Error('cooldown write failure');
      },
    });
    const f = await fixture(t, 'Memory', provider);
    const a = await f.wait('a');
    const b = await f.wait('b');
    const source = new Source();
    source.behavior = async () => satisfied();
    let checks = 0;
    await f
      .manager(source, {
        authorize: async () =>
          ++checks === 2
            ? { kind: 'unknown', reason: 'auth_rate_limited', retryAfterMs: 500 }
            : { kind: 'allowed', context: null },
      })
      .start();
    await eventually(() => f.errors.length === 1);
    assert.equal(completions, 2);
    assert.equal(checks, 2);
    assert.equal((await f.read(a))?.observation?.outcome, 'checking');
    await f.stores.purgeConversationOperationalState(a.sessionId);
    await f.clock.advance(120);
    assert.equal(checks, 2, 'same-source authorization must respect the retained source fact');
    assert.equal(source.calls.length, 0);
    cooldownUnavailable = false;
    await f.clock.advance(10);
    await eventually(
      async () =>
        (await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        })) === 1_500,
    );
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_500,
      'persistence retries retain the original absolute cooldown',
    );
    await f.reopen();
    const restored = new Source();
    restored.behavior = async () => satisfied();
    await f.manager(restored).start();
    await f.clock.advance(1_499 - f.clock.now());
    assert.equal(restored.calls.length, 0);
    await f.clock.advance(31);
    await eventually(async () => (await f.read(b))?.status === 'resolved');
    assert.equal(restored.calls.length, 1);
  });
}

test('slow dispatch completion does not restart a pre-read authorization Retry-After', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const gate = deferred<void>();
  let completing = false;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async completeSourceDispatch(dispatch) {
            completing = true;
            await gate.promise;
            return stores.eventWaitStore.completeSourceDispatch(dispatch);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  const source = new Source();
  let checks = 0;
  await f
    .manager(source, {
      authorize: async () =>
        ++checks === 2
          ? { kind: 'unknown', reason: 'auth_rate_limited', retryAfterMs: 500 }
          : { kind: 'allowed', context: null },
    })
    .start();
  await eventually(() => completing);
  await f.clock.advance(100);
  const beforeCompletion = await f.stores.eventWaitStore.readSourceCooldown({
    providerId: 'fake',
    connectionId: null,
  });
  gate.resolve();
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  assert.equal(beforeCompletion, 1_500);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_500,
    'the caller must not persist the same Retry-After again after cleanup',
  );
  assert.equal(checks, 2);
  assert.equal(source.calls.length, 0);
  assert.deepEqual(f.errors, []);
});

test('malformed pre-read authorization cannot establish a source cooldown', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a');
  const b = await f.wait('b');
  const source = new Source();
  source.behavior = async () => satisfied();
  let checks = 0;
  await f
    .manager(source, {
      authorize: async () =>
        ++checks === 2
          ? { kind: 'unknown', reason: 'x'.repeat(2_048), retryAfterMs: 500 }
          : { kind: 'allowed', context: null },
    })
    .start();
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  assert.equal(source.calls.length, 0);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_000,
  );
  await f.clock.advance(30);
  await eventually(async () => (await f.read(b))?.status === 'resolved');
  assert.equal(source.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

test('slow dispatch completion does not discard an already observed Retry-After', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const gate = deferred<void>();
  let writes = 0;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async completeSourceDispatch(dispatch) {
            if (++writes === 1) await gate.promise;
            return stores.eventWaitStore.completeSourceDispatch(dispatch);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  await f.wait('b');
  const source = new Source();
  source.behavior = async () => ({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
  await f.manager(source, { policy: { ...policy, maxPerSource: 2 } }).start();
  await eventually(() => source.calls.length === 1);
  await f.clock.advance(100);
  assert.equal(source.calls.length, 1);
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_500,
  );
  gate.resolve();
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  assert.equal((await f.read(a))?.observation?.reason, 'rate_limited');
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    1_500,
    'dispatch completion cannot shrink a newer Retry-After',
  );
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: a full cooldown cache preserves independent sources and restart limits`, async (t) => {
    const f = await fixture(t, backend);
    const waits = [];
    for (const waitId of ['a', 'b', 'c']) {
      waits.push(
        await f.wait(waitId, {
          deadlineAt: waitId === 'c' ? 1_300 : 2_000,
          resource: {
            providerId: 'fake',
            connectionId: waitId,
            resourceType: 'task',
            resourceId: waitId,
          },
        }),
      );
    }
    const source = new Source();
    source.behavior = async ({ wait }) =>
      wait.waitId === 'c'
        ? satisfied()
        : { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 };
    await f.manager(source, { policy: { ...policy, maxSourceCooldowns: 1 } }).start();
    await eventually(() => source.calls.length > 0);
    await f.clock.advance(100);
    assert.equal((await f.read(waits[2]))?.status, 'resolved');
    assert.deepEqual(source.calls.map(({ wait }) => wait.waitId).sort(), ['a', 'b', 'c']);
    await f.reopen();
    const restored = new Source();
    restored.behavior = async () => satisfied();
    await f.manager(restored, { policy: { ...policy, maxSourceCooldowns: 1 } }).start();
    await f.clock.advance(300);
    assert.equal(restored.calls.length, 0, 'evicted source limits remain durable');
    await f.clock.advance(200);
    assert.equal((await f.read(waits[0]))?.status, 'resolved');
    assert.equal((await f.read(waits[1]))?.status, 'resolved');
    assert.deepEqual(f.errors, []);
  });
}

test('a shorter Retry-After received during dispatch persistence is not masked by its reservation', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const gate = deferred<void>();
  let preparing = false;
  let writes = 0;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async reserveSourceDispatch(cooldown) {
            if (++writes === 2) {
              preparing = true;
              await gate.promise;
            }
            return stores.eventWaitStore.reserveSourceDispatch(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  const b = await f.wait('b');
  const first = deferred<EventWaitObservationResult>();
  const source = new Source();
  const reads: { id: string; at: number }[] = [];
  source.behavior = async ({ wait }) => {
    reads.push({ id: wait.waitId, at: f.clock.now() });
    return wait.waitId === a.waitId ? first.promise : satisfied();
  };
  await f
    .manager(source, { policy: { ...policy, maxPerSource: 2, maxSourceCooldowns: 1 } })
    .start();
  await eventually(() => reads.length === 1);
  await f.clock.advance(20);
  await eventually(() => preparing);
  first.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 20 });
  await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
  gate.resolve();
  await settle();
  assert.equal(reads.length, 1, 'a later source fact must override the prepared dispatch');
  await f.clock.advance(19);
  assert.equal(reads.length, 1);
  await f.clock.advance(61);
  assert.equal((await f.read(b))?.status, 'resolved');
  assert.ok(reads.find(({ id }) => id === b.waitId)!.at >= 1_040);
  assert.deepEqual(f.errors, []);
});

for (const outcome of ['resume', 'cancel', 'expire', 'close'] as const) {
  test(`${outcome}: peer Retry-After releases the dispatch reservation without consuming another attempt`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const acknowledgement = deferred<void>();
    const reservations: { token: string; observedAt: number; until: number }[] = [];
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async reserveSourceDispatch(dispatch) {
              const reserved = await stores.eventWaitStore.reserveSourceDispatch(dispatch);
              if (reserved) {
                reservations.push(dispatch);
                // The peer's Retry-After arrives after B owns a durable reservation,
                // but before its acknowledgement permits the pre-read access check.
                if (reservations.length === 2) await acknowledgement.promise;
              }
              return reserved;
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const a = await f.wait('a', { deadlineAt: 3_000 });
    const b = await f.wait('b', { deadlineAt: outcome === 'expire' ? 1_200 : 3_000 });
    const first = deferred<EventWaitObservationResult>();
    const source = new Source();
    const reads: { id: string; at: number }[] = [];
    const checks: number[] = [];
    source.behavior = async ({ wait }) => {
      reads.push({ id: wait.waitId, at: f.clock.now() });
      return wait.waitId === a.waitId ? first.promise : satisfied();
    };
    const manager = f.manager(source, {
      policy: { ...policy, maxPerSource: 2, maxAttempts: 1 },
      authorize: async (wait) => {
        if (wait.waitId === b.waitId) checks.push(f.clock.now());
        return { kind: 'allowed', context: null };
      },
    });
    try {
      await manager.start();
      await eventually(() => reads.length === 1);
      await f.clock.advance(policy.minIntervalMs);
      await eventually(() => reservations.length === 2);
      const until = f.clock.now() + 500;
      first.resolve({ kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 });
      await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
      acknowledgement.resolve();
      await settle();
      await f.clock.advance(policy.readTimeoutMs + 10);
      assert.equal((await f.read(b))?.observation?.outcome, 'checking');
      assert.equal((await f.read(b))?.observation?.attempts, 1);
      assert.deepEqual(
        reads.map(({ id }) => id),
        [a.waitId],
      );
      assert.deepEqual(checks, [1_000], 'cooldown gates pre-read authorization too');
      assert.equal(
        await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        }),
        until,
        'releasing a reservation must retain the shared Retry-After',
      );
      if (outcome === 'cancel')
        await manager.cancel({ sessionId: b.sessionId, waitId: b.waitId }, 'user_cancelled');
      else if (outcome === 'close') await manager.close();

      await f.clock.advance(until - f.clock.now() - 1);
      assert.deepEqual(
        reads.map(({ id }) => id),
        [a.waitId],
      );
      await f.clock.advance(1);
      if (outcome === 'resume') {
        await eventually(async () => (await f.read(b))?.status === 'resolved');
        const record = await f.read(b);
        assert.equal(record?.status, 'resolved');
        if (record?.status === 'resolved') assert.equal(record.resolution.outcome, 'satisfied');
        assert.equal(record?.observation?.attempts, 1);
        assert.equal(record?.observation?.consecutiveErrors, 0);
        assert.deepEqual(reads, [
          { id: a.waitId, at: 1_000 },
          { id: b.waitId, at: until },
        ]);
        assert.deepEqual(checks, [1_000, until, until]);
        assert.equal(reservations.length, 3, 'resumption needs a new durable dispatch reservation');
        assert.notEqual(reservations[2].token, reservations[1].token);
        assert.equal(reservations[2].observedAt, until);
        assert.ok(reservations[2].until > until);
      } else {
        await f.clock.advance(100);
        assert.equal(
          (await f.read(b))?.status,
          outcome === 'cancel' ? 'cancelled' : outcome === 'expire' ? 'expired' : 'waiting',
        );
        assert.deepEqual(checks, [1_000]);
        assert.deepEqual(
          reads.map(({ id }) => id),
          [a.waitId],
        );
        assert.equal(reservations.length, 2, 'interruption prevents reservation renewal');
        assert.equal(source.callbacks.has(b.waitId), false);
      }
      assert.deepEqual(f.errors, []);
    } finally {
      acknowledgement.resolve();
      first.resolve({ kind: 'pending' });
      await settle();
    }
  });
}

test('failed dispatch reservation writes prevent source reads', async (t) => {
  let writes = 0;
  const provider = createMemoryExecutionPersistenceProvider({
    beforeCommit(op) {
      if (op === 'eventWait.reserveSourceDispatch') {
        writes++;
        throw new Error('dispatch reservation storage unavailable');
      }
    },
  });
  const f = await fixture(t, 'Memory', provider);
  const r = await f.wait();
  const source = new Source();
  source.behavior = async () => satisfied();
  await f.manager(source).start();
  await eventually(() => f.errors.length === 1);
  assert.equal(writes, 2);
  assert.equal(source.calls.length, 0, 'an unacknowledged reservation cannot authorize a read');
  assert.equal((await f.read(r))?.status, 'waiting');
  assert.equal((await f.read(r))?.observation?.outcome, 'checking');
  assert.equal(
    await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
    null,
  );
  assert.equal(f.errors.length, 1);
});

for (const interruption of ['dispatch-window', 'cancel', 'expire', 'close'] as const) {
  test(`${interruption} prevents dispatch after delayed reservation persistence`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const gate = deferred<void>();
    let writes = 0;
    let acknowledged = false;
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async reserveSourceDispatch(dispatch) {
              if (++writes === 1) await gate.promise;
              const result = await stores.eventWaitStore.reserveSourceDispatch(dispatch);
              acknowledged = true;
              return result;
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const r = await f.wait('delayed-dispatch', {
      deadlineAt: interruption === 'expire' ? 1_030 : 2_000,
    });
    const source = new Source();
    source.behavior = async () => satisfied();
    const manager = f.manager(source);
    try {
      await manager.start();
      await eventually(() => writes === 1);
      assert.equal(source.calls.length, 0, 'reads must await durable reservation acknowledgement');
      if (interruption === 'dispatch-window') {
        await f.clock.advance(policy.readTimeoutMs + 10);
      } else if (interruption === 'cancel') {
        await manager.cancel({ sessionId: r.sessionId, waitId: r.waitId }, 'user_cancelled');
      } else if (interruption === 'expire') {
        await f.clock.advance(r.deadlineAt - f.clock.now());
        await eventually(async () => (await f.read(r))?.status === 'expired');
      } else {
        const closing = manager.close();
        await f.clock.advance(policy.closeTimeoutMs);
        await closing;
      }
      gate.resolve();
      await eventually(() => acknowledged);
      if (interruption === 'dispatch-window') {
        await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
        assert.equal((await f.read(r))?.observation?.reason, 'observation_timeout');
      }
      await settle();
      assert.equal(source.calls.length, 0, 'a completed write cannot revive an invalid dispatch');
      assert.equal(
        (await f.read(r))?.status,
        interruption === 'cancel' ? 'cancelled' : interruption === 'expire' ? 'expired' : 'waiting',
      );
      assert.equal(source.callbacks.has(r.waitId), false);
      assert.deepEqual(f.errors, []);
    } finally {
      gate.resolve();
      await settle();
    }
  });
}

test('authorization slower than the minimum interval can dispatch within its reservation', async (t) => {
  const f = await fixture(t);
  const r = await f.wait();
  const source = new Source();
  const gate = deferred<void>();
  const reads: number[] = [];
  let authorizations = 0;
  source.behavior = async () => {
    reads.push(f.clock.now());
    return satisfied();
  };
  try {
    await f
      .manager(source, {
        authorize: async () => {
          // The second check is after subscription setup and durable reservation.
          if (++authorizations === 2) await gate.promise;
          return { kind: 'allowed', context: { trusted: true } };
        },
      })
      .start();
    await eventually(() => authorizations === 2);
    await f.clock.advance(60);
    assert.equal(source.calls.length, 0);
    gate.resolve();
    await eventually(async () => (await f.read(r))?.status === 'resolved');
    assert.deepEqual(reads, [1_060]);
    assert.deepEqual(f.errors, []);
  } finally {
    gate.resolve();
    await settle();
  }
});

test('rewound pagination revisits earlier peers before a later deferred waiter', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  let clock: Clock;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async reserveSourceDispatch(dispatch) {
            await new Promise<void>((resolve) => clock.schedule(resolve, 10));
            return stores.eventWaitStore.reserveSourceDispatch(dispatch);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  clock = f.clock;
  const waits = await Promise.all(Array.from({ length: 4 }, (_, n) => f.wait(`wait-${n}`)));
  const source = new Source();
  const manager = f.manager(source, {
    policy: { ...policy, pageSize: 2, minIntervalMs: 10, pollIntervalMs: 20, maxAttempts: 100 },
  });
  try {
    await manager.start();
    await eventually(async () => (await f.read(waits[0]))?.observation?.outcome === 'checking');
    await f.clock.advance(300);
    const firstTwoCycles = source.calls.slice(0, 8).map(({ wait }) => wait.waitId);
    assert.deepEqual(
      firstTwoCycles,
      [...waits, ...waits].map(({ waitId }) => waitId),
    );
    assert.deepEqual(f.errors, []);
  } finally {
    const closing = manager.close();
    await f.clock.advance(100);
    await closing;
  }
});

for (const backend of ['Local', 'Memory'] as const) {
  test(`${backend}: a full source hint cache preserves polling turns across pages`, async (t) => {
    const f = await fixture(t, backend);
    const waits: EventWaitRecord[] = [];
    for (let n = 0; n < 5; n++) {
      const waitId = `wait-${n}`;
      waits.push(
        await f.wait(waitId, {
          deadlineAt: 2_500,
          resource: {
            providerId: 'fake',
            connectionId: n === 0 ? 'a' : 'b',
            resourceType: 'task',
            resourceId: waitId,
          },
        }),
      );
    }
    const source = new Source();
    const manager = f.manager(source, {
      policy: {
        ...policy,
        pageSize: 3,
        maxSourceCooldowns: 1,
        minIntervalMs: 20,
        pollIntervalMs: 20,
        maxAttempts: 1_000,
      },
    });
    try {
      await manager.start();
      await eventually(async () => (await f.read(waits[0]))?.observation?.outcome === 'pending');
      for (let n = 0; n < 100; n++) {
        await f.clock.advance(10);
        // Drain durable reads between ticks, including filesystem lease validation.
        await Promise.all(waits.map((wait) => f.read(wait)));
      }
      for (const wait of waits) {
        const reads = source.calls.filter((call) => call.wait.waitId === wait.waitId).length;
        assert.ok(reads >= 2, `${wait.waitId} must retain repeated polling opportunities`);
        assert.equal((await f.read(wait))?.status, 'waiting');
      }
      assert.deepEqual(f.errors, []);
    } finally {
      const closing = manager.close();
      await f.clock.advance(100);
      await closing;
    }
  });
}

test('a full deferred hint cache does not skip an already-satisfied wait before expiry', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  let clock: Clock;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async reserveSourceDispatch(dispatch) {
            await new Promise<void>((resolve) => clock.schedule(resolve, 10));
            return stores.eventWaitStore.reserveSourceDispatch(dispatch);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  clock = f.clock;
  const waits: EventWaitRecord[] = [];
  for (const [n, connectionId] of [...'abcabcabcabc'].entries()) {
    const waitId = `wait-${String(n).padStart(2, '0')}`;
    waits.push(
      await f.wait(waitId, {
        deadlineAt: 2_500,
        resource: { providerId: 'fake', connectionId, resourceType: 'task', resourceId: waitId },
      }),
    );
  }
  const target = waits[3];
  const source = new Source();
  source.behavior = async ({ wait }) =>
    wait.waitId === target.waitId ? satisfied() : { kind: 'pending' };
  const manager = f.manager(source, {
    policy: {
      ...policy,
      pageSize: 3,
      maxSourceCooldowns: 1,
      minIntervalMs: 10,
      pollIntervalMs: 20,
      maxAttempts: 1_000,
    },
  });
  try {
    await manager.start();
    await eventually(async () => (await f.read(waits[0]))?.observation?.outcome === 'checking');
    for (let n = 0; n < 160; n++) {
      await f.clock.advance(10);
      // Settle storage work before advancing the controlled reservation delay again.
      await Promise.all(waits.map((wait) => f.read(wait)));
    }
    const record = await f.read(target);
    assert.ok(record);
    assert.equal(record.status, 'resolved');
    assert.ok(record.updatedAt < target.deadlineAt);
    assert.equal(source.calls.filter((call) => call.wait.waitId === target.waitId).length, 1);
    assert.deepEqual(f.errors, []);
  } finally {
    const closing = manager.close();
    await f.clock.advance(100);
    await closing;
  }
});

test('a source becoming ready between scans serves its oldest wait first', async (t) => {
  const f = await fixture(t);
  const waits = [await f.wait('a'), await f.wait('b')];
  await f.stores.eventWaitStore.extendSourceCooldown({
    providerId: 'fake',
    connectionId: null,
    observedAt: f.clock.now(),
    until: f.clock.now() + 10,
  });
  const source = new Source();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 1, pollIntervalMs: 20, maxAttempts: 100 },
    })
    .start();
  assert.equal(source.calls.length, 0);
  await f.clock.advance(10);
  await eventually(async () => (await f.read(waits[0]))?.observation?.outcome === 'pending');
  for (let n = 0; n < 30; n++) {
    await f.clock.advance(20);
    await Promise.all(waits.map((wait) => f.read(wait)));
  }
  // Continuing a page cursor after the blocked 'a' would let 'b' repeatedly
  // consume the next available source turn, leaving 'a' unobserved.
  assert.deepEqual(
    source.calls.slice(0, 6).map(({ wait }) => wait.waitId),
    ['a', 'b', 'a', 'b', 'a', 'b'],
  );
  assert.deepEqual(f.errors, []);
});

test('durably cooled sources cannot fill the observation page ahead of a ready source', async (t) => {
  const f = await fixture(t, 'Local');
  const cooled: EventWaitRecord[] = [];
  for (let n = 0; n < 8; n++) {
    const waitId = `a-${n}`;
    cooled.push(
      await f.wait(waitId, {
        resource: {
          providerId: 'fake',
          connectionId: 'cooled',
          resourceType: 'task',
          resourceId: waitId,
        },
      }),
    );
  }
  const ready = await f.wait('z-ready', {
    deadlineAt: f.clock.now() + 100,
    resource: {
      providerId: 'fake',
      connectionId: 'ready',
      resourceType: 'task',
      resourceId: 'z-ready',
    },
  });
  await f.stores.eventWaitStore.extendSourceCooldown({
    providerId: 'fake',
    connectionId: 'cooled',
    observedAt: f.clock.now(),
    until: f.clock.now() + 1_000,
  });
  const source = new Source();
  source.behavior = async () => satisfied();
  await f.manager(source, { policy: { ...policy, pageSize: 2 } }).start();
  // The cooldown is only in storage when the manager starts; filtering after
  // LIMIT would repeatedly return cooled waits and hide the ready connection.
  await eventually(async () => (await f.read(ready))?.status === 'resolved');
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    [ready.waitId],
  );
  for (const wait of cooled) assert.equal((await f.read(wait))?.observation, undefined);
  assert.deepEqual(f.errors, []);
});

test('a source filling its lane does not hide another source behind its waiting peers', async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 8; n++) {
    const waitId = `a-${n}`;
    await f.wait(waitId, {
      resource: {
        providerId: 'fake',
        connectionId: 'busy',
        resourceType: 'task',
        resourceId: waitId,
      },
    });
  }
  const ready = await f.wait('z-ready', {
    resource: {
      providerId: 'fake',
      connectionId: 'ready',
      resourceType: 'task',
      resourceId: 'z-ready',
    },
  });
  const gate = deferred<EventWaitObservationResult>();
  const source = new Source();
  source.behavior = async ({ wait }) =>
    wait.resource.connectionId === 'busy' ? gate.promise : satisfied();
  try {
    await f.manager(source, { policy: { ...policy, pageSize: 2 } }).start();
    // Both slots must be used in this scan, even though the two oldest waits
    // initially belong to the same source and only one can occupy its lane.
    await eventually(async () => (await f.read(ready))?.status === 'resolved');
    assert.deepEqual(source.calls.map(({ wait }) => wait.waitId).sort(), ['a-0', 'z-ready']);
    assert.equal(f.clock.now(), 1_000);
    assert.deepEqual(f.errors, []);
  } finally {
    gate.resolve({ kind: 'pending' });
    await settle();
  }
});

// Preserve the same absolute Retry-After through every fact boundary and the
// adjacent persistence awaits; ordinary per-wait backoff still starts at finish.
for (const scenario of [
  { phase: 1, blocked: 'cooldown', delay: 300, restart: true },
  { phase: 2, blocked: 'cooldown', delay: 300, restart: true },
  { phase: 3, blocked: 'cooldown', delay: 300, restart: true },
  { phase: 'read', blocked: 'cooldown', delay: 300, restart: true },
  { phase: 'read', blocked: 'cooldown', delay: 600, restart: false },
  { phase: 2, blocked: 'dispatch', delay: 300, restart: false },
  { phase: 'read', blocked: 'dispatch', delay: 300, restart: false },
] as const) {
  test(`Retry-After checkpoint at ${scenario.phase} survives slow ${scenario.blocked} persistence (${scenario.delay}ms, restart=${scenario.restart})`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const gate = deferred<void>();
    let blocked = false;
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async extendSourceCooldown(input) {
              if (scenario.blocked === 'cooldown' && !blocked) {
                blocked = true;
                await gate.promise;
              }
              return stores.eventWaitStore.extendSourceCooldown(input);
            },
            async completeSourceDispatch(input) {
              if (scenario.blocked === 'dispatch' && !blocked) {
                blocked = true;
                await gate.promise;
              }
              return stores.eventWaitStore.completeSourceDispatch(input);
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const nextObserveAt = Math.max(1_500, 1_000 + scenario.delay + policy.pollIntervalMs);
    const r = await f.wait('a', { deadlineAt: nextObserveAt + 150 });
    const source = new Source();
    const rateLimited: EventWaitObservationResult = {
      kind: 'unknown',
      reason: 'rate_limited',
      retryAfterMs: 500,
    };
    source.behavior = async () =>
      scenario.phase === 'read' && source.calls.length === 1 ? rateLimited : satisfied();
    let checks = 0;
    try {
      await f
        .manager(source, {
          authorize: async () =>
            ++checks === scenario.phase
              ? { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 }
              : { kind: 'allowed', context: null },
        })
        .start();
      await eventually(() => blocked);
      await f.clock.advance(scenario.delay);
      gate.resolve();
      await eventually(async () => (await f.read(r))?.observation?.outcome === 'unknown');
      const checkpoint = await f.read(r);
      assert.equal(checkpoint?.observation?.nextObserveAt, nextObserveAt);
      assert.equal(checkpoint?.observation?.nextPollAt, nextObserveAt);
      assert.equal(checkpoint?.observation?.attempts, 1);
      assert.equal(
        await f.stores.eventWaitStore.readSourceCooldown({
          providerId: 'fake',
          connectionId: null,
        }),
        1_500,
      );
      let resumed = source;
      if (scenario.restart) {
        await f.reopen();
        resumed = new Source();
        resumed.behavior = async () => satisfied();
        await f.manager(resumed).start();
      }
      const callsBeforeRetry = resumed.calls.length;
      await f.clock.advance(nextObserveAt - f.clock.now() - 1);
      assert.equal(resumed.calls.length, callsBeforeRetry, 'honor the remaining absolute delay');
      await f.clock.advance(21);
      await eventually(async () => (await f.read(r))?.status === 'resolved');
      assert.equal(resumed.calls.length, callsBeforeRetry + 1);
      assert.equal((await f.read(r))?.observation?.attempts, 2);
      assert.deepEqual(f.errors, []);
    } finally {
      gate.resolve();
    }
  });
}
for (const resumedAccess of ['allowed', 'revoked', 'cooldown'] as const) {
  test(`dispatch preparation wait retains its attempt and rechecks ${resumedAccess} access`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const authorization = deferred<void>();
    const completion = deferred<void>();
    let completing = false;
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async completeSourceDispatch(dispatch) {
              if (!completing) {
                completing = true;
                await completion.promise;
              }
              return stores.eventWaitStore.completeSourceDispatch(dispatch);
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const a = await f.wait('a', { deadlineAt: 3_000 });
    const b = await f.wait('b', { deadlineAt: 3_000 });
    const source = new Source();
    const reads: { waitId: string; at: number }[] = [];
    const checks: number[] = [];
    let aChecks = 0;
    let revoked = false;
    source.behavior = async ({ wait }) => {
      reads.push({ waitId: wait.waitId, at: f.clock.now() });
      return wait.waitId === a.waitId && resumedAccess === 'cooldown'
        ? { kind: 'unknown', reason: 'rate_limited', retryAfterMs: 500 }
        : satisfied();
    };
    const manager = f.manager(source, {
      policy: { ...policy, maxPerSource: 2, maxAttempts: 1 },
      authorize: async (wait) => {
        if (wait.waitId === a.waitId && ++aChecks === 2) await authorization.promise;
        if (wait.waitId === b.waitId) {
          checks.push(f.clock.now());
          if (revoked) return { kind: 'revoked', reason: 'control_replaced' };
        }
        return { kind: 'allowed', context: null };
      },
    });
    try {
      await manager.start();
      await eventually(() => aChecks === 2 && checks.length === 1);
      // Both source operations remain within their request timeout. The queue spans
      // A's 70ms authorization plus its successful 20ms dispatch acknowledgement.
      await f.clock.advance(70);
      authorization.resolve();
      await eventually(() => completing);
      await f.clock.advance(20);
      assert.equal((await f.read(b))?.observation?.outcome, 'checking');
      assert.equal((await f.read(b))?.observation?.attempts, 1);
      assert.equal((await f.read(b))?.observation?.consecutiveErrors, 0);
      assert.deepEqual(checks, [1_000]);
      revoked = resumedAccess === 'revoked';
      completion.resolve();
      await settle();
      if (resumedAccess === 'cooldown') {
        await eventually(async () => (await f.read(a))?.observation?.outcome === 'unknown');
        await f.clock.advance(479);
        assert.deepEqual(checks, [1_000], 'resumption must honor the peer Retry-After');
        assert.deepEqual(reads, [{ waitId: a.waitId, at: 1_070 }]);
        await f.clock.advance(1);
      }
      await eventually(async () => {
        const record = await f.read(b);
        return record?.status === (resumedAccess === 'revoked' ? 'cancelled' : 'resolved');
      });
      const record = await f.read(b);
      assert.equal(record?.observation?.attempts, 1);
      assert.equal(record?.observation?.consecutiveErrors, 0);
      if (resumedAccess === 'revoked') {
        assert.deepEqual(reads, [{ waitId: a.waitId, at: 1_070 }]);
        assert.deepEqual(checks, [1_000, 1_090]);
        assert.equal(source.callbacks.has(b.waitId), false);
      } else {
        assert.equal(record?.status, 'resolved');
        if (record?.status === 'resolved') assert.equal(record.resolution.outcome, 'satisfied');
        const resumedAt = resumedAccess === 'cooldown' ? 1_570 : 1_090;
        assert.deepEqual(reads, [
          { waitId: a.waitId, at: 1_070 },
          { waitId: b.waitId, at: resumedAt },
        ]);
        assert.deepEqual(checks, [1_000, resumedAt, resumedAt]);
      }
      assert.deepEqual(f.errors, []);
    } finally {
      authorization.resolve();
      completion.resolve();
      await settle();
    }
  });
}

for (const stop of ['cancel', 'expire', 'close'] as const) {
  test(`${stop} interrupts a dispatch preparation wait without retaining request capacity`, async (t) => {
    const base = createMemoryExecutionPersistenceProvider();
    const authorization = deferred<void>();
    const completion = deferred<void>();
    let completing = false;
    const provider: ExecutionPersistenceProvider = {
      async open(input) {
        const stores = await base.open(input);
        return {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            async completeSourceDispatch(dispatch) {
              if (!completing) {
                completing = true;
                await completion.promise;
              }
              return stores.eventWaitStore.completeSourceDispatch(dispatch);
            },
          },
        };
      },
    };
    const f = await fixture(t, 'Memory', provider);
    const a = await f.wait('a', { deadlineAt: 3_000 });
    const b = await f.wait('b', { deadlineAt: stop === 'expire' ? 1_120 : 3_000 });
    const source = new Source();
    source.behavior = async () => satisfied();
    let aChecks = 0;
    let bChecks = 0;
    const manager = f.manager(source, {
      policy: { ...policy, maxPerSource: 2, maxAttempts: 1 },
      authorize: async (wait) => {
        if (wait.waitId === a.waitId && ++aChecks === 2) await authorization.promise;
        if (wait.waitId === b.waitId) bChecks++;
        return { kind: 'allowed', context: null };
      },
    });
    try {
      await manager.start();
      await eventually(() => aChecks === 2 && bChecks === 1);
      await f.clock.advance(70);
      authorization.resolve();
      await eventually(() => completing);
      await f.clock.advance(20);
      assert.equal((await f.read(b))?.observation?.outcome, 'checking');
      if (stop === 'cancel') {
        await manager.cancel({ sessionId: b.sessionId, waitId: b.waitId }, 'user_cancelled');
      } else if (stop === 'expire') {
        await f.clock.advance(b.deadlineAt - f.clock.now());
        await eventually(async () => (await f.read(b))?.status === 'expired');
      } else {
        const closing = manager.close();
        await f.clock.advance(policy.closeTimeoutMs);
        await closing;
        assert.equal(f.clock.timers.size, 0);
      }
      const stopped = await f.read(b);
      assert.equal(
        stopped?.status,
        stop === 'cancel' ? 'cancelled' : stop === 'expire' ? 'expired' : 'waiting',
      );
      assert.equal(source.callbacks.has(b.waitId), false);
      if (stop !== 'close') {
        const c = await f.wait('c', {
          deadlineAt: 3_000,
          resource: {
            providerId: 'fake',
            connectionId: 'healthy',
            resourceType: 'task',
            resourceId: 'c',
          },
        });
        await manager.reconcile();
        await eventually(async () => (await f.read(c))?.status === 'resolved');
        assert.equal(source.calls.filter(({ wait }) => wait.waitId === c.waitId).length, 1);
      }
      completion.resolve();
      await settle();
      await f.clock.advance(100);
      assert.deepEqual(await f.read(b), stopped, 'unlock cannot revive an interrupted waiter');
      assert.equal(bChecks, 1, 'unlock cannot initiate another authorization for the stopped wait');
      assert.equal(
        source.calls.some(({ wait }) => wait.waitId === b.waitId),
        false,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      authorization.resolve();
      completion.resolve();
      await settle();
    }
  });
}

test('a failed older cooldown write cannot restore pending capacity after a stronger acknowledgement and cache eviction', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const releaseOlderWrite = deferred<void>();
  const olderAccess = deferred<EventWaitObservationAccess>();
  const newerAccess = deferred<EventWaitObservationAccess>();
  const evictingAccess = deferred<EventWaitObservationAccess>();
  const accessStarted = new Set<string>();
  let olderWrites = 0;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async extendSourceCooldown(cooldown) {
            if (cooldown.connectionId === null && cooldown.until === 1_500) {
              olderWrites++;
              await releaseOlderWrite.promise;
              throw new Error('older cooldown write failed');
            }
            return stores.eventWaitStore.extendSourceCooldown(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a', { deadlineAt: 3_000 });
  const b = await f.wait('b', { deadlineAt: 3_000 });
  const evicting = await f.wait('evicting', {
    deadlineAt: 3_000,
    resource: {
      providerId: 'fake',
      connectionId: 'evicting',
      resourceType: 'task',
      resourceId: 'evicting',
    },
  });
  const source = new Source();
  source.behavior = async () => satisfied();
  const manager = f.manager(source, {
    policy: { ...policy, maxConcurrent: 3, maxPerSource: 2, maxSourceCooldowns: 1 },
    authorize: async (wait) => {
      accessStarted.add(wait.waitId);
      if (wait.waitId === a.waitId) return olderAccess.promise;
      if (wait.waitId === b.waitId) return newerAccess.promise;
      if (wait.waitId === evicting.waitId) return evictingAccess.promise;
      return { kind: 'allowed', context: {} };
    },
  });
  try {
    await manager.start();
    await eventually(() => accessStarted.size === 3);
    olderAccess.resolve({ kind: 'unknown', reason: 'older_limit', retryAfterMs: 500 });
    await eventually(() => olderWrites === 1);
    newerAccess.resolve({ kind: 'unknown', reason: 'newer_limit', retryAfterMs: 700 });
    await eventually(async () => (await f.read(b))?.observation?.outcome === 'unknown');
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_700,
    );
    // A different persisted source replaces the stronger limit in the one-entry cache.
    // Its acknowledgement must remain effective independently of that cache entry.
    evictingAccess.resolve({ kind: 'unknown', reason: 'other_limit', retryAfterMs: 900 });
    await eventually(async () => (await f.read(evicting))?.observation?.outcome === 'unknown');
    releaseOlderWrite.resolve();
    await eventually(() => olderWrites === 2 && f.errors.length === 1);

    const healthy = await f.wait('healthy', {
      resource: {
        providerId: 'fake',
        connectionId: 'healthy',
        resourceType: 'task',
        resourceId: 'healthy',
      },
    });
    await manager.reconcile();
    await eventually(async () => (await f.read(healthy))?.status === 'resolved');
    assert.deepEqual(
      source.calls.map(({ wait }) => wait.waitId),
      [healthy.waitId],
    );
    assert.equal(
      olderWrites,
      2,
      'an acknowledged stronger fact makes retries of the older fact unnecessary',
    );
    assert.equal(f.errors.length, 1, 'the failed write is still reported');
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_700,
    );
  } finally {
    olderAccess.resolve({ kind: 'allowed', context: {} });
    newerAccess.resolve({ kind: 'allowed', context: {} });
    evictingAccess.resolve({ kind: 'allowed', context: {} });
    releaseOlderWrite.resolve();
    await settle();
  }
});

test('a shorter successful cooldown write cannot discard a longer failed fact', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const releaseLongerWrite = deferred<void>();
  const longerAccess = deferred<EventWaitObservationAccess>();
  const shorterAccess = deferred<EventWaitObservationAccess>();
  const accessStarted = new Set<string>();
  let longerWrites = 0;
  let failLongerWrite = true;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async extendSourceCooldown(cooldown) {
            if (cooldown.connectionId === null && cooldown.until === 1_700) {
              longerWrites++;
              await releaseLongerWrite.promise;
              if (failLongerWrite) throw new Error('longer cooldown write failed');
            }
            return stores.eventWaitStore.extendSourceCooldown(cooldown);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a', { deadlineAt: 3_000 });
  const b = await f.wait('b', { deadlineAt: 3_000 });
  const source = new Source();
  source.behavior = async () => satisfied();
  const manager = f.manager(source, {
    policy: { ...policy, maxPerSource: 2, maxSourceCooldowns: 1 },
    authorize: async (wait) => {
      accessStarted.add(wait.waitId);
      if (wait.waitId === a.waitId) return longerAccess.promise;
      if (wait.waitId === b.waitId) return shorterAccess.promise;
      return { kind: 'allowed', context: {} };
    },
  });
  try {
    await manager.start();
    await eventually(() => accessStarted.size === 2);
    longerAccess.resolve({ kind: 'unknown', reason: 'longer_limit', retryAfterMs: 700 });
    await eventually(() => longerWrites === 1);
    shorterAccess.resolve({ kind: 'unknown', reason: 'shorter_limit', retryAfterMs: 500 });
    await eventually(async () => (await f.read(b))?.observation?.outcome === 'unknown');
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_500,
    );
    releaseLongerWrite.resolve();
    await eventually(() => longerWrites === 2 && f.errors.length === 1);

    const healthy = await f.wait('healthy', {
      resource: {
        providerId: 'fake',
        connectionId: 'healthy',
        resourceType: 'task',
        resourceId: 'healthy',
      },
    });
    await manager.reconcile();
    assert.equal(
      source.calls.length,
      0,
      'the genuinely unpersisted longer fact still saturates the buffer',
    );
    assert.equal((await f.read(healthy))?.observation, undefined);
    assert.equal(
      longerWrites,
      4,
      'the longer failed fact remains eligible for persistence retries',
    );

    failLongerWrite = false;
    await manager.reconcile();
    await eventually(async () => (await f.read(healthy))?.status === 'resolved');
    assert.deepEqual(
      source.calls.map(({ wait }) => wait.waitId),
      [healthy.waitId],
    );
    assert.equal(
      await f.stores.eventWaitStore.readSourceCooldown({ providerId: 'fake', connectionId: null }),
      1_700,
      'recovery must persist the original longer absolute deadline',
    );
  } finally {
    longerAccess.resolve({ kind: 'allowed', context: {} });
    shorterAccess.resolve({ kind: 'allowed', context: {} });
    releaseLongerWrite.resolve();
    await settle();
  }
});

for (const failure of ['active read', 'expiry commit'] as const) {
  for (const connection of [null, 'independent'] as const) {
    test(`a failed ${failure} preserves other maintenance and observation (connection=${connection})`, async (t) => {
      const base = createMemoryExecutionPersistenceProvider();
      let failMaintenance = false;
      let recoverSource = false;
      let failures = 0;
      const provider: ExecutionPersistenceProvider = {
        async open(input) {
          const stores = await base.open(input);
          return {
            ...stores,
            eventWaitStore: {
              ...stores.eventWaitStore,
              async read(input) {
                if (failMaintenance && failure === 'active read' && input.waitId === 'a') {
                  failures++;
                  throw new Error('record maintenance read failed');
                }
                return stores.eventWaitStore.read(input);
              },
              async commit(input) {
                if (
                  failMaintenance &&
                  failure === 'expiry commit' &&
                  input.waitId === 'a' &&
                  input.record.status === 'expired'
                ) {
                  failures++;
                  throw new Error('record expiry commit failed');
                }
                return stores.eventWaitStore.commit(input);
              },
            },
          };
        },
      };
      const f = await fixture(t, 'Memory', provider);
      const a = await f.wait('a', {
        deadlineAt: failure === 'expiry commit' ? 1_010 : 2_000,
      });
      const source = new Source();
      source.behavior = async ({ wait, signal }) => {
        if (wait.waitId !== a.waitId || recoverSource) return satisfied();
        if (failure === 'expiry commit') return { kind: 'pending' };
        return new Promise((resolve) => {
          // Even an apparently successful result after interruption cannot replace
          // the last durable state when the maintenance read could not confirm it.
          signal.addEventListener('abort', () => resolve(satisfied('interrupted')), {
            once: true,
          });
        });
      };
      const manager = f.manager(source, { policy: { ...policy, pageSize: 1 } });
      await manager.start();
      await eventually(() => source.calls.length === 1);
      if (failure === 'expiry commit')
        await eventually(async () => (await f.read(a))?.observation?.outcome === 'pending');
      const before = (
        await f.stores.eventWaitStore.listSession({ sessionId: a.sessionId, limit: 1 })
      ).items[0];
      const b = await f.wait('b', {
        deadlineAt: 1_300,
        resource: {
          providerId: 'fake',
          connectionId: connection,
          resourceType: 'task',
          resourceId: 'b',
        },
      });
      const c = await f.wait('c', {
        deadlineAt: 1_010,
        resource: { ...b.resource, resourceId: 'c' },
      });
      failMaintenance = true;
      if (failure === 'expiry commit') {
        f.clock.time = 1_020;
        await manager.reconcile();
        assert.equal(source.callbacks.has(a.waitId), false);
      } else {
        await manager.reconcile();
        await eventually(() => source.calls[0].signal.aborted);
        assert.equal(source.callbacks.has(a.waitId), false);
      }
      // A's durable observation reservation is not due yet in the active-read
      // case. Subsequent scans may retry it from a fresh authoritative snapshot.
      await f.clock.advance(60);
      assert.equal((await f.read(b))?.status, 'resolved');
      assert.equal((await f.read(c))?.status, 'expired');
      assert.deepEqual(
        (await f.stores.eventWaitStore.listSession({ sessionId: a.sessionId, limit: 1 })).items[0],
        before,
        'a maintenance failure cannot fabricate cancellation or accept an interrupted result',
      );
      assert.ok(failures > 0);
      assert.equal(f.errors.length, failures, 'every isolated maintenance failure is reported');
      assert.equal(source.calls.filter(({ wait }) => wait.waitId === b.waitId).length, 1);
      if (failure === 'expiry commit') {
        assert.ok(failures > 1, 'expiry must revisit the failed record across page boundaries');
        assert.equal(source.calls.filter(({ wait }) => wait.waitId === a.waitId).length, 1);
      }

      failMaintenance = false;
      recoverSource = true;
      await f.clock.advance(60);
      await eventually(async () => {
        const status = (await f.read(a))?.status;
        return status === (failure === 'expiry commit' ? 'expired' : 'resolved');
      });
      assert.equal(
        source.calls.filter(({ wait }) => wait.waitId === a.waitId).length,
        failure === 'expiry commit' ? 1 : 2,
      );
    });
  }
}

for (const backend of ['Local', 'Memory'] as const) {
  for (const maintenance of ['active read', 'expiry commit'] as const) {
    test(`${backend}: invalid lease during ${maintenance} still closes the whole manager`, async (t) => {
      const f = await fixture(t, backend);
      const a = await f.wait('a', {
        deadlineAt: maintenance === 'expiry commit' ? 1_010 : 2_000,
      });
      const source = new Source();
      source.behavior = async ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(satisfied('interrupted')), {
            once: true,
          });
        });
      const manager = f.manager(source, { policy: { ...policy, pageSize: 1 } });
      if (maintenance === 'active read') {
        await manager.start();
        await eventually(() => source.calls.length === 1);
      }
      const b = await f.wait('b', {
        resource: {
          providerId: 'fake',
          connectionId: 'independent',
          resourceType: 'task',
          resourceId: 'b',
        },
      });
      const originalNow = f.clock.now;
      let closing: Promise<void> | undefined;
      try {
        if (maintenance === 'expiry commit') {
          f.clock.time = 1_020;
          // With no active work or pending cooldowns, the first clock check is
          // after listByStatus returns and immediately before the expiry commit.
          f.clock.now = () => {
            closing ??= f.stores.eventWaitStore.close();
            return f.clock.time;
          };
          await manager.start().catch(() => undefined);
        } else {
          await f.stores.eventWaitStore.close();
          await manager.reconcile().catch(() => undefined);
        }
        await closing;
        await eventually(() =>
          f.errors.some(
            (error) => error instanceof Error && 'code' in error && error.code === 'invalid_lease',
          ),
        );
        await manager.close();
        await assert.rejects(manager.start(), /closed/);
        assert.equal(source.callbacks.size, 0);
        assert.equal(f.clock.timers.size, 0);
        assert.equal(
          source.calls.some(({ wait }) => wait.waitId === b.waitId),
          false,
        );
        if (maintenance === 'active read') assert.equal(source.calls[0].signal.aborted, true);
      } finally {
        f.clock.now = originalNow;
      }
      await f.reopen();
      assert.equal((await f.read(a))?.status, 'waiting');
      assert.equal((await f.read(b))?.observation, undefined);
    });
  }
}

for (const count of [1, 7]) {
  for (const sameSource of [false, true]) {
    test(`claim failures preserve turns for a healthy ${sameSource ? 'same' : 'different'} source peer (${count} failed waits)`, async (t) => {
      const base = createMemoryExecutionPersistenceProvider();
      const failures = new Map<string, number>();
      const provider: ExecutionPersistenceProvider = {
        async open(input) {
          const stores = await base.open(input);
          return {
            ...stores,
            eventWaitStore: {
              ...stores.eventWaitStore,
              async commit(input) {
                if (
                  input.waitId.startsWith('a-') &&
                  input.record.observation?.outcome === 'checking'
                ) {
                  failures.set(input.waitId, (failures.get(input.waitId) ?? 0) + 1);
                  throw new Error('wait-specific claim unavailable');
                }
                return stores.eventWaitStore.commit(input);
              },
            },
          };
        },
      };
      const f = await fixture(t, 'Memory', provider);
      const failed: EventWaitRecord[] = [];
      for (let n = 0; n < count; n++) {
        const waitId = `a-${n}`;
        failed.push(await f.wait(waitId, { deadlineAt: 3_000 }));
      }
      const healthy = await f.wait('z-healthy', {
        deadlineAt: 1_400,
        resource: {
          providerId: 'fake',
          connectionId: sameSource ? null : 'healthy',
          resourceType: 'task',
          resourceId: 'z-healthy',
        },
      });
      const source = new Source();
      source.behavior = async () => satisfied();
      await f
        .manager(source, {
          policy: {
            ...policy,
            pageSize: 2,
            maxConcurrent: 1,
            maxPerSource: 1,
            maxSourceCooldowns: 1,
          },
        })
        .start();
      await eventually(() => failures.size > 0);
      await f.clock.advance(250);
      await eventually(async () => (await f.read(healthy))?.status === 'resolved');
      assert.equal((await f.read(healthy))?.status, 'resolved');
      assert.equal((await f.read(healthy))?.observation?.attempts, 1);
      assert.deepEqual(
        source.calls.map(({ wait }) => wait.waitId),
        [healthy.waitId],
      );
      assert.equal(failures.size, count, 'recovery must progress beyond page and hint capacities');
      for (const wait of failed) {
        assert.equal(
          (await f.read(wait))?.observation,
          undefined,
          'a failed claim consumes no durable attempt',
        );
      }
      assert.ok(f.errors.length > 0, 'storage faults remain visible to diagnostics');
    });
  }
}

test('source cooldown lookup failures cannot hide a healthy tail beyond recovery hint capacity', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const failures = new Set<string>();
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async readSourceCooldown(input) {
            if (input.connectionId?.startsWith('failed-')) {
              failures.add(input.connectionId);
              throw new Error('source-specific cooldown lookup unavailable');
            }
            return stores.eventWaitStore.readSourceCooldown(input);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const failed: EventWaitRecord[] = [];
  for (let n = 0; n < 7; n++) {
    const waitId = `a-${n}`;
    failed.push(
      await f.wait(waitId, {
        deadlineAt: 3_000,
        resource: {
          providerId: 'fake',
          connectionId: `failed-${n}`,
          resourceType: 'task',
          resourceId: waitId,
        },
      }),
    );
  }
  const healthy = await f.wait('z-healthy', { deadlineAt: 1_400 });
  const source = new Source();
  source.behavior = async () => satisfied();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 2, maxConcurrent: 1, maxPerSource: 1, maxSourceCooldowns: 1 },
    })
    .start();
  await eventually(() => failures.size > 0);
  await f.clock.advance(250);
  assert.equal((await f.read(healthy))?.status, 'resolved');
  assert.equal(failures.size, failed.length);
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    [healthy.waitId],
  );
  for (const wait of failed) assert.equal((await f.read(wait))?.observation, undefined);
  assert.ok(f.errors.length > 0);
});

test('an all-failing recovery sweep wraps and retries after claim storage recovers', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  const failures = new Map<string, number>();
  let failing = true;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async commit(input) {
            if (failing && input.record.observation?.outcome === 'checking') {
              failures.set(input.waitId, (failures.get(input.waitId) ?? 0) + 1);
              throw new Error('claim storage temporarily unavailable');
            }
            return stores.eventWaitStore.commit(input);
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const waits = [await f.wait('a'), await f.wait('b'), await f.wait('c')];
  const source = new Source();
  source.behavior = async () => satisfied();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 1, maxConcurrent: 1, maxPerSource: 1, maxSourceCooldowns: 1 },
    })
    .start();
  await eventually(() => failures.size > 0);
  await f.clock.advance(150);
  for (const wait of waits) {
    assert.ok(
      (failures.get(wait.waitId) ?? 0) >= 2,
      'failed waits must receive another turn after wrap',
    );
    assert.equal((await f.read(wait))?.observation, undefined);
  }
  assert.equal(source.calls.length, 0);
  failing = false;
  await f.clock.advance(150);
  for (const wait of waits) {
    assert.equal((await f.read(wait))?.status, 'resolved');
    assert.equal((await f.read(wait))?.observation?.attempts, 1);
    assert.equal(
      source.calls.filter(({ wait: called }) => called.waitId === wait.waitId).length,
      1,
    );
  }
});

test('a lost claim acknowledgement preserves its attempt while healthy recovery peers progress', async (t) => {
  const base = createMemoryExecutionPersistenceProvider();
  let lost = false;
  const provider: ExecutionPersistenceProvider = {
    async open(input) {
      const stores = await base.open(input);
      return {
        ...stores,
        eventWaitStore: {
          ...stores.eventWaitStore,
          async commit(input) {
            const result = await stores.eventWaitStore.commit(input);
            if (!lost && input.waitId === 'a' && input.record.observation?.outcome === 'checking') {
              lost = true;
              throw new Error('claim acknowledgement lost');
            }
            return result;
          },
        },
      };
    },
  };
  const f = await fixture(t, 'Memory', provider);
  const a = await f.wait('a');
  const b = await f.wait('b');
  const source = new Source();
  source.behavior = async () => satisfied();
  await f
    .manager(source, {
      policy: { ...policy, maxConcurrent: 1, maxPerSource: 1, maxAttempts: 1 },
    })
    .start();
  await eventually(() => lost);
  assert.equal((await f.read(a))?.observation?.attempts, 1);
  await f.clock.advance(200);
  const retired = await f.read(a);
  assert.equal(retired?.status, 'resolved');
  if (retired?.status === 'resolved')
    assert.equal(retired.resolution.outcome, 'source_unavailable');
  assert.equal(retired?.observation?.attempts, 1);
  assert.equal((await f.read(b))?.status, 'resolved');
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    [b.waitId],
  );
  assert.equal(f.errors.length, 1);
});

test('without storage failures durable observation age remains ahead of lexical ID order', async (t) => {
  const f = await fixture(t);
  const a = await f.wait('a-recent', {
    observation: {
      schemaVersion: 1,
      attempts: 1,
      lastAttemptAt: 1_000,
      lastObservedAt: 1_000,
      nextObserveAt: 1_000,
      nextPollAt: 1_000,
      consecutiveErrors: 0,
      outcome: 'pending',
      cursor: null,
      eventKey: null,
      reason: null,
    },
  });
  const z = await f.wait('z-unobserved');
  const source = new Source();
  source.behavior = async () => satisfied();
  await f
    .manager(source, {
      policy: { ...policy, pageSize: 1, maxConcurrent: 1, maxPerSource: 1 },
    })
    .start();
  await eventually(async () => (await f.read(z))?.status === 'resolved');
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    [z.waitId],
  );
  await f.clock.advance(30);
  await eventually(async () => (await f.read(a))?.status === 'resolved');
  assert.equal((await f.read(a))?.status, 'resolved');
  assert.deepEqual(
    source.calls.map(({ wait }) => wait.waitId),
    [z.waitId, a.waitId],
  );
  assert.deepEqual(f.errors, []);
});

for (const stage of ['claim', 'budget', 'unsupported'] as const) {
  for (const failure of ['throw', 'reject'] as const) {
    test(`${stage} preparation ${failure} does not pin a ready peer and recovers without false progress`, async (t) => {
      const base = createMemoryExecutionPersistenceProvider();
      let fail = true;
      let failures = 0;
      const provider: ExecutionPersistenceProvider = {
        async open(input) {
          const stores = await base.open(input);
          return {
            ...stores,
            eventWaitStore: {
              ...stores.eventWaitStore,
              async commit(input) {
                const targeted =
                  stage === 'claim'
                    ? input.record.observation?.outcome === 'checking'
                    : input.record.status === 'resolved';
                if (fail && input.waitId === 'a' && targeted) {
                  failures++;
                  if (failure === 'throw') throw new Error(`${stage} preparation unavailable`);
                  return { kind: 'session_unavailable' as const };
                }
                return stores.eventWaitStore.commit(input);
              },
            },
          };
        },
      };
      const f = await fixture(t, 'Memory', provider);
      const observation = (attempts: number) => ({
        schemaVersion: 1 as const,
        attempts,
        lastAttemptAt: 1_000,
        lastObservedAt: 1_000,
        nextObserveAt: 1_000,
        nextPollAt: 1_000,
        consecutiveErrors: 0,
        outcome: 'pending' as const,
        cursor: null,
        eventKey: null,
        reason: null,
      });
      const a = await f.wait('a', {
        deadlineAt: 3_000,
        ...(stage === 'budget' ? { observation: observation(2) } : {}),
        ...(stage === 'unsupported'
          ? { condition: { typeId: 'terminal', version: 1, parameters: { invalid: true } } }
          : {}),
      });
      const b = await f.wait('b', {
        deadlineAt: 1_400,
        // Both ready rows must have the same durable age, making a the first
        // candidate even when a already exhausted its two-attempt budget.
        ...(stage === 'budget' ? { observation: observation(1) } : {}),
      });
      const before = await f.read(a);
      const source = new Source();
      source.behavior = async () => satisfied();
      await f
        .manager(source, {
          policy: { ...policy, pageSize: 1, maxConcurrent: 1, maxPerSource: 1, maxAttempts: 2 },
        })
        .start();
      await eventually(() => failures > 0);
      await f.clock.advance(100);
      assert.equal((await f.read(b))?.status, 'resolved');
      assert.deepEqual(
        await f.read(a),
        before,
        'failed preparation must not fabricate a claim or terminal result',
      );
      assert.deepEqual(
        source.calls.map(({ wait }) => wait.waitId),
        [b.waitId],
      );
      assert.equal(f.errors.length, failure === 'throw' ? failures : 0);

      fail = false;
      await f.clock.advance(100);
      const recovered = await f.read(a);
      assert.equal(recovered?.status, 'resolved');
      if (recovered?.status === 'resolved') {
        assert.equal(
          recovered.resolution.outcome,
          stage === 'claim' ? 'satisfied' : 'source_unavailable',
        );
      }
      assert.equal(
        recovered?.observation?.attempts,
        stage === 'budget' ? 2 : stage === 'claim' ? 1 : undefined,
      );
      assert.equal(
        source.calls.filter(({ wait }) => wait.waitId === a.waitId).length,
        stage === 'claim' ? 1 : 0,
      );
    });
  }
}
