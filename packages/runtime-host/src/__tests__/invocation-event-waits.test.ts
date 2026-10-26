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
import { test, type TestContext } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import {
  decodeAnyEventWaitRecord,
  assertAnyEventWaitTransition,
  EVENT_WAIT_LIMITS,
  type AnyEventWaitRecord,
  type ConsumerEventWaitRecord,
} from '@maka/core/event-wait';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { EventWaitToolResult } from '@maka/runtime/event-wait-tool';
import {
  openInteractiveExecutionStoresForWrite,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
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
} from '../server/event-wait-adapter.js';
import { HostEventWaitObserver, type EventWaitClock } from '../server/event-wait-manager.js';
import type { EventWaitObservationStore } from '../server/event-wait-observation-store.js';
import { interactiveEventWaitObservationStore } from '../server/event-wait-observation-store.js';
import { HostInvocationEventWaitCoordinator } from '../server/invocation-event-waits.js';
import { HostGoalCoordinator } from '../server/goal-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

async function eventually(check: () => Promise<boolean> | boolean) {
  const deadline = performance.now() + 5_000;
  while (!(await check())) {
    if (performance.now() > deadline) assert.fail('Authoritative condition did not arrive');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
async function waitForDelivery(
  coordinator: HostInvocationEventWaitCoordinator,
  stores: ExecutionStoresWriter<'interactive'>,
  sessionId: string,
  waitId: string,
  kind: 'consumed' | 'retired' = 'consumed',
) {
  // A scan already in flight may have read before T2. Its return is not an ACK barrier.
  await eventually(async () => {
    await coordinator.reconcile();
    return (
      (await stores.eventWaitStore.readAny({ sessionId, waitId }))?.record.delivery?.kind === kind
    );
  });
}
async function fixture(
  t: TestContext,
  backend: 'Memory' | 'SQLite' = 'Memory',
  suppliedClock?: EventWaitClock,
  beforeRegister?: (record: ConsumerEventWaitRecord) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-invocation-wait-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(
    owner.lease,
    backend === 'Memory' ? createMemoryExecutionPersistenceProvider() : undefined,
  );
  const session = await stores.sessionStore.create({
    cwd: root,
    llmConnectionSlug: 'test',
    model: 'test',
    permissionMode: 'ask',
  });
  const now = () => suppliedClock?.now() ?? Date.now();
  const identity = {
    sessionId: session.id,
    turnId: 'turn',
    runId: 'run',
    invocationId: 'invocation',
  };
  await stores.agentRunStore.admitRootTurn({
    sessionId: session.id,
    turnId: 'turn',
    proposedRunId: 'run',
    proposedUserMessageId: 'message',
    execution: { kind: 'external_message' },
    previousRootTurnId: null,
    normalizedInput: { text: 'work' },
    sourceMessages: [],
    admittedAt: now(),
  });
  await stores.runtimeEventStore.appendRuntimeEvent(
    session.id,
    'run',
    buildInvocationOpenedEvent({
      run: identity,
      id: 'opening',
      openedAt: now(),
      opening: {
        kind: 'invocation_opened',
        protocol: 'invocation_opened_v1',
        route: {
          provenance: 'runtime',
          backendKind: 'ai-sdk',
          llmConnectionId: 'test',
          llmConnectionSlug: 'test',
          modelId: 'test',
        },
        configuration: {
          cwd: root,
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          toolMode: 'direct',
        },
        root: { kind: 'user' },
        source: { kind: 'fresh' },
      },
    }),
  );
  const errors: unknown[] = [];
  const complete = new Set<string>();
  const changed = new Map<string, () => void>();
  const reads = new Map<string, number>();
  const source: EventWaitSourceAdapter = {
    providerId: 'test',
    resourceType: 'job',
    conditionType: 'terminal',
    conditionVersion: 1,
    reconciliation: 'snapshot',
    validate() {},
    async subscribe({ wait }, notify) {
      changed.set(wait.resource.resourceId, notify);
      return {
        close() {
          changed.delete(wait.resource.resourceId);
        },
      };
    },
    async read({ wait }) {
      const id = wait.resource.resourceId;
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return complete.has(id)
        ? { kind: 'satisfied', receiptKey: `done-${id}`, evidenceRefs: [`ref-${id}`] }
        : { kind: 'pending' };
    },
  };
  const sources = {
    adapters: new EventWaitAdapterRegistry([source]),
    authorize: async () => ({ kind: 'allowed' as const, context: {} }),
  };
  const invalidations: string[] = [];
  let coordinator!: HostInvocationEventWaitCoordinator;
  const observationStore = interactiveEventWaitObservationStore(stores.eventWaitStore);
  const observer = new HostEventWaitObserver({
    store: observationStore,
    decodeRecord: decodeAnyEventWaitRecord,
    adapters: sources.adapters,
    authorize: (wait, signal) => coordinator.authorizeObservation(wait, signal),
    onChanged: (wait) => coordinator.changed(wait),
    onError: (error) => errors.push(error),
    ...(suppliedClock ? { clock: suppliedClock } : {}),
    policy: {
      minIntervalMs: 1,
      pollIntervalMs: 5,
      scanIntervalMs: 1,
      jitterRatio: 0,
      maxAttempts: 1,
      maxLifetimeMs: 10,
    },
  });
  coordinator = new HostInvocationEventWaitCoordinator({
    stores: beforeRegister
      ? {
          ...stores,
          eventWaitStore: {
            ...stores.eventWaitStore,
            registerInvocationWait: async (input) => {
              await beforeRegister(input.record);
              return stores.eventWaitStore.registerInvocationWait(input);
            },
          },
        }
      : stores,
    sources,
    observer,
    onChanged: (sessionId) => invalidations.push(sessionId),
    onError: (error) => errors.push(error),
    ...(suppliedClock ? { clock: suppliedClock } : {}),
  });
  await coordinator.start();
  await observer.start();
  t.after(async () => {
    await coordinator.close();
    await observer.close();
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(root, { recursive: true, force: true });
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true });
  });
  const prepare = async (
    id: string,
    timeoutMs?: number,
    resourceId = id,
    resumeWaitId?: string,
  ) => {
    const request = {
      resource: { providerId: 'test', connectionId: null, resourceType: 'job', resourceId },
      condition: { typeId: 'terminal', version: 1, parameters: {} },
      reason: 'await test',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(resumeWaitId ? { resumeWaitId } : {}),
    };
    const operationId = `operation_${id}`,
      toolCallId = `call_${id}`;
    const base = { ...identity, partial: false, ts: now() };
    const hash = canonicalToolArgsHash('WaitForEvent', request);
    const call: RuntimeEvent = {
      ...base,
      id: `${id}_call`,
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: toolCallId, name: 'WaitForEvent', args: request },
    };
    const dispatch: RuntimeEvent = {
      ...base,
      id: `${id}_dispatch`,
      role: 'system',
      author: 'system',
      refs: { operationId, toolCallId },
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId,
          providerToolCallId: toolCallId,
          toolName: 'WaitForEvent',
          canonicalArgsHash: hash,
          recoveryMode: 'never_auto_retry',
        },
      },
    };
    await stores.runtimeEventStore.commitToolPrepared({
      operationId,
      journalEventId: `${operationId}_prepared`,
      runtimeEvent: call,
      dispatchRuntimeEvent: dispatch,
      providerToolCallId: toolCallId,
      toolName: 'WaitForEvent',
      canonicalArgsHash: hash,
      recoveryMode: 'never_auto_retry',
      committedAt: now(),
    });
    const abort = new AbortController();
    const context: MakaToolContext = {
      ...identity,
      cwd: root,
      toolCallId,
      operationId,
      abortSignal: abort.signal,
      emitOutput() {},
    };
    return { request, context, abort };
  };
  const ack = async (context: MakaToolContext, result: EventWaitToolResult, isError = false) => {
    const resultEventId = `${context.operationId}_result`;
    await stores.runtimeEventStore.commitToolOutcome({
      operationId: context.operationId!,
      journalEventId: `${context.operationId}_outcome`,
      committedAt: now(),
      runtimeEvent: {
        ...identity,
        id: resultEventId,
        partial: false,
        ts: now(),
        role: 'tool',
        author: 'tool',
        refs: { operationId: context.operationId!, toolCallId: context.toolCallId },
        content: {
          kind: 'function_response',
          id: context.toolCallId,
          name: 'WaitForEvent',
          isError,
          result: isError ? { kind: 'text', text: 'tool failed' } : { kind: 'json', value: result },
        },
      },
    });
    return resultEventId;
  };
  return {
    stores,
    identity,
    prepare,
    ack,
    errors,
    reads,
    coordinator,
    observer,
    observationStore,
    invalidations,
    complete,
    waitForDelivery: (waitId: string, kind: 'consumed' | 'retired' = 'consumed') =>
      waitForDelivery(coordinator, stores, identity.sessionId, waitId, kind),
    resolve(id: string) {
      complete.add(id);
      changed.get(id)?.();
    },
    waits: () => stores.eventWaitStore.listAny({ limit: 20, consumerKind: 'tool_invocation' }),
  };
}

