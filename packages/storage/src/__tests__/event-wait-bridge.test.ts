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
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GoalAuthorityRecord, GoalPendingContinuation } from '@maka/core/goal';
import {
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ContinuationClaimV1,
} from '@maka/core/runtime-boundary';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import type { EventWaitRecord } from '@maka/core/event-wait';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';
import type {
  ExecutionPersistence,
  ExecutionPersistenceProvider,
} from '../execution-persistence-provider.js';
import { eventWaitProvenance } from '../event-wait-bridge.js';
import { exportSessionBundleState, importSessionBundleState } from '../session-bundle-policy.js';
import {
  createOperationalStateBackup,
  restoreOperationalStateBackup,
} from '../operational-state-backup.js';

async function fixture(provider: ExecutionPersistenceProvider) {
  const root = await mkdtemp(join(tmpdir(), 'maka-wait-bridge-'));
  const open = () => provider.open({ rootId: 'test-root', canonicalPath: root });
  const stores = await open();
  const session = await stores.sessionStore.create({
    cwd: root,
    llmConnectionSlug: 'test',
    model: 'test',
    permissionMode: 'ask',
  });
  const sessionId = session.id;
  const goal: GoalAuthorityRecord = {
    schemaVersion: 1,
    goal: {
      id: 'goal',
      sessionId,
      revision: 0,
      condition: 'Finish',
      status: 'active',
      setAt: 1,
      iterations: 0,
      maxIterations: 10,
      consecutiveNoProgress: 0,
      blockCap: 3,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: false,
    },
    controlLease: { goalId: 'goal', generation: 0 },
    currentExecution: null,
    pendingContinuation: null,
  };
  await stores.goalStore.commit({ sessionId, expectedAuthorityRevision: null, record: goal });
  await stores.agentRunStore.admitRootTurn({
    sessionId,
    turnId: 'source',
    proposedRunId: 'source-run',
    proposedUserMessageId: 'source-message',
    execution: { kind: 'external_message' },
    previousRootTurnId: null,
    normalizedInput: { text: 'work' },
    sourceMessages: [],
    admittedAt: 1,
  });
  const wait: EventWaitRecord = {
    schemaVersion: 1,
    waitId: 'wait',
    sessionId,
    goalControlLease: goal.controlLease,
    sourceTurnId: 'source',
    sourceToolCallId: 'call',
    resource: { providerId: 'test', connectionId: null, resourceType: 'job', resourceId: 'job' },
    condition: { typeId: 'done', version: 1, parameters: {} },
    deliveryKey: 'event-wait/wait',
    createdAt: 10,
    updatedAt: 10,
    deadlineAt: 100,
    status: 'waiting',
  };
  const registration = {
    record: wait,
    sourceExecution: { sessionId, turnId: 'source', runId: 'source-run' },
    expectedGoalRevision: 0,
    reason: 'Waiting for a job',
  };
  const terminate = async () =>
    stores.runtimeEventStore.appendRuntimeEvent(sessionId, 'source-run', {
      id: 'terminal',
      sessionId,
      turnId: 'source',
      runId: 'source-run',
      invocationId: 'source-run',
      ts: 30,
      partial: false,
      role: 'system',
      author: 'system',
      status: 'completed',
      actions: { endInvocation: true, stateDelta: { stopReason: 'event_wait' } },
    });
  const settle = async () =>
    stores.eventWaitStore.settleGoalWait({
      sessionId,
      waitId: 'wait',
      expectedGoalRevision: 0,
      goal: { ...goal.goal, revision: 1, iterations: 1, tokensNow: 12 },
    });
  return {
    root,
    stores,
    sessionId,
    goal,
    wait,
    registration,
    terminate,
    settle,
    open,
    close: async () => {
      await stores.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function resolve(
  stores: ExecutionPersistence,
  wait: EventWaitRecord,
  outcome: 'satisfied' | 'invalidated' | 'source_unavailable' | 'expired' = 'satisfied',
) {
  const record: EventWaitRecord =
    outcome === 'expired'
      ? { ...wait, status: 'expired', updatedAt: 100, expiredAt: 100 }
      : {
          ...wait,
          status: 'resolved',
          updatedAt: 20,
          resolvedAt: 20,
          resolution: { outcome, receiptKey: 'receipt', observedAt: 20, evidenceRefs: ['ref'] },
        };
  const result = await stores.eventWaitStore.commit({
    sessionId: wait.sessionId,
    waitId: wait.waitId,
    expectedAuthorityRevision: 0,
    record,
  });
  assert.equal(result.kind, 'committed');
  return record;
}
function pending(record: EventWaitRecord): GoalPendingContinuation {
  return {
    checkpoint: { goalId: 'goal', revision: 1 },
    controlLease: { goalId: 'goal', generation: 0 },
    triggeringTurnId: 'source',
    prompt: 'Untrusted result data',
    eventWait: {
      execution: { sessionId: record.sessionId, turnId: 'next', runId: 'next-run' },
      userMessageId: 'next-message',
      provenance: eventWaitProvenance(record),
    },
  };
}
function admission(record: EventWaitRecord, p: GoalPendingContinuation) {
  return {
    sessionId: record.sessionId,
    turnId: 'next',
    proposedRunId: 'next-run',
    proposedUserMessageId: 'next-message',
    execution: { kind: 'goal' as const, goalId: 'goal', eventWait: p.eventWait!.provenance },
    previousRootTurnId: 'source',
    normalizedInput: { text: p.prompt },
    sourceMessages: [],
    admittedAt: 110,
  };
}
for (const name of ['SQLite', 'Memory']) {
  const provider = () =>
    name === 'SQLite'
      ? localExecutionPersistenceProvider
      : createMemoryExecutionPersistenceProvider();
  for (const status of ['active', 'waiting'] as const)
    test(`${name}: registration replaces ordinary ${status} pending without charging work`, async () => {
      const f = await fixture(provider());
      try {
        const before = {
          ...f.goal,
          goal: {
            ...f.goal.goal,
            status,
            iterations: 2,
            consecutiveNoProgress: 1,
            tokensAtStart: 12,
            tokensNow: 24,
          },
          pendingContinuation: {
            checkpoint: { goalId: 'goal', revision: 0 },
            controlLease: f.goal.controlLease,
            prompt: 'Older ordinary work',
          },
        };
        await f.stores.goalStore.commit({
          sessionId: f.sessionId,
          expectedAuthorityRevision: 0,
          record: before,
        });
        const result = await f.stores.eventWaitStore.registerGoalWait(f.registration);
        assert.deepEqual(result.goal.record.goal, {
          ...before.goal,
          status: 'active',
          revision: status === 'waiting' ? 1 : 0,
        });
        assert.equal(result.goal.record.pendingContinuation, null);
        assert.deepEqual(
          result.goal.record.currentExecution?.execution,
          f.registration.sourceExecution,
        );
        assert.deepEqual(result.goal.record.controlLease, before.controlLease);
        assert.equal(result.goal.record.activeEventWait?.settled, false);
        assert.deepEqual(await f.stores.eventWaitStore.registerGoalWait(f.registration), result);
      } finally {
        await f.close();
      }
    });
  for (const outcome of ['satisfied', 'invalidated', 'source_unavailable', 'expired'] as const)
    test(`${name}: ${outcome} waits settle and admit exactly one fixed successor`, async () => {
      const f = await fixture(provider());
      try {
        const registered = await f.stores.eventWaitStore.registerGoalWait(f.registration);
        assert.deepEqual(
          await f.stores.eventWaitStore.registerGoalWait(f.registration),
          registered,
        );
        await assert.rejects(
          async () =>
            f.stores.eventWaitStore.registerGoalWait({
              ...f.registration,
              record: { ...f.wait, deadlineAt: 200 },
            }),
          /Conflicting/,
        );
        const result = await resolve(f.stores, f.wait, outcome),
          p = pending(result);
        await assert.rejects(
          async () =>
            f.stores.eventWaitStore.queueGoalWait({
              sessionId: f.sessionId,
              waitId: 'wait',
              expectedGoalRevision: 0,
              pending: p,
            }),
          /not ready/,
        );
        await assert.rejects(f.settle, /durable.*yield/);
        await f.terminate();
        const settled = await f.settle();
        assert.equal(settled.goal.record.goal.iterations, 1);
        assert.deepEqual(await f.settle(), settled);
        const queue = {
          sessionId: f.sessionId,
          waitId: 'wait',
          expectedGoalRevision: 1,
          pending: p,
        };
        const queued = await f.stores.eventWaitStore.queueGoalWait(queue);
        assert.deepEqual(await f.stores.eventWaitStore.queueGoalWait(queue), queued);
        await assert.rejects(
          async () =>
            f.stores.eventWaitStore.queueGoalWait({
              ...queue,
              pending: { ...p, prompt: 'changed' },
            }),
          /Conflicting/,
        );
        const input = admission(result, p);
        await assert.rejects(
          f.stores.agentRunStore.admitRootTurn({ ...input, normalizedInput: { text: 'changed' } }),
          /admission changed/,
        );
        assert.equal(
          (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))?.record
            .delivery,
          undefined,
        );
        assert.equal((await f.stores.agentRunStore.admitRootTurn(input)).kind, 'admitted');
        assert.equal((await f.stores.agentRunStore.admitRootTurn(input)).kind, 'existing');
        const authority = await f.stores.goalStore.read(f.sessionId);
        assert.equal(authority?.record.activeEventWait, undefined);
        assert.equal(authority?.record.pendingContinuation, null);
        assert.equal(authority?.record.currentExecution?.execution.turnId, 'next');
        const stored = await f.stores.eventWaitStore.read({
          sessionId: f.sessionId,
          waitId: 'wait',
        });
        assert.equal(stored?.record.status, result.status);
        assert.equal(stored?.record.delivery?.kind, 'admitted');
        assert.equal(
          (
            await f.stores.eventWaitStore.listByStatus({
              status: result.status,
              limit: 10,
              deliveryOutstanding: true,
            })
          ).items.length,
          0,
        );
        await assert.rejects(
          f.stores.agentRunStore.admitRootTurn({
            ...input,
            turnId: 'duplicate',
            proposedRunId: 'duplicate-run',
          }),
        );
        // A later legitimate registration can occupy the released slot.
        await f.stores.eventWaitStore.registerGoalWait({
          ...f.registration,
          expectedGoalRevision: 1,
          sourceExecution: { sessionId: f.sessionId, turnId: 'next', runId: 'next-run' },
          record: {
            ...f.wait,
            waitId: 'second',
            deliveryKey: 'event-wait/second',
            sourceTurnId: 'next',
            sourceToolCallId: 'call-next',
          },
        });
      } finally {
        await f.close();
      }
    });
  test(`${name}: pause suppresses queued delivery and late admission`, async () => {
    const f = await fixture(provider());
    try {
      await f.stores.eventWaitStore.registerGoalWait(f.registration);
      const result = await resolve(f.stores, f.wait);
      await f.terminate();
      await f.settle();
      const p = pending(result);
      await f.stores.eventWaitStore.queueGoalWait({
        sessionId: f.sessionId,
        waitId: 'wait',
        expectedGoalRevision: 1,
        pending: p,
      });
      const old = (await f.stores.goalStore.read(f.sessionId))!;
      const { activeEventWait: _gate, ...base } = old.record;
      await f.stores.goalStore.commit({
        sessionId: f.sessionId,
        expectedAuthorityRevision: old.authorityRevision,
        record: {
          ...base,
          goal: { ...base.goal, revision: 2, status: 'paused' },
          controlLease: { goalId: 'goal', generation: 1 },
          pendingContinuation: null,
        },
      });
      await assert.rejects(f.stores.agentRunStore.admitRootTurn(admission(result, p)));
      const wait = (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))!
        .record;
      assert.equal(wait.status, 'cancelled');
      assert.equal(wait.delivery?.kind, 'suppressed');
      assert.equal(
        wait.status === 'cancelled' && wait.priorResolution?.resolution.receiptKey,
        'receipt',
      );
    } finally {
      await f.close();
    }
  });
}

test('Memory: a lost admission acknowledgement retains one atomic Goal/wait/root commit', async () => {
  let lose = false;
  const f = await fixture(
    createMemoryExecutionPersistenceProvider({
      afterCommit(operation) {
        if (lose && operation === 'agent.admitRoot') {
          lose = false;
          throw new Error('lost acknowledgement');
        }
      },
    }),
  );
  try {
    await f.stores.eventWaitStore.registerGoalWait(f.registration);
    const result = await resolve(f.stores, f.wait);
    await f.terminate();
    await f.settle();
    const p = pending(result);
    await f.stores.eventWaitStore.queueGoalWait({
      sessionId: f.sessionId,
      waitId: 'wait',
      expectedGoalRevision: 1,
      pending: p,
    });
    lose = true;
    await assert.rejects(
      f.stores.agentRunStore.admitRootTurn(admission(result, p)),
      /lost acknowledgement/,
    );
    assert.equal(
      (await f.stores.agentRunStore.admitRootTurn(admission(result, p))).kind,
      'existing',
    );
    assert.equal(
      (await f.stores.goalStore.read(f.sessionId))!.record.currentExecution!.execution.turnId,
      'next',
    );
    assert.equal(
      (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))!.record
        .delivery?.kind,
      'admitted',
    );
  } finally {
    await f.close();
  }
});

