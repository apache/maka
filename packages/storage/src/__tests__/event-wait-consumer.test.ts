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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  eventWaitDeliveryKey,
  type ConsumerEventWaitRecord,
  type EventWaitRecord,
} from '@maka/core/event-wait';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';
import type { ExecutionPersistenceProvider } from '../execution-persistence-provider.js';

async function fixture(provider: ExecutionPersistenceProvider) {
  const root = await mkdtemp(join(tmpdir(), 'maka-consumer-wait-'));
  const stores = await provider.open({ rootId: 'test-root', canonicalPath: root });
  const session = await stores.sessionStore.create({
    cwd: root,
    llmConnectionSlug: 'test',
    model: 'test',
    permissionMode: 'ask',
  });
  const sessionId = session.id;
  await stores.agentRunStore.admitRootTurn({
    sessionId,
    turnId: 'turn',
    proposedRunId: 'run',
    proposedUserMessageId: 'message',
    execution: { kind: 'external_message' },
    previousRootTurnId: null,
    normalizedInput: { text: 'work' },
    sourceMessages: [],
    admittedAt: 1,
  });
  const base = {
    sessionId,
    runId: 'run',
    turnId: 'turn',
    invocationId: 'invocation',
    partial: false,
    ts: 10,
  };
  const make = (suffix: string): ConsumerEventWaitRecord => ({
    schemaVersion: 2,
    waitId: `wait_${suffix}`,
    sessionId,
    sourceTurnId: 'turn',
    consumer: {
      kind: 'tool_invocation',
      runId: 'run',
      invocationId: 'invocation',
      operationId: `op_${suffix}`,
      toolCallId: `call_${suffix}`,
    },
    resource: { providerId: 'test', connectionId: null, resourceType: 'job', resourceId: suffix },
    condition: { typeId: 'terminal', version: 1, parameters: {} },
    deadlineAt: null,
    createdAt: 10,
    updatedAt: 10,
    deliveryKey: eventWaitDeliveryKey(`wait_${suffix}`),
    status: 'waiting',
  });
  const prepare = async (
    r: ConsumerEventWaitRecord,
    input: {
      toolName?: string;
      args?: Record<string, unknown>;
    } = {},
  ) => {
    assert.equal(r.consumer.kind, 'tool_invocation');
    if (r.consumer.kind !== 'tool_invocation') throw new Error('test consumer');
    const c = r.consumer,
      args = input.args ?? { resource: r.resource, condition: r.condition };
    const toolName = input.toolName ?? 'WaitForEvent';
    const hash = canonicalToolArgsHash(toolName, args);
    const call: RuntimeEvent = {
      ...base,
      id: `${c.operationId}_call`,
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: c.toolCallId, name: toolName, args },
    };
    const dispatch: RuntimeEvent = {
      ...base,
      id: `${c.operationId}_dispatch`,
      role: 'system',
      author: 'system',
      refs: { operationId: c.operationId, toolCallId: c.toolCallId },
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: c.operationId,
          providerToolCallId: c.toolCallId,
          toolName,
          canonicalArgsHash: hash,
          recoveryMode: 'never_auto_retry',
        },
      },
    };
    await stores.runtimeEventStore.commitToolPrepared({
      operationId: c.operationId,
      journalEventId: `${c.operationId}_prepared`,
      runtimeEvent: call,
      dispatchRuntimeEvent: dispatch,
      providerToolCallId: c.toolCallId,
      toolName,
      canonicalArgsHash: hash,
      recoveryMode: 'never_auto_retry',
      committedAt: 10,
    });
  };
  const outcome = async (r: ConsumerEventWaitRecord, outcome = 'satisfied') => {
    if (r.consumer.kind !== 'tool_invocation') throw new Error('test consumer');
    const c = r.consumer,
      resultEventId = `${c.operationId}_result`;
    await stores.runtimeEventStore.commitToolOutcome({
      operationId: c.operationId,
      journalEventId: `${c.operationId}_outcome`,
      committedAt: 30,
      runtimeEvent: {
        ...base,
        id: resultEventId,
        ts: 30,
        role: 'tool',
        author: 'tool',
        refs: { operationId: c.operationId, toolCallId: c.toolCallId },
        content: {
          kind: 'function_response',
          id: c.toolCallId,
          name: 'WaitForEvent',
          result: {
            kind: 'json',
            value: {
              kind: 'event_wait_result',
              waitId: r.waitId,
              outcome,
              observedAt: 20,
              deadlineAt: r.deadlineAt,
              evidenceRefs: ['ref'],
            },
          },
        },
      },
    });
    return { sessionId, waitId: r.waitId, operationId: c.operationId, resultEventId, at: 40 };
  };
  const resolve = async (r: ConsumerEventWaitRecord) => {
    const resolved: ConsumerEventWaitRecord = {
      ...r,
      status: 'resolved',
      resolvedAt: 20,
      updatedAt: 20,
      resolution: {
        outcome: 'satisfied',
        observedAt: 20,
        receiptKey: 'receipt',
        evidenceRefs: ['ref'],
      },
    };
    assert.equal(
      (
        await stores.eventWaitStore.commitAny({
          sessionId,
          waitId: r.waitId,
          expectedAuthorityRevision: 0,
          record: resolved,
        })
      ).kind,
      'committed',
    );
    return resolved;
  };
  return {
    root,
    stores,
    sessionId,
    make,
    prepare,
    outcome,
    resolve,
    close: async () => {
      await stores.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('SQLite: consumer checks do not materialize unrelated Run payloads', async (t) => {
  const f = await fixture(localExecutionPersistenceProvider);
  try {
    const a = f.make('bounded');
    await f.prepare(a);
    const b = f.make('retired');
    await f.prepare(b);
    await f.stores.runtimeEventStore.appendRuntimeEvent(f.sessionId, 'run', {
      id: 'unrelated-large-result',
      sessionId: f.sessionId,
      runId: 'run',
      turnId: 'turn',
      invocationId: 'invocation',
      partial: false,
      ts: 11,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'x'.repeat(1024 * 1024) },
    });
    const payloadIds: string[] = [];
    let observing = true;
    const inspect = (row: Record<string, unknown> | undefined) => {
      if (observing && typeof row?.payload_json === 'string')
        payloadIds.push((JSON.parse(row.payload_json) as RuntimeEvent).id);
    };
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      const all = statement.all,
        get = statement.get;
      t.mock.method(
        statement,
        'all',
        function (this: StatementSync, ...args: Parameters<StatementSync['all']>) {
          const result = all.apply(this, args);
          result.forEach(inspect);
          return result;
        },
      );
      t.mock.method(
        statement,
        'get',
        function (this: StatementSync, ...args: Parameters<StatementSync['get']>) {
          const result = get.apply(this, args);
          inspect(result);
          return result;
        },
      );
      return statement;
    });
    await f.stores.eventWaitStore.registerInvocationWait({ record: a });
    await f.stores.eventWaitStore.registerInvocationWait({ record: b });
    observing = false;
    await f.resolve(a);
    const ack = await f.outcome(a);
    observing = true;
    assert.equal(
      (await f.stores.eventWaitStore.acknowledgeInvocationWaitResult(ack))?.record.delivery?.kind,
      'consumed',
    );
    observing = false;
    await f.stores.runtimeEventStore.ensureRecoveredTerminalRuntimeEventDurable(
      f.sessionId,
      'run',
      {
        id: 'large-terminal',
        sessionId: f.sessionId,
        runId: 'run',
        turnId: 'turn',
        invocationId: 'invocation',
        partial: false,
        ts: 50,
        role: 'system',
        author: 'system',
        status: 'failed',
        actions: {
          endInvocation: true,
          stateDelta: { recovered: true, recoveryReason: 'outcome_unknown' },
        },
        content: { kind: 'text', text: 'x'.repeat(1024 * 1024) },
      },
      ['op_retired'],
    );
    observing = true;
    assert.equal(
      (
        await f.stores.eventWaitStore.retireInvocationWait({
          sessionId: f.sessionId,
          waitId: b.waitId,
          operationId: 'op_retired',
          at: 51,
          reason: 'run_ended',
        })
      )?.record.delivery?.kind,
      'retired',
    );
    assert.ok(payloadIds.includes('op_bounded_call'));
    assert.ok(payloadIds.includes('op_bounded_result'));
    assert.ok(
      !payloadIds.includes('unrelated-large-result'),
      'consumer checks must select their proof before materializing payloads',
    );
    assert.ok(
      !payloadIds.includes('large-terminal'),
      'terminal existence must not materialize its payload',
    );
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

for (const backend of ['SQLite', 'Memory']) {
  const provider = () =>
    backend === 'SQLite'
      ? localExecutionPersistenceProvider
      : createMemoryExecutionPersistenceProvider();
  test(`${backend}: invocation and neutral observations share scheduling with separate query projections`, async () => {
    const f = await fixture(provider());
    try {
      const a = f.make('a'),
        b = f.make('b');
      await f.prepare(a);
      await f.prepare(b);
      await f.stores.eventWaitStore.registerInvocationWait({ record: a });
      await f.stores.eventWaitStore.registerInvocationWait({ record: b });
      assert.equal(
        (await f.stores.eventWaitStore.listAnyForObservation({ limit: 10, now: 900_000_000 }))
          .length,
        2,
      );
      assert.equal(
        (await f.stores.eventWaitStore.listByStatus({ status: 'waiting', limit: 10 })).items.length,
        0,
      );
      assert.equal(
        (await f.stores.eventWaitStore.listForObservation({ limit: 10, now: 20 })).length,
        0,
      );
      assert.equal(
        await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: a.waitId }),
        null,
      );
      const observation: EventWaitRecord = {
        schemaVersion: 1,
        waitId: 'observation',
        sessionId: f.sessionId,
        sourceTurnId: 'old',
        sourceToolCallId: 'call',
        resource: a.resource,
        condition: a.condition,
        deadlineAt: 100,
        createdAt: 10,
        updatedAt: 10,
        status: 'waiting',
        deliveryKey: 'event-wait/observation',
      };
      assert.equal(
        (
          await f.stores.eventWaitStore.commit({
            sessionId: f.sessionId,
            waitId: 'observation',
            expectedAuthorityRevision: null,
            record: observation,
          })
        ).kind,
        'committed',
      );
      assert.equal((await f.stores.eventWaitStore.listAny({ limit: 10 })).items.length, 3);
      assert.equal(
        (await f.stores.eventWaitStore.listByStatus({ status: 'waiting', limit: 10 })).items.length,
        1,
      );
      assert.equal(
        (await f.stores.eventWaitStore.listAny({ limit: 10, consumerKind: 'tool_invocation' }))
          .items.length,
        2,
      );
      await f.resolve(a);
      const ack = await f.outcome(a);
      const first = await f.stores.eventWaitStore.acknowledgeInvocationWaitResult(ack);
      assert.equal(first?.record.delivery?.kind, 'consumed');
      assert.deepEqual(await f.stores.eventWaitStore.acknowledgeInvocationWaitResult(ack), first);
      assert.equal(
        (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: b.waitId }))
          ?.record.status,
        'waiting',
      );
      assert.equal(
        (
          await f.stores.eventWaitStore.listAny({
            limit: 10,
            consumerKind: 'tool_invocation',
            deliveryOutstanding: true,
          })
        ).items.length,
        1,
      );
    } finally {
      await f.close();
    }
  });
  test(`${backend}: T1 and original arguments are required; ordinary commit cannot create or ACK consumer waits`, async () => {
    const f = await fixture(provider());
    try {
      const a = f.make('a');
      await assert.rejects(
        async () => f.stores.eventWaitStore.registerInvocationWait({ record: a }),
        /live admitted tool/,
      );
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.commitAny({
            sessionId: f.sessionId,
            waitId: a.waitId,
            expectedAuthorityRevision: null,
            record: a,
          }),
        /authenticated registration/,
      );
      const unrelated = f.make('unrelated');
      await f.prepare(unrelated, { toolName: 'Bash' });
      await assert.rejects(
        async () => f.stores.eventWaitStore.registerInvocationWait({ record: unrelated }),
        /live admitted tool/,
      );
      await f.prepare(a);
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.registerInvocationWait({
            record: { ...a, resource: { ...a.resource, resourceId: 'other' } },
          }),
        /arguments changed/,
      );
      const registered = await f.stores.eventWaitStore.registerInvocationWait({ record: a });
      assert.deepEqual(
        await f.stores.eventWaitStore.registerInvocationWait({ record: a }),
        registered,
      );
      const r = await f.resolve(a);
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.acknowledgeInvocationWaitResult({
            sessionId: f.sessionId,
            waitId: a.waitId,
            operationId: 'op_a',
            resultEventId: 'fake',
            at: 40,
          }),
        /durable tool outcome/,
      );
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.commitAny({
            sessionId: f.sessionId,
            waitId: a.waitId,
            expectedAuthorityRevision: 1,
            record: { ...r, updatedAt: 40, delivery: { kind: 'retired', reason: 'fake', at: 40 } },
          }),
        /authenticated acknowledgement/,
      );
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.retireInvocationWait({
            sessionId: f.sessionId,
            waitId: a.waitId,
            operationId: 'op_a',
            at: 40,
            reason: 'receiver gone',
          }),
        /Live event wait/,
      );
    } finally {
      await f.close();
    }
  });
  test(`${backend}: ACK accepts durable T2 after cancellation preserved its original resolution`, async () => {
    const f = await fixture(provider());
    try {
      const a = f.make('a');
      await f.prepare(a);
      await f.stores.eventWaitStore.registerInvocationWait({ record: a });
      const resolved = await f.resolve(a);
      assert.equal(resolved.status, 'resolved');
      if (resolved.status !== 'resolved') throw new Error('test result');
      const ack = await f.outcome(a);
      const cancelled: ConsumerEventWaitRecord = {
        ...a,
        status: 'cancelled',
        updatedAt: 35,
        cancelledAt: 35,
        reason: 'stop',
        priorResolution: { resolvedAt: resolved.resolvedAt, resolution: resolved.resolution },
      };
      await f.stores.eventWaitStore.commitAny({
        sessionId: f.sessionId,
        waitId: a.waitId,
        expectedAuthorityRevision: 1,
        record: cancelled,
      });
      const consumed = await f.stores.eventWaitStore.acknowledgeInvocationWaitResult(ack);
      assert.equal(consumed?.record.delivery?.kind, 'consumed');
      assert.equal(consumed?.record.status, 'cancelled');
      assert.equal(
        (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: a.waitId }))
          ?.record.delivery?.kind,
        'consumed',
      );
    } finally {
      await f.close();
    }
  });
  test(`${backend}: an ordinary error T2 retires only its receiver while the Run remains live`, async () => {
    const f = await fixture(provider());
    try {
      const a = f.make('a'),
        b = f.make('b');
      await f.prepare(a);
      await f.prepare(b);
      await f.stores.eventWaitStore.registerInvocationWait({ record: a });
      await f.stores.eventWaitStore.registerInvocationWait({ record: b });
      await f.stores.runtimeEventStore.commitToolOutcome({
        operationId: 'op_a',
        journalEventId: 'op_a_outcome',
        committedAt: 30,
        runtimeEvent: {
          sessionId: f.sessionId,
          runId: 'run',
          turnId: 'turn',
          invocationId: 'invocation',
          partial: false,
          id: 'a_error',
          ts: 30,
          role: 'tool',
          author: 'tool',
          refs: { operationId: 'op_a', toolCallId: 'call_a' },
          content: {
            kind: 'function_response',
            id: 'call_a',
            name: 'WaitForEvent',
            isError: true,
            result: { kind: 'text', text: 'Operation aborted' },
          },
        },
      });
      const input = {
        sessionId: f.sessionId,
        waitId: a.waitId,
        operationId: 'op_a',
        at: 40,
        reason: 'receiver_gone',
      };
      const retired = await f.stores.eventWaitStore.retireInvocationWait(input);
      assert.equal(retired?.record.delivery?.kind, 'retired');
      assert.equal(retired?.record.status, 'cancelled');
      assert.deepEqual(await f.stores.eventWaitStore.retireInvocationWait(input), retired);
      assert.equal(
        (await f.stores.eventWaitStore.readAny({ sessionId: f.sessionId, waitId: b.waitId }))
          ?.record.status,
        'waiting',
      );
      await assert.rejects(
        async () =>
          f.stores.eventWaitStore.retireInvocationWait({
            ...input,
            waitId: b.waitId,
            operationId: 'op_b',
          }),
        /Live event wait/,
      );
    } finally {
      await f.close();
    }
  });
}