for (const backend of ['Memory', 'SQLite'] as const) {
  test(`${backend}: consumption synchronization waits for a scan that can see T2`, async (t) => {
    const f = await fixture(t, backend);
    const original = await f.prepare('old-scan');
    f.resolve('old-scan');
    const result = (await f.coordinator
      .createTool(f.identity.sessionId, () => true)
      .tool.impl(original.request, original.context)) as EventWaitToolResult;
    await f.coordinator.close();
    await f.observer.close();
    const readBeforeT2 = deferred<void>();
    const releaseRead = deferred<void>();
    let held = false;
    const runtimeEvents = f.stores.runtimeEventStore;
    const scanner = new HostInvocationEventWaitCoordinator({
      stores: {
        ...f.stores,
        runtimeEventStore: {
          ...runtimeEvents,
          readToolProvenanceEvents: async (...args) => {
            const proof = await runtimeEvents.readToolProvenanceEvents(...args);
            assert.equal(proof.status, 'complete');
            if (!held) {
              held = true;
              assert.ok(
                !proof.records.some((event) => event.content?.kind === 'function_response'),
              );
              readBeforeT2.resolve();
              await releaseRead.promise;
            }
            return proof;
          },
        },
      },
      observer: f.observer,
      sources: {
        adapters: new EventWaitAdapterRegistry([]),
        authorize: async () => ({ kind: 'allowed', context: null }),
      },
      onError: (error) => f.errors.push(error),
      clock: { now: Date.now, schedule: () => () => {} },
    });
    const earlierScan = scanner.start();
    void earlierScan.catch(() => undefined);
    try {
      await readBeforeT2.promise;
      const resultEventId = await f.ack(original.context, result);
      const synchronized = waitForDelivery(scanner, f.stores, f.identity.sessionId, result.waitId);
      void synchronized.catch(() => undefined);
      releaseRead.resolve();
      await earlierScan;
      await synchronized;
      const proof = await runtimeEvents.readToolProvenanceEvents(
        f.identity.sessionId,
        f.identity.runId,
        original.context.toolCallId,
        { maxRecords: 64, maxBytes: 1_048_576 },
      );
      assert.equal(proof.status, 'complete');
      assert.deepEqual(
        proof.records
          .filter((event) => event.content?.kind === 'function_response')
          .map((event) => event.id),
        [resultEventId],
      );
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.identity.sessionId))
          .length,
        1,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      releaseRead.resolve();
      await earlierScan;
      await scanner.close();
    }
  });
}