for (const backend of ['SQLite', 'Memory'])
  for (const stage of ['register', 'settle', 'queue', 'admit'] as const)
    test(`${backend}: ${stage} rolls back all authority on a failed write`, async () => {
      let fail = false;
      const operations = {
        register: 'eventWait.registerGoal',
        settle: 'eventWait.settleGoal',
        queue: 'eventWait.queueGoal',
        admit: 'agent.admitRoot',
      };
      const f = await fixture(
        backend === 'SQLite'
          ? localExecutionPersistenceProvider
          : createMemoryExecutionPersistenceProvider({
              beforeCommit(op) {
                if (fail && op === operations[stage])
                  throw new Error('injected transaction failure');
              },
            }),
      );
      let db: DatabaseSync | undefined;
      try {
        if (stage === 'register')
          await f.stores.goalStore.commit({
            sessionId: f.sessionId,
            expectedAuthorityRevision: 0,
            record: {
              ...f.goal,
              goal: { ...f.goal.goal, status: 'waiting' },
              pendingContinuation: {
                checkpoint: { goalId: 'goal', revision: 0 },
                controlLease: f.goal.controlLease,
                prompt: 'Keep this ordinary drive if registration fails',
              },
            },
          });
        if (stage !== 'register') await f.stores.eventWaitStore.registerGoalWait(f.registration);
        const result =
          stage === 'queue' || stage === 'admit' ? await resolve(f.stores, f.wait) : f.wait;
        if (stage !== 'register') await f.terminate();
        if (stage === 'queue' || stage === 'admit') await f.settle();
        const p = stage === 'queue' || stage === 'admit' ? pending(result) : undefined;
        const queue = p && {
          sessionId: f.sessionId,
          waitId: 'wait',
          expectedGoalRevision: 1,
          pending: p,
        };
        if (stage === 'admit') await f.stores.eventWaitStore.queueGoalWait(queue!);
        const beforeGoal = await f.stores.goalStore.read(f.sessionId);
        const beforeWait = await f.stores.eventWaitStore.read({
          sessionId: f.sessionId,
          waitId: 'wait',
        });
        if (backend === 'SQLite') {
          db = new DatabaseSync(join(f.root, 'runtime.sqlite'));
          // Fail after the wait write, at the joint Goal write (and before Root insert).
          db.exec(
            "CREATE TRIGGER fail_bridge BEFORE UPDATE ON workflow_goal_authority BEGIN SELECT RAISE(ABORT, 'injected transaction failure'); END",
          );
        }
        fail = true;
        const operation = () =>
          stage === 'register'
            ? f.stores.eventWaitStore.registerGoalWait(f.registration)
            : stage === 'settle'
              ? f.settle()
              : stage === 'queue'
                ? f.stores.eventWaitStore.queueGoalWait(queue!)
                : f.stores.agentRunStore.admitRootTurn(admission(result, p!));
        await assert.rejects(async () => operation(), /injected transaction failure/);
        assert.deepEqual(await f.stores.goalStore.read(f.sessionId), beforeGoal);
        assert.deepEqual(
          await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }),
          beforeWait,
        );
        assert.equal(
          await f.stores.agentRunStore.readRootTurnAdmission(f.sessionId, 'next'),
          undefined,
        );
        fail = false;
        db?.exec('DROP TRIGGER fail_bridge');
        await operation();
      } finally {
        db?.close();
        await f.close();
      }
    });