for (const crashAt of ['registered', 't2'] as const) {
  test(`SQLite: SIGKILL after ${crashAt} retains authority without inventing an execution receiver`, async () => {
    const f = await fixture(localExecutionPersistenceProvider);
    const wait = f.make('crash');
    await f.prepare(wait);
    await f.stores.close();
    let child: ReturnType<typeof spawn> | undefined;
    let reopened: Awaited<ReturnType<typeof localExecutionPersistenceProvider.open>> | undefined;
    try {
      const module = new URL('../local-execution-persistence.js', import.meta.url).href;
      const script = `
        import { localExecutionPersistenceProvider } from ${JSON.stringify(module)};
        const {root, wait, crashAt} = JSON.parse(process.argv[1]);
        const s = await localExecutionPersistenceProvider.open({rootId:'test-root',canonicalPath:root});
        await s.eventWaitStore.registerInvocationWait({record:wait});
        if (crashAt === 't2') {
          await s.eventWaitStore.commitAny({sessionId:wait.sessionId,waitId:wait.waitId,expectedAuthorityRevision:0,
            record:{...wait,status:'resolved',updatedAt:20,resolvedAt:20,resolution:{outcome:'satisfied',receiptKey:'receipt',observedAt:20,evidenceRefs:['ref']}}});
          await s.runtimeEventStore.commitToolOutcome({operationId:'op_crash',journalEventId:'op_crash_outcome',committedAt:30,
            runtimeEvent:{id:'crash_result',sessionId:wait.sessionId,turnId:'turn',runId:'run',invocationId:'invocation',ts:30,partial:false,
              role:'tool',author:'tool',refs:{operationId:'op_crash',toolCallId:'call_crash'},content:{kind:'function_response',id:'call_crash',name:'WaitForEvent',
                result:{kind:'json',value:{kind:'event_wait_result',waitId:wait.waitId,outcome:'satisfied',observedAt:20,deadlineAt:null,evidenceRefs:['ref']}}}}});
        }
        process.stdout.write('committed');
        setInterval(() => {}, 1000);
      `;
      child = spawn(
        process.execPath,
        ['--input-type=module', '-e', script, JSON.stringify({ root: f.root, wait, crashAt })],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let errors = '';
      child.stderr!.on('data', (chunk) => {
        errors += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve());
        child!.once('error', reject);
        child!.once('exit', (code) => reject(new Error(`child exited ${code}: ${errors}`)));
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      reopened = await localExecutionPersistenceProvider.open({
        rootId: 'test-root',
        canonicalPath: f.root,
      });
      const restored = (await reopened.eventWaitStore.readAny({
        sessionId: f.sessionId,
        waitId: wait.waitId,
      }))!;
      assert.equal(restored.record.deadlineAt, null);
      assert.equal(restored.record.delivery, undefined);
      if (crashAt === 't2') {
        const consumed = await reopened.eventWaitStore.acknowledgeInvocationWaitResult({
          sessionId: f.sessionId,
          waitId: wait.waitId,
          operationId: 'op_crash',
          resultEventId: 'crash_result',
          at: 40,
        });
        assert.equal(consumed?.record.delivery?.kind, 'consumed');
      } else {
        assert.equal(restored.record.status, 'waiting');
        await assert.rejects(
          async () =>
            reopened!.eventWaitStore.retireInvocationWait({
              sessionId: f.sessionId,
              waitId: wait.waitId,
              operationId: 'op_crash',
              reason: 'process_gone',
              at: 40,
            }),
          /Live event wait/,
        );
        await reopened.runtimeEventStore.commitToolOutcome({
          operationId: 'op_crash',
          journalEventId: 'op_crash_outcome',
          committedAt: 40,
          runtimeEvent: {
            id: 'recovered_error',
            sessionId: f.sessionId,
            runId: 'run',
            turnId: 'turn',
            invocationId: 'invocation',
            ts: 40,
            partial: false,
            role: 'tool',
            author: 'tool',
            refs: { operationId: 'op_crash', toolCallId: 'call_crash' },
            content: {
              kind: 'function_response',
              id: 'call_crash',
              name: 'WaitForEvent',
              isError: true,
              result: { kind: 'text', text: 'The original execution was interrupted' },
            },
          },
        });
        await reopened.runtimeEventStore.appendRuntimeEvent(f.sessionId, 'run', {
          id: 'recovery_terminal',
          sessionId: f.sessionId,
          runId: 'run',
          turnId: 'turn',
          invocationId: 'invocation',
          ts: 40,
          partial: false,
          role: 'system',
          author: 'system',
          status: 'failed',
          actions: { endInvocation: true },
        });
        const retired = await reopened.eventWaitStore.retireInvocationWait({
          sessionId: f.sessionId,
          waitId: wait.waitId,
          operationId: 'op_crash',
          reason: 'recovery_retired',
          at: 40,
        });
        assert.equal(retired?.record.delivery?.kind, 'retired');
      }
    } finally {
      child?.kill('SIGKILL');
      await reopened?.close();
      await f.close();
    }
  });
}