for (const backend of ['Memory', 'SQLite'] as const) {
  test(`${backend}: parallel invocation waits retain their original Run and consume only durable T2`, {
    timeout: 15_000,
  }, async (t) => {
    const f = await fixture(t, backend);
    let goal = true;
    const capability = f.coordinator.createTool(f.identity.sessionId, () => goal);
    const a = await f.prepare('a'),
      b = await f.prepare('b');
    const pa = capability.tool.impl(a.request, a.context) as Promise<EventWaitToolResult>;
    const pb = capability.tool.impl(b.request, b.context) as Promise<EventWaitToolResult>;
    await eventually(
      async () =>
        (await f.waits()).items.length === 2 &&
        (f.reads.get('a') ?? 0) > 2 &&
        (f.reads.get('b') ?? 0) > 2,
    );
    assert.equal(
      (await f.stores.runtimeEventStore.readRunInvocation(f.identity.sessionId, 'run'))
        ?.terminalEvent,
      undefined,
    );
    assert.equal(
      (await f.stores.eventWaitStore.listByStatus({ status: 'waiting', limit: 20 })).items.length,
      0,
    );
    f.resolve('a');
    const ra = await pa;
    assert.equal(ra.outcome, 'satisfied');
    assert.equal(
      (await f.waits()).items.find((v) => v.record.waitId === ra.waitId)?.record.delivery,
      undefined,
    );
    const resultEventId = await f.ack(a.context, ra);
    // No post-T2 callback: the durable scan must compensate independently.
    await f.waitForDelivery(ra.waitId);
    assert.equal(
      (await f.waits()).items.find((v) => v.record.waitId === ra.waitId)?.record.delivery?.kind,
      'consumed',
    );
    goal = false;
    const c = await f.prepare('c');
    f.resolve('c');
    const rc = (await capability.tool.impl(c.request, c.context)) as EventWaitToolResult;
    assert.equal(rc.outcome, 'satisfied');
    f.resolve('b');
    assert.equal((await pb).outcome, 'satisfied');
    await f.coordinator.acknowledge({
      ...f.identity,
      operationId: a.context.operationId!,
      toolCallId: a.context.toolCallId,
      resultEventId,
      result: ra,
      isError: false,
    });
    assert.equal(
      (await f.stores.runtimeEventStore.readRunInvocation(f.identity.sessionId, 'run'))
        ?.terminalEvent,
      undefined,
    );
    assert.deepEqual(f.errors, []);
  });
}