for (const window of ['registered', 'result', 'queued', 'admitted'] as const)
  test(`SQLite: SIGKILL after ${window} preserves original wait and successor identities`, async () => {
    const f = await fixture(localExecutionPersistenceProvider);
    await f.stores.close();
    let child: ReturnType<typeof spawn> | undefined;
    let reopened: ExecutionPersistence | undefined;
    try {
      const module = new URL('../local-execution-persistence.js', import.meta.url).href;
      const bridge = new URL('../event-wait-bridge.js', import.meta.url).href;
      const script = `
      import {localExecutionPersistenceProvider} from ${JSON.stringify(module)};
      import {eventWaitProvenance} from ${JSON.stringify(bridge)};
      const data = JSON.parse(process.argv[1]);
      const {root, sessionId, registration, goal, window} = data;
      const s = await localExecutionPersistenceProvider.open({rootId:'test-root',canonicalPath:root});
      await s.eventWaitStore.registerGoalWait(registration);
      if (window !== 'registered') {
        await s.runtimeEventStore.appendRuntimeEvent(sessionId,'source-run',{id:'terminal',sessionId,turnId:'source',runId:'source-run',invocationId:'source-run',ts:30,partial:false,role:'system',author:'system',status:'completed',actions:{endInvocation:true,stateDelta:{stopReason:'event_wait'}}});
        await s.eventWaitStore.settleGoalWait({sessionId,waitId:'wait',expectedGoalRevision:0,goal:{...goal.goal,revision:1,iterations:1,tokensNow:12}});
        const result = {...registration.record,status:'resolved',updatedAt:40,resolvedAt:40,resolution:{outcome:'satisfied',receiptKey:'receipt',observedAt:40,evidenceRefs:['ref']}};
        await s.eventWaitStore.commit({sessionId,waitId:'wait',expectedAuthorityRevision:0,record:result});
        if (window !== 'result') {
          const pending = {checkpoint:{goalId:'goal',revision:1},controlLease:goal.controlLease,triggeringTurnId:'source',prompt:'Frozen crash recovery input',eventWait:{execution:{sessionId,turnId:'next',runId:'next-run'},userMessageId:'next-message',provenance:eventWaitProvenance(result)}};
          await s.eventWaitStore.queueGoalWait({sessionId,waitId:'wait',expectedGoalRevision:1,pending});
          if (window === 'admitted') await s.agentRunStore.admitRootTurn({sessionId,turnId:'next',proposedRunId:'next-run',proposedUserMessageId:'next-message',execution:{kind:'goal',goalId:'goal',eventWait:pending.eventWait.provenance},previousRootTurnId:'source',normalizedInput:{text:pending.prompt},sourceMessages:[],admittedAt:50});
        }
      }
      process.stdout.write('committed');
      setInterval(() => {}, 1000);
    `;
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          JSON.stringify({
            root: f.root,
            sessionId: f.sessionId,
            registration: f.registration,
            goal: f.goal,
            window,
          }),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let errors = '';
      child.stderr!.on('data', (chunk) => (errors += String(chunk)));
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve());
        child!.once('exit', (code) => reject(new Error(`child exited ${code}: ${errors}`)));
        child!.once('error', reject);
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      reopened = await f.open();
      const g = (await reopened.goalStore.read(f.sessionId))!.record;
      const w = (await reopened.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))!
        .record;
      assert.equal(w.deadlineAt, 100);
      if (window === 'registered') {
        assert.equal(g.activeEventWait?.settled, false);
        assert.equal(g.currentExecution?.execution.runId, 'source-run');
        assert.equal(g.pendingContinuation, null);
      } else if (window === 'admitted') {
        assert.equal(w.delivery?.kind, 'admitted');
        assert.equal(g.activeEventWait, undefined);
        assert.equal(g.currentExecution?.execution.runId, 'next-run');
        const a = (await reopened.agentRunStore.readRootTurnAdmission(f.sessionId, 'next'))!;
        assert.equal(a.normalizedInput?.text, 'Frozen crash recovery input');
        assert.equal(
          (
            await reopened.agentRunStore.admitRootTurn({
              ...admission(w, pending(w)),
              normalizedInput: a.normalizedInput,
            })
          ).kind,
          'existing',
        );
      } else {
        assert.equal(g.activeEventWait?.settled, true);
        const p = g.pendingContinuation ?? pending(w);
        await reopened.eventWaitStore.queueGoalWait({
          sessionId: f.sessionId,
          waitId: 'wait',
          expectedGoalRevision: 1,
          pending: p,
        });
        assert.equal(
          (await reopened.agentRunStore.admitRootTurn(admission(w, p))).kind,
          'admitted',
        );
        assert.equal(
          (await reopened.agentRunStore.admitRootTurn(admission(w, p))).kind,
          'existing',
        );
      }
    } finally {
      child?.kill('SIGKILL');
      await reopened?.close();
      await f.close();
    }
  });