test('current-Turn input returns a durable interrupted result without consuming the input', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const a = await f.prepare('steering', 60_000);
  const steering = deferred<void>();
  a.context.waitForSteering = () => steering.promise;
  const capability = f.coordinator.createTool(f.identity.sessionId, () => true);
  const result = capability.tool.impl(a.request, a.context) as Promise<EventWaitToolResult>;
  await eventually(async () => (await f.waits()).items.length === 1);
  steering.resolve(undefined);
  const interrupted = await result;
  assert.equal(interrupted.outcome, 'interrupted');
  assert.equal(interrupted.reason, 'user_input');
  await f.ack(a.context, interrupted);
  await f.waitForDelivery(interrupted.waitId);
  assert.equal((await f.waits()).items[0]?.record.delivery?.kind, 'consumed');
  assert.equal(
    (await f.stores.runtimeEventStore.readRunInvocation(f.identity.sessionId, 'run'))
      ?.terminalEvent,
    undefined,
  );
  assert.deepEqual(f.errors, []);
});

test('ordinary Sessions cannot acquire a new wait capability without Goal activation', async (t) => {
  const f = await fixture(t);
  const a = await f.prepare('no-goal');
  const capability = f.coordinator.createTool(f.identity.sessionId, () => false);
  assert.equal(capability.available(), false);
  await assert.rejects(async () => capability.tool.impl(a.request, a.context), /unavailable/);
  assert.equal((await f.waits()).items.length, 0);
});