for (const name of ['SQLite', 'Memory'])
  test(`${name}: budget termination suppresses the wait without a successor`, async () => {
    const f = await fixture(
      name === 'SQLite'
        ? localExecutionPersistenceProvider
        : createMemoryExecutionPersistenceProvider(),
    );
    try {
      await f.stores.eventWaitStore.registerGoalWait(f.registration);
      await resolve(f.stores, f.wait);
      await f.terminate();
      const settled = await f.stores.eventWaitStore.settleGoalWait({
        sessionId: f.sessionId,
        waitId: 'wait',
        expectedGoalRevision: 0,
        goal: { ...f.goal.goal, revision: 1, iterations: 10, status: 'max_iterations' },
      });
      assert.equal(settled.goal.record.activeEventWait, undefined);
      assert.equal(settled.wait.record.delivery?.kind, 'suppressed');
      assert.equal(
        (await f.stores.agentRunStore.listRootTurnAdmissionsForRecovery(f.sessionId)).length,
        1,
      );
    } finally {
      await f.close();
    }
  });

test('SQLite: backup retains the wait linkage; portable copies suppress destination wakes', async () => {
  const f = await fixture(localExecutionPersistenceProvider);
  const target = await fixture(localExecutionPersistenceProvider);
  const artifacts = await mkdtemp(join(tmpdir(), 'maka-wait-portable-'));
  try {
    await f.stores.eventWaitStore.registerGoalWait(f.registration);
    const result = await resolve(f.stores, f.wait);
    await f.terminate();
    await f.settle();
    const p = pending(result);
    await f.stores.eventWaitStore.queueGoalWait({
      sessionId: f.sessionId,
      waitId: 'wait',
      expectedGoalRevision: 1,
      pending: p,
    });
    // An unrelated destination wait must not be cleared by import sanitization.
    await target.stores.eventWaitStore.registerGoalWait(target.registration);
    const before = await f.stores.goalStore.read(f.sessionId);
    await f.stores.close();
    await target.stores.close();
    const backup = join(artifacts, 'backup'),
      restored = join(artifacts, 'restored');
    await createOperationalStateBackup({ stateRoot: f.root, destinationRoot: backup });
    await restoreOperationalStateBackup({ backupRoot: backup, destinationRoot: restored });
    const copy = await localExecutionPersistenceProvider.open({
      rootId: 'copy',
      canonicalPath: restored,
    });
    assert.deepEqual(await copy.goalStore.read(f.sessionId), before);
    assert.equal(
      (await copy.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))?.record.status,
      'resolved',
    );
    await copy.close();
    const configRoot = join(artifacts, 'config'),
      destinationRoot = join(artifacts, 'portable');
    await mkdir(configRoot);
    await exportSessionBundleState({
      stateRoot: f.root,
      configRoot,
      destinationRoot,
      omitEventWaits: true,
      sessionId: f.sessionId,
    });
    const portable = new DatabaseSync(join(destinationRoot, 'runtime.sqlite'), { readOnly: true });
    const record = JSON.parse(
      String(
        portable.prepare('SELECT record_json FROM workflow_goal_authority').get()!.record_json,
      ),
    );
    assert.equal(record.goal.status, 'paused');
    assert.equal(record.activeEventWait, undefined);
    assert.equal(record.pendingContinuation, null);
    assert.equal(portable.prepare('SELECT COUNT(*) AS n FROM workflow_event_waits').get()!.n, 0);
    portable.close();
    // Import also sanitizes an older bundle that still carries the linkage.
    const legacy = new DatabaseSync(join(destinationRoot, 'runtime.sqlite'));
    legacy
      .prepare('UPDATE workflow_goal_authority SET goal_revision = ?, status = ?, record_json = ?')
      .run(
        before!.record.goal.revision,
        before!.record.goal.status,
        JSON.stringify(before!.record),
      );
    legacy.close();
    await importSessionBundleState({ stateRoot: target.root, bundleStateRoot: destinationRoot });
    const imported = await target.open();
    assert.equal((await imported.goalStore.read(f.sessionId))!.record.goal.status, 'paused');
    assert.equal(
      (await imported.goalStore.read(target.sessionId))!.record.activeEventWait?.waitId,
      'wait',
    );
    await imported.close();
  } finally {
    await target.close();
    await f.close();
    await rm(artifacts, { recursive: true, force: true });
  }
});