// Pending reads can fill the window, with two recent failures for the unknown
// cases. The store port checks every subsequent transition across rollover.
for (const initialOutcome of ['pending', 'unknown'] as const) {
  for (const nextOutcome of ['pending', 'unknown', 'satisfied'] as const) {
    test(`v2 rolling observation preserves ${initialOutcome} while reading ${nextOutcome}`, async (t) => {
      let now = 8 * 24 * 60 * 60_000;
      const timers = new Set<() => void>();
      const clock: EventWaitClock = {
        now: () => now,
        schedule(callback) {
          timers.add(callback);
          return () => {
            timers.delete(callback);
          };
        },
      };
      const f = await fixture(t, 'Memory', clock);
      let row: { authorityRevision: number; record: ConsumerEventWaitRecord } = {
        authorityRevision: EVENT_WAIT_LIMITS.observationAttempts * 2,
        record: {
          schemaVersion: 2,
          waitId: 'long-wait',
          sessionId: f.identity.sessionId,
          sourceTurnId: 'turn',
          consumer: {
            kind: 'tool_invocation',
            runId: 'run',
            invocationId: 'invocation',
            operationId: 'operation',
            toolCallId: 'call',
          },
          resource: {
            providerId: 'test',
            connectionId: null,
            resourceType: 'job',
            resourceId: 'long',
          },
          condition: { typeId: 'terminal', version: 1, parameters: {} },
          deliveryKey: 'event-wait/long-wait',
          createdAt: 1,
          updatedAt: now - 9,
          deadlineAt: null,
          status: 'waiting',
          observation: {
            schemaVersion: 2,
            window: 0,
            // A legal checkpoint just before the boundary; the real observer below
            // completes the final attempt, rolls, then completes the new window.
            attempts: EVENT_WAIT_LIMITS.observationAttempts - 1,
            lastAttemptAt: now - 10,
            lastObservedAt: now - 9,
            nextObserveAt: now - 9 + (initialOutcome === 'unknown' ? 4 : 1),
            nextPollAt: now - 9 + (initialOutcome === 'unknown' ? 4 : 2),
            consecutiveErrors: initialOutcome === 'unknown' ? 2 : 0,
            outcome: initialOutcome,
            cursor: 'old-cursor',
            eventKey: 'old-key',
            reason: initialOutcome === 'unknown' ? 'observation_failed' : null,
          },
        },
      };
      const goal = new HostGoalCoordinator({
        store: f.stores.goalStore,
        stores: {
          ...f.stores,
          eventWaitStore: {
            ...f.stores.eventWaitStore,
            listAny: async () => ({ items: [structuredClone(row)], nextCursor: null }),
          },
        },
        readSessionContext: async () => ({ messages: [] }),
        sessionAdmission: new SessionAdmissionGate(),
        evaluator: {
          evaluate: async () => assert.fail('query must not evaluate'),
          close: async () => {},
        },
        executions: {
          reconcile: async () => assert.fail('query must not reconcile execution'),
          subscribe: () => () => {},
        },
        admitTurn: () => assert.fail('observation must not admit a Turn'),
        acquireResidency: () => ({ release() {} }),
        onProjectionChanged: () => {},
        requestDrain: () => assert.fail('observation must not drain the Host'),
      });
      const query = async () => (await goal.readEventWaits(f.identity.sessionId)).items[0]!;
      const errors: unknown[] = [];
      const changes: AnyEventWaitRecord[] = [];
      const entered = deferred<void>();
      const release = deferred<void>();
      let rolling = false;
      const store: EventWaitObservationStore<ConsumerEventWaitRecord> = {
        read: async () => structuredClone(row),
        listByStatus: async ({ status }) => ({
          items: status === row.record.status ? [structuredClone(row)] : [],
          nextCursor: null,
        }),
        listForObservation: async () =>
          row.record.status === 'waiting' && (row.record.observation?.nextObserveAt ?? 0) <= now
            ? [structuredClone(row)]
            : [],
        readSourceCooldown: async () => null,
        extendSourceCooldown: async ({ until }) => until,
        reserveSourceDispatch: async () => true,
        completeSourceDispatch: async () => 0,
        commit: async (input) => {
          if (input.expectedAuthorityRevision !== row.authorityRevision)
            return { kind: 'revision_conflict', actualAuthorityRevision: row.authorityRevision };
          assertAnyEventWaitTransition(row.record, input.record);
          row = { authorityRevision: row.authorityRevision + 1, record: input.record };
          return { kind: 'committed', snapshot: structuredClone(row) };
        },
      };
      const source: EventWaitSourceAdapter = {
        providerId: 'test',
        resourceType: 'job',
        conditionType: 'terminal',
        conditionVersion: 1,
        reconciliation: 'snapshot',
        validate() {},
        async read({ cursor }) {
          assert.equal(cursor, 'old-cursor');
          if (rolling) {
            entered.resolve();
            await release.promise;
          }
          const kind = rolling ? nextOutcome : initialOutcome;
          return kind === 'satisfied'
            ? { kind, receiptKey: 'done', evidenceRefs: [] }
            : kind === 'unknown'
              ? { kind, reason: 'observation_failed' }
              : { kind };
        },
      };
      const observer = new HostEventWaitObserver({
        store,
        clock,
        decodeRecord: decodeAnyEventWaitRecord,
        adapters: new EventWaitAdapterRegistry([source]),
        authorize: async () => ({ kind: 'allowed', context: {} }),
        policy: { minIntervalMs: 1, pollIntervalMs: 2, jitterRatio: 0 },
        onError: (error) => errors.push(error),
        onChanged: (record) => changes.push(record),
      });
      try {
        await observer.start();
        await eventually(
          () =>
            row.record.observation?.attempts === EVENT_WAIT_LIMITS.observationAttempts &&
            row.record.observation.outcome === initialOutcome,
        );
        assert.equal((await query()).observation, initialOutcome);
        changes.length = 0;
        rolling = true;
        now += 1_000_000;
        await observer.reconcile();
        await entered.promise;
        assert.equal(
          (await query()).observation,
          initialOutcome,
          'a reconnect during checking must retain the last completed observation',
        );
        assert.equal(row.record.status, 'waiting');
        assert.equal(row.record.deadlineAt, null);
        assert.equal(row.record.observation?.window, 1);
        assert.equal(row.record.observation?.attempts, 1);
        release.resolve();
        await eventually(() => row.record.observation?.outcome === nextOutcome);
        assert.equal((await query()).observation, nextOutcome === 'satisfied' ? null : nextOutcome);
        assert.equal(
          changes.length,
          initialOutcome === nextOutcome ? 0 : 1,
          'unchanged polling stays silent, while meaningful changes invalidate the query',
        );
        assert.equal(row.record.observation?.consecutiveErrors, nextOutcome === 'unknown' ? 1 : 0);
        decodeAnyEventWaitRecord(row.record);
        if (nextOutcome !== 'satisfied') {
          now += 1_000_000;
          await observer.reconcile();
          await eventually(
            () =>
              row.record.observation?.attempts === 2 &&
              row.record.observation.outcome === nextOutcome,
          );
          assert.equal(
            row.record.observation?.consecutiveErrors,
            nextOutcome === 'unknown' ? 2 : 0,
          );
          assert.equal(changes.length, initialOutcome === nextOutcome ? 0 : 1);
        }
        assert.deepEqual(errors, []);
      } finally {
        release.resolve();
        await observer.close();
        await goal.close();
      }
    });
  }
}

test('admission latches Goal capability only for its exact Run, including pause before first wait', async (t) => {
  const f = await fixture(t);
  let goal = true;
  f.coordinator.admitRun(f.identity, goal);
  goal = false;
  const capability = f.coordinator.createTool(f.identity.sessionId, () => goal);
  assert.equal(capability.available(f.identity), true);
  assert.equal(capability.available({ ...f.identity, runId: 'another-run' }), false);
  assert.equal(capability.available(), false, 'baseline catalog does not inherit a prior Run');
  f.coordinator.releaseRun(f.identity);
  assert.equal(capability.available(f.identity), false);
});

test('parallel interrupted waits with the same condition retain their exact individual deadlines', async (t) => {
  const f = await fixture(t);
  const capability = f.coordinator.createTool(f.identity.sessionId, () => true);
  const steering = deferred<void>();
  const a = await f.prepare('deadline-a', 10_000, 'shared');
  const b = await f.prepare('deadline-b', 60_000, 'shared');
  a.context.waitForSteering = b.context.waitForSteering = () => steering.promise;
  const pa = capability.tool.impl(a.request, a.context) as Promise<EventWaitToolResult>;
  const pb = capability.tool.impl(b.request, b.context) as Promise<EventWaitToolResult>;
  await eventually(async () => (await f.waits()).items.length === 2);
  steering.resolve(undefined);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.ok(ra.deadlineAt! < rb.deadlineAt!);
  await f.ack(a.context, ra);
  await f.ack(b.context, rb);
  for (const [id, resourceId, resumeWaitId] of [
    ['unknown-resume', 'shared', 'unknown-wait'],
    ['different-resource', 'other', ra.waitId],
  ] as const) {
    const invalid = await f.prepare(id, 90_000, resourceId, resumeWaitId);
    await assert.rejects(
      async () => capability.tool.impl(invalid.request, invalid.context),
      /resumeWaitId/,
    );
  }
  // Resume in the opposite order: deadlines belong to IDs, never completion order.
  f.resolve('shared');
  const nextB = await f.prepare('resume-b', 90_000, 'shared', rb.waitId);
  const resumedB = (await capability.tool.impl(
    nextB.request,
    nextB.context,
  )) as EventWaitToolResult;
  assert.equal(resumedB.deadlineAt, rb.deadlineAt);
  const nextA = await f.prepare('resume-a', 90_000, 'shared', ra.waitId);
  const resumedA = (await capability.tool.impl(
    nextA.request,
    nextA.context,
  )) as EventWaitToolResult;
  assert.equal(resumedA.deadlineAt, ra.deadlineAt);
  assert.deepEqual(f.errors, []);
});