async function handoffSource(f: Awaited<ReturnType<typeof fixture>>, startSuccessor = true) {
  const runtime = f.stores.runtimeEventStore;
  const opening: RuntimeEventInvocationOpenedContent = {
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
      cwd: f.root,
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      toolMode: 'direct',
    },
    root: { kind: 'user' },
    source: { kind: 'fresh' },
  };
  const identity = {
    sessionId: f.sessionId,
    turnId: 'source',
    runId: 'source-run',
    invocationId: 'source-run',
  };
  await runtime.appendRuntimeEvent(
    f.sessionId,
    identity.runId,
    buildInvocationOpenedEvent({ run: identity, id: 'opening', openedAt: 1, opening }),
  );
  const target = { ...identity, runId: 'physical-successor', invocationId: 'physical-successor' };
  await runtime.appendRuntimeEvent(f.sessionId, identity.runId, {
    ...identity,
    id: 'seal',
    ts: 2,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      endInvocation: true,
      handoffPause: {
        protocol: 'runtime_handoff_pause_v1',
        handoffId: 'handoff',
        hostEpoch: 'old-host',
        rootRunId: identity.runId,
        successorRunId: target.runId,
        successorInvocationId: target.invocationId,
        claimId: 'handoff-claim',
        remainingSteps: 2,
      },
    },
  });
  const segment = runtimePrefixSegment(await runtime.readImmutableRuntimePrefix(identity));
  const boundary = createRuntimeBoundaryCursor([segment]);
  const claim: ContinuationClaimV1 = {
    protocol: 'continuation_claim_v1',
    claimId: 'handoff-claim',
    boundaryDigest: boundary.manifestDigest,
    boundary,
    providerProjectionVersion: 1,
    providerReplayDigest: `sha256:${'a'.repeat(64)}`,
    target,
    claimedAt: 3,
    targetOpening: {
      ...opening,
      source: {
        kind: 'handoff',
        rootRunId: identity.runId,
        sourceInvocationId: identity.invocationId,
        sourceRunId: identity.runId,
        sourceTurnId: identity.turnId,
        sourceRuntimeEventHighWater: segment.position.lastEventSeq,
        claimId: 'handoff-claim',
        boundaryDigest: boundary.manifestDigest,
      },
    },
  };
  await runtime.claimContinuation({ claim });
  if (!startSuccessor) return target;
  const event: RuntimeEvent = {
    ...target,
    id: 'successor-opening',
    ts: 4,
    partial: false,
    role: 'system',
    author: 'system',
    modelVisibility: 'hidden',
    content: claim.targetOpening,
    actions: {
      continuationStart: {
        protocol: 'continuation_start_v2',
        provenance: 'runtime_admission',
        claimId: claim.claimId,
        boundaryDigest: claim.boundaryDigest,
        immediateSource: {
          ...segment.identity,
          highWater: segment.position.lastEventSeq,
          prefixDigest: segment.prefixDigest,
        },
        replayManifestDigest: boundary.manifestDigest,
        providerProjectionVersion: claim.providerProjectionVersion,
        providerReplayDigest: claim.providerReplayDigest,
      },
    },
  };
  await runtime.commitContinuationStart({ claim, event });
  return target;
}