for (const backend of ['Memory', 'SQLite'] as const) {
  for (const scenario of [
    { name: 'unbounded after finite', priorTimeout: 10_000, timeout: undefined, count: 1 },
    { name: 'longer after finite', priorTimeout: 10_000, timeout: 60_000, count: 1 },
    { name: 'finite after unbounded', priorTimeout: undefined, timeout: 60_000, count: 1 },
    { name: 'new after two interrupted waits', priorTimeout: 10_000, timeout: undefined, count: 2 },
  ]) {
    test(`${backend}: independent same-condition wait is ${scenario.name}`, async (t) => {
      const f = await fixture(t, backend);
      const capability = f.coordinator.createTool(f.identity.sessionId, () => true);
      const steering = deferred<void>();
      const interrupted: EventWaitToolResult[] = [];
      const originals = [];
      for (let i = 0; i < scenario.count; i++) {
        const original = await f.prepare(`original-${i}`, scenario.priorTimeout, 'shared');
        original.context.waitForSteering = () => steering.promise;
        const pending = capability.tool.impl(
          original.request,
          original.context,
        ) as Promise<EventWaitToolResult>;
        originals.push({ original, pending });
        await eventually(async () => (await f.waits()).items.length === i + 1);
      }
      steering.resolve();
      for (const { original, pending } of originals) {
        const result = await pending;
        assert.equal(result.outcome, 'interrupted');
        await f.ack(original.context, result);
        interrupted.push(result);
      }

      f.resolve('shared');
      const fresh = await f.prepare('fresh', scenario.timeout, 'shared');
      const result = (await capability.tool.impl(
        fresh.request,
        fresh.context,
      )) as EventWaitToolResult;
      assert.equal(result.outcome, 'satisfied');
      const registered = await f.stores.eventWaitStore.readAny({
        sessionId: f.identity.sessionId,
        waitId: result.waitId,
      });
      assert.ok(registered);
      assert.equal(
        result.deadlineAt,
        scenario.timeout === undefined ? null : registered.record.createdAt + scenario.timeout,
      );
      assert.ok(interrupted.every((prior) => prior.waitId !== result.waitId));
      await f.ack(fresh.context, result);

      // A new operation must not consume any unselected interrupted identity.
      for (const [i, prior] of interrupted.entries()) {
        const resume = await f.prepare(`resume-${i}`, 90_000, 'shared', prior.waitId);
        const resumed = (await capability.tool.impl(
          resume.request,
          resume.context,
        )) as EventWaitToolResult;
        assert.equal(resumed.outcome, 'satisfied');
        assert.equal(resumed.deadlineAt, prior.deadlineAt);
        assert.notEqual(resumed.waitId, prior.waitId);
        await f.ack(resume.context, resumed);
        const duplicate = await f.prepare(`duplicate-${i}`, undefined, 'shared', prior.waitId);
        await assert.rejects(
          async () => capability.tool.impl(duplicate.request, duplicate.context),
          /resumeWaitId/,
        );
      }
      const registeredWaits = (await f.waits()).items;
      assert.equal(registeredWaits.length, scenario.count * 2 + 1);
      await Promise.all(registeredWaits.map(({ record }) => f.waitForDelivery(record.waitId)));
      assert.ok(
        (await f.waits()).items.every(({ record }) => record.delivery?.kind === 'consumed'),
      );
      assert.deepEqual(f.errors, []);
    });
  }
}

for (const blocked of ['registration', 'cooldown'] as const) {
  test(`finite deadlines expire while ${blocked} is pending`, {
    timeout: 10_000,
  }, async (t) => {
    const registering = deferred<ConsumerEventWaitRecord>();
    const releaseRegistration = deferred<void>();
    let now = Date.now();
    const f = await fixture(
      t,
      'Memory',
      {
        now: () => now,
        schedule(callback, delay) {
          const timer = setTimeout(callback, delay);
          timer.unref();
          return () => clearTimeout(timer);
        },
      },
      blocked === 'registration'
        ? async (record) => {
            registering.resolve(record);
            await releaseRegistration.promise;
          }
        : undefined,
    );
    if (blocked === 'cooldown')
      await f.stores.eventWaitStore.extendSourceCooldown({
        providerId: 'test',
        connectionId: null,
        observedAt: now,
        until: now + 60_000,
      });
    const a = await f.prepare(`deadline-${blocked}`, 25);
    const pending = f.coordinator
      .createTool(f.identity.sessionId, () => true)
      .tool.impl(a.request, a.context) as Promise<EventWaitToolResult>;
    try {
      if (blocked === 'registration') {
        const record = await registering.promise;
        assert.equal((await f.waits()).items.length, 0);
        now = record.deadlineAt!;
      } else {
        await eventually(async () => (await f.waits()).items.length === 1);
        now += 25;
      }
      releaseRegistration.resolve();
      await f.observer.reconcile();
      const result = await pending;
      assert.equal(result.outcome, 'expired');
      assert.equal(result.deadlineAt, now);
      assert.equal((await f.waits()).items[0]?.record.status, 'expired');
      assert.equal(f.reads.size, 0);
      await f.ack(a.context, result);
      await f.waitForDelivery(result.waitId);
      assert.equal((await f.waits()).items[0]?.record.delivery?.kind, 'consumed');
      assert.deepEqual(f.errors, []);
    } finally {
      releaseRegistration.resolve();
      a.abort.abort();
      await pending.catch(() => undefined);
    }
  });
}