for (const name of ['SQLite', 'Memory']) {
  for (const state of [
    'pending_handoff',
    'running_handoff',
    'completed_handoff',
    'settled_handoff',
    'superseded_handoff',
    'failed_handoff',
    'cancelled_handoff',
    'aborted_handoff',
  ] as const)
    test(`${name}: registration replaces only a completed previous logical execution (${state})`, async () => {
      let fail = false;
      const f = await fixture(
        name === 'SQLite'
          ? localExecutionPersistenceProvider
          : createMemoryExecutionPersistenceProvider({
              beforeCommit(op) {
                if (fail && op === 'eventWait.registerGoal')
                  throw new Error('injected takeover failure');
              },
            }),
      );
      let db: DatabaseSync | undefined;
      try {
        const stale = state === 'settled_handoff' || state === 'superseded_handoff';
        const oldGoal = stale
          ? { ...f.goal.goal, revision: 1, iterations: 1, tokensNow: 12 }
          : f.goal.goal;
        const lease =
          state === 'superseded_handoff'
            ? { ...f.goal.controlLease, generation: f.goal.controlLease.generation + 1 }
            : f.goal.controlLease;
        const tip = await handoffSource(f, state !== 'pending_handoff');
        if (state !== 'pending_handoff' && state !== 'running_handoff')
          await f.stores.runtimeEventStore.appendRuntimeEvent(f.sessionId, tip.runId, {
            ...tip,
            id: 'old-terminal',
            ts: 5,
            partial: false,
            role: 'system',
            author: 'system',
            status:
              state === 'completed_handoff' || stale
                ? 'completed'
                : state === 'failed_handoff'
                  ? 'failed'
                  : state === 'cancelled_handoff'
                    ? 'cancelled'
                    : 'aborted',
            actions: { endInvocation: true },
          });
        await f.stores.goalStore.commit({
          sessionId: f.sessionId,
          expectedAuthorityRevision: 0,
          record: {
            ...f.goal,
            goal: oldGoal,
            controlLease: lease,
            currentExecution: {
              execution: f.registration.sourceExecution,
              checkpoint: { goalId: 'goal', revision: state === 'superseded_handoff' ? 1 : 0 },
              controlLease: f.goal.controlLease,
            },
          },
        });
        await f.stores.agentRunStore.admitRootTurn({
          sessionId: f.sessionId,
          turnId: 'new-source',
          proposedRunId: 'new-source-run',
          proposedUserMessageId: 'new-source-message',
          execution: { kind: 'external_message' },
          previousRootTurnId: 'source',
          normalizedInput: { text: 'new work' },
          sourceMessages: [],
          admittedAt: 6,
        });
        const request = {
          ...f.registration,
          record: { ...f.wait, sourceTurnId: 'new-source', goalControlLease: lease },
          expectedGoalRevision: oldGoal.revision,
          sourceExecution: {
            sessionId: f.sessionId,
            turnId: 'new-source',
            runId: 'new-source-run',
          },
          previousTurnSettlement: stale
            ? undefined
            : {
                execution: f.registration.sourceExecution,
                goal: { ...f.goal.goal, revision: 1, iterations: 1, tokensNow: 12 },
              },
        };
        const before = await f.stores.goalStore.read(f.sessionId);
        if (state === 'completed_handoff' || stale) {
          if (request.previousTurnSettlement) {
            await assert.rejects(
              async () =>
                f.stores.eventWaitStore.registerGoalWait({
                  ...request,
                  previousTurnSettlement: undefined,
                }),
              /settlement does not match/,
            );
            await assert.rejects(
              async () =>
                f.stores.eventWaitStore.registerGoalWait({
                  ...request,
                  previousTurnSettlement: {
                    ...request.previousTurnSettlement!,
                    execution: request.sourceExecution,
                  },
                }),
              /settlement does not match/,
            );
          }
          assert.deepEqual(await f.stores.goalStore.read(f.sessionId), before);
          if (name === 'SQLite') {
            db = new DatabaseSync(join(f.root, 'runtime.sqlite'));
            db.exec(
              "CREATE TRIGGER fail_takeover BEFORE UPDATE ON workflow_goal_authority BEGIN SELECT RAISE(ABORT, 'injected takeover failure'); END",
            );
          }
          fail = true;
          await assert.rejects(
            async () => f.stores.eventWaitStore.registerGoalWait(request),
            /injected takeover failure/,
          );
          assert.deepEqual(await f.stores.goalStore.read(f.sessionId), before);
          assert.equal(
            await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }),
            null,
          );
          fail = false;
          db?.exec('DROP TRIGGER fail_takeover');
          const registered = await f.stores.eventWaitStore.registerGoalWait(request);
          assert.deepEqual(
            registered.goal.record.currentExecution?.execution,
            request.sourceExecution,
          );
          assert.deepEqual(
            registered.goal.record.goal,
            request.previousTurnSettlement?.goal ?? oldGoal,
          );
          assert.deepEqual(await f.stores.eventWaitStore.registerGoalWait(request), registered);
        } else {
          await assert.rejects(
            async () => f.stores.eventWaitStore.registerGoalWait(request),
            /source execution/i,
          );
          assert.deepEqual(await f.stores.goalStore.read(f.sessionId), before);
          assert.equal(
            await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }),
            null,
          );
        }
      } finally {
        db?.close();
        await f.close();
      }
    });
  for (const tracked of [false, true])
    test(`${name}: handoff wait preserves ${tracked ? 'tracked' : 'observed'} logical ownership and physical yield proof`, async () => {
      const f = await fixture(
        name === 'SQLite'
          ? localExecutionPersistenceProvider
          : createMemoryExecutionPersistenceProvider(),
      );
      try {
        const physical = await handoffSource(f);
        if (tracked)
          await f.stores.goalStore.commit({
            sessionId: f.sessionId,
            expectedAuthorityRevision: 0,
            record: {
              ...f.goal,
              currentExecution: {
                execution: f.registration.sourceExecution,
                checkpoint: { goalId: 'goal', revision: 0 },
                controlLease: f.goal.controlLease,
              },
            },
          });
        // An unrelated physical Run cannot register.
        await assert.rejects(
          async () =>
            f.stores.eventWaitStore.registerGoalWait({
              ...f.registration,
              sourceExecution: { ...f.registration.sourceExecution, runId: 'foreign-run' },
            }),
          /source execution/i,
        );
        const registration = {
          ...f.registration,
          sourceExecution: { sessionId: f.sessionId, turnId: 'source', runId: physical.runId },
        };
        const registered = await f.stores.eventWaitStore.registerGoalWait(registration);
        assert.deepEqual(
          registered.goal.record.currentExecution?.execution,
          f.registration.sourceExecution,
        );
        assert.deepEqual(
          registered.goal.record.activeEventWait?.sourceExecution,
          registration.sourceExecution,
        );
        assert.deepEqual(await f.stores.eventWaitStore.registerGoalWait(registration), registered);
        await assert.rejects(async () => f.settle(), /no durable event-wait yield/);
        await f.stores.runtimeEventStore.appendRuntimeEvent(f.sessionId, physical.runId, {
          ...physical,
          id: 'physical-terminal',
          ts: 30,
          partial: false,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true, stateDelta: { stopReason: 'event_wait' } },
        });
        // Lost acknowledgement retry remains valid after the physical source ended.
        assert.deepEqual(await f.stores.eventWaitStore.registerGoalWait(registration), registered);
        await f.settle();
        const result = await resolve(f.stores, f.wait);
        const p = pending(result);
        await f.stores.eventWaitStore.queueGoalWait({
          sessionId: f.sessionId,
          waitId: 'wait',
          expectedGoalRevision: 1,
          pending: p,
        });
        await f.stores.agentRunStore.admitRootTurn(admission(result, p));
        assert.equal(
          (await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }))?.record
            .delivery?.kind,
          'admitted',
        );
        assert.equal(
          (await f.stores.goalStore.read(f.sessionId))?.record.currentExecution?.execution.runId,
          'next-run',
        );
      } finally {
        await f.close();
      }
    });
}

for (const name of ['SQLite', 'Memory'])
  test(`${name}: a sealed handoff predecessor cannot create a wait`, async () => {
    const f = await fixture(
      name === 'SQLite'
        ? localExecutionPersistenceProvider
        : createMemoryExecutionPersistenceProvider(),
    );
    try {
      await handoffSource(f);
      await assert.rejects(
        async () => f.stores.eventWaitStore.registerGoalWait(f.registration),
        /Source already ended/,
      );
      assert.equal(
        await f.stores.eventWaitStore.read({ sessionId: f.sessionId, waitId: 'wait' }),
        null,
      );
    } finally {
      await f.close();
    }
  });