for (const backend of ['Memory', 'SQLite'] as const) {
  test(`${backend}: current-turn input interrupts a wait during durable registration`, async (t) => {
    const registering = deferred<void>();
    const releaseRegistration = deferred<void>();
    const steering = deferred<void>();
    const f = await fixture(t, backend, undefined, async () => {
      registering.resolve();
      await releaseRegistration.promise;
    });
    const a = await f.prepare('steer-registration');
    let steeringListeners = 0;
    a.context.waitForSteering = () => {
      steeringListeners++;
      return steering.promise;
    };
    const pending = f.coordinator
      .createTool(f.identity.sessionId, () => true)
      .tool.impl(a.request, a.context) as Promise<EventWaitToolResult>;
    void pending.catch(() => undefined);
    try {
      await registering.promise;
      assert.equal(steeringListeners, 1, 'steering is active during the storage operation');
      assert.equal((await f.waits()).items.length, 0);
      steering.resolve();
      releaseRegistration.resolve();
      const result = await pending;
      assert.equal(result.outcome, 'interrupted');
      assert.equal(result.reason, 'user_input');
      assert.equal(result.deadlineAt, null);
      assert.equal(f.reads.size, 0, 'interruption needs no observation of the source');
      assert.equal((await f.waits()).items[0]?.record.status, 'cancelled');
      await f.ack(a.context, result);
      await f.waitForDelivery(result.waitId);
      assert.equal((await f.waits()).items[0]?.record.delivery?.kind, 'consumed');
      assert.deepEqual(f.errors, []);
    } finally {
      releaseRegistration.resolve();
      a.abort.abort();
      await pending.catch(() => undefined);
    }
  });
}

for (const backend of ['Memory', 'SQLite'] as const)
  for (const boundary of ['read', 'commit'] as const)
    test(`${backend}: consumption wins cancellation before observer ${boundary}`, async (t) => {
      const f = await fixture(t, backend);
      const a = await f.prepare('cancel-ack-race');
      f.resolve('cancel-ack-race');
      const result = (await f.coordinator
        .createTool(f.identity.sessionId, () => true)
        .tool.impl(a.request, a.context)) as EventWaitToolResult;
      const consume = async () => {
        await f.ack(a.context, result);
        await f.waitForDelivery(result.waitId);
        assert.equal((await f.waits()).items[0]!.record.delivery?.kind, 'consumed');
      };
      if (boundary === 'read') {
        const cancel = f.observer.cancel.bind(f.observer);
        f.observer.cancel = async (identity, reason) => {
          await consume();
          return cancel(identity, reason);
        };
      } else {
        const commit = f.observationStore.commit.bind(f.observationStore);
        let consumed = false;
        f.observationStore.commit = async (input) => {
          if (input.record.status === 'cancelled' && !consumed) {
            consumed = true;
            await consume();
          }
          return commit(input);
        };
      }
      assert.equal(
        await f.coordinator.cancel({
          ...f.identity,
          waitId: result.waitId,
          operationId: a.context.operationId!,
        }),
        false,
      );
      const final = (await f.waits()).items[0]!.record;
      assert.equal(final.status, 'resolved');
      assert.equal(final.delivery?.kind, 'consumed');
      assert.deepEqual(f.errors, []);
    });

for (const backend of ['Memory', 'SQLite'] as const)
  for (const mode of ['callback', 'scan'] as const)
    for (const isError of [false, true])
      test(`${backend}: ${mode} publishes invalidation after durable ${isError ? 'retirement' : 'consumption'}`, async (t) => {
        const f = await fixture(t, backend);
        const a = await f.prepare('publication');
        f.resolve('publication');
        const capability = f.coordinator.createTool(f.identity.sessionId, () => true);
        const result = (await capability.tool.impl(a.request, a.context)) as EventWaitToolResult;
        assert.deepEqual(
          f.invalidations,
          [f.identity.sessionId],
          'registration is visible before delivery',
        );
        f.invalidations.length = 0;
        const resultEventId = await f.ack(a.context, result, isError);
        if (mode === 'callback')
          await f.coordinator.acknowledge({
            ...f.identity,
            operationId: a.context.operationId!,
            toolCallId: a.context.toolCallId,
            resultEventId,
            result,
            isError,
          });
        else await f.waitForDelivery(result.waitId, isError ? 'retired' : 'consumed');
        assert.equal(
          (await f.waits()).items[0]?.record.delivery?.kind,
          isError ? 'retired' : 'consumed',
        );
        assert.ok(f.invalidations.includes(f.identity.sessionId));
        assert.deepEqual(f.errors, []);
      });
