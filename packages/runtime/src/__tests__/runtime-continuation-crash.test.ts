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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import {
  buildInvocationOpenedEvent,
  runtimeInvocationOutcome,
} from '@maka/core/runtime-invocation';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';

import { type RuntimeContinuationFailpoint } from '../agent-run.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { FakeBackend } from '../test-only/fake-backend.js';
import { terminateChildProcessTree } from '../process-tree-terminator.js';
import { testInvocationOpening } from './invocation-fixture.js';

const CRASH_CHILD_ENV = 'MAKA_RUNTIME_CONTINUATION_CRASH_CHILD';
const CRASH_CHILD_READY_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 10_000;
const CRASH_HARNESS_TIMEOUT_MS = process.platform === 'win32' ? 180_000 : 60_000;
const FAILPOINTS: readonly RuntimeContinuationFailpoint[] = [
  'after_continuation_claim_committed',
  'after_continuation_start_committed',
  'after_terminal_event_committed',
];

if (process.env[CRASH_CHILD_ENV] === '1') {
  await runCrashChild();
} else {
  describe('runtime resume phase 1 process crash harness', () => {
    test('reopens and repairs every committed continuation prefix after SIGKILL', {
      timeout: CRASH_HARNESS_TIMEOUT_MS,
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-runtime-continuation-crash-'));
      try {
        for (const failpoint of FAILPOINTS) {
          const workspaceRoot = join(root, failpoint);
          await crashContinuationAt(workspaceRoot, failpoint);

          const store = createSessionStore(workspaceRoot);
          const runStore = createSqliteAgentRunStore(workspaceRoot);
          const runtimeEventStore = createCrashRuntimeStore(workspaceRoot);
          const [session] = await store.list();
          assert.ok(session, `${failpoint} did not persist a session`);
          const [claimState] = await runtimeEventStore.listContinuationClaimsForRecovery(
            session.id,
          );
          assert.ok(claimState, `${failpoint} did not persist the continuation claim`);
          const invocationsBeforeRecovery = await runtimeEventStore.listSessionInvocations(
            session.id,
          );
          const continuation = invocationsBeforeRecovery.find(
            (invocation) => invocation.runId === claimState.claim.target.runId,
          );
          const prefix = await runtimeEventStore.readRuntimeEvents(
            session.id,
            claimState.claim.target.runId,
          );
          assertPrefix(failpoint, continuation, prefix);

          runtimeEventStore.close();
          await store.close?.();
          const {
            manager,
            agentRunStore: recoveryAgentRunStore,
            runtimeEventStore: recoveryRuntimeStore,
            sessionStore: recoverySessionStore,
          } = createManager(workspaceRoot);
          const repeatedPlan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
            sourceRunId: 'source-run',
          });
          assert.equal(repeatedPlan.disposition, 'park');
          // A crash after the terminal event is not an unfinished claim: the
          // event is the continuation's ending, so the boundary already has one.
          assert.deepEqual(repeatedPlan.rejectionReasons, [
            failpoint === 'after_continuation_claim_committed'
              ? 'continuation_claim_repair_required'
              : failpoint === 'after_continuation_start_committed'
                ? 'continuation_started_indeterminate'
                : 'continuation_already_exists',
          ]);

          await manager.recoverInterruptedSessions();
          const repaired = await readInvocation(
            recoveryRuntimeStore,
            session.id,
            claimState.claim.target.runId,
          );
          const repairedEvents = await recoveryRuntimeStore.readRuntimeEvents(
            session.id,
            claimState.claim.target.runId,
          );
          const terminalEvents = repairedEvents.filter(
            (event) => event.actions?.endInvocation === true,
          );
          if (failpoint === 'after_continuation_start_committed') {
            assert.equal(terminalEvents.length, 0);
            assert.equal(runtimeInvocationOutcome(repaired), undefined);
            const parked = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
              sourceRunId: 'source-run',
            });
            assert.deepEqual(parked.rejectionReasons, ['continuation_started_indeterminate']);
          } else {
            assert.equal(terminalEvents.length, 1, `${failpoint} must recover one terminal fact`);
            assert.ok(
              runtimeInvocationOutcome(repaired),
              `${failpoint} left the continuation non-terminal`,
            );
          }
          recoveryAgentRunStore.close?.();
          runStore.close?.();
          recoveryRuntimeStore.close();
          await recoverySessionStore.close?.();
        }
      } finally {
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 20 : 0,
          retryDelay: 100,
        });
      }
    });
  });
}

async function runCrashChild(): Promise<void> {
  const workspaceRoot = requiredEnv('MAKA_RUNTIME_CONTINUATION_WORKSPACE');
  const failpoint = requiredEnv(
    'MAKA_RUNTIME_CONTINUATION_FAILPOINT',
  ) as RuntimeContinuationFailpoint;
  const store = createSessionStore(workspaceRoot);
  const runStore = createSqliteAgentRunStore(workspaceRoot);
  const runtimeEventStore = createCrashRuntimeStore(workspaceRoot);
  const backends = new BackendRegistry();
  backends.register(
    'ai-sdk',
    (ctx) =>
      new FakeBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        store: ctx.store,
        appendMessage: ctx.appendMessage,
      }),
  );
  let id = 0;
  let resolveSelectedFailpoint!: () => void;
  const selectedFailpointReached = new Promise<void>((resolve) => {
    resolveSelectedFailpoint = resolve;
  });
  // A pending Promise does not keep Node alive. Terminal header finalization is
  // deliberately detached from the public stream, so keep the crash child
  // alive while that background durability work advances to its failpoint.
  setInterval(() => {}, 1_000);
  const manager = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    backends,
    safeBoundaryResumeEnabled: true,
    inspectContinuationSafety: async () => stableSafetyObservation(),
    continuationFailpoint: async (point) => {
      if (point !== failpoint) return;
      await suspendCrashChild(point, resolveSelectedFailpoint);
    },
    newId: () => `id-${++id}`,
    now: (() => {
      let ts = 10;
      return () => ++ts;
    })(),
  });
  const session = await manager.createSession({
    cwd: workspaceRoot,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'continuation crash child',
  });
  for (const event of sourceEvents(session.id, workspaceRoot)) {
    await runtimeEventStore.appendRuntimeEvent(session.id, 'source-run', event);
  }
  const plan = await manager.planAuthoritativeSafeBoundaryContinuation(session.id, {
    sourceRunId: 'source-run',
  });
  if (!plan.continuation)
    throw new Error(`expected continuation: ${plan.rejectionReasons.join(',')}`);
  for await (const _event of manager.resumeSafeBoundaryContinuation(plan.continuation)) {
    // drain until the selected failpoint suspends the child
  }
  // Terminal projection finalization may continue after the public event stream
  // closes. Wait for the selected durable boundary instead of racing that
  // background finalizer and reporting a false negative.
  await selectedFailpointReached;
  await new Promise<never>(() => {
    setInterval(() => {}, 1_000);
  });
}

async function suspendCrashChild(
  point: RuntimeContinuationFailpoint,
  markReached: () => void,
): Promise<never> {
  process.stdout.write(`READY:${point}\n`);
  markReached();
  return await new Promise<never>(() => {
    setInterval(() => {}, 1_000);
  });
}

function createManager(workspaceRoot: string): {
  manager: SessionManager;
  agentRunStore: ReturnType<typeof createSqliteAgentRunStore>;
  runtimeEventStore: ReturnType<typeof createSqliteRuntimeStore>;
  sessionStore: ReturnType<typeof createSessionStore>;
} {
  const store = createSessionStore(workspaceRoot);
  const runStore = createSqliteAgentRunStore(workspaceRoot);
  const runtimeEventStore = createCrashRuntimeStore(workspaceRoot);
  const backends = new BackendRegistry();
  backends.register(
    'ai-sdk',
    (ctx) =>
      new FakeBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        store: ctx.store,
        appendMessage: ctx.appendMessage,
      }),
  );
  let id = 100;
  return {
    agentRunStore: runStore,
    runtimeEventStore,
    sessionStore: store,
    manager: new SessionManager({
      store,
      runStore,
      runtimeEventStore,
      backends,
      safeBoundaryResumeEnabled: true,
      inspectContinuationSafety: async () => stableSafetyObservation(),
      newId: () => `recovery-id-${++id}`,
      now: Date.now,
    }),
  };
}

function createCrashRuntimeStore(workspaceRoot: string) {
  return createSqliteRuntimeStore(join(workspaceRoot, '.maka', 'runtime.sqlite'));
}

async function crashContinuationAt(
  workspaceRoot: string,
  failpoint: RuntimeContinuationFailpoint,
): Promise<void> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      [CRASH_CHILD_ENV]: '1',
      MAKA_RUNTIME_CONTINUATION_WORKSPACE: workspaceRoot,
      MAKA_RUNTIME_CONTINUATION_FAILPOINT: failpoint,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  // `exit` may fire before Windows releases inherited stdio/process handles.
  // Wait for `close` so the following reopen and recursive cleanup cannot race
  // a dead child that still owns the SQLite files.
  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + CRASH_CHILD_READY_TIMEOUT_MS;
  while (
    !stdout.includes(`READY:${failpoint}\n`) &&
    child.exitCode === null &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!stdout.includes(`READY:${failpoint}\n`)) {
    await killCrashChild(child);
    await closed;
    throw new Error(`${failpoint} child did not reach boundary: ${stderr || stdout}`);
  }
  assert.equal(await killCrashChild(child), true);
  const [exitCode, signal] = await closed;
  assert.ok(exitCode !== 0 || signal !== null);
}

function killCrashChild(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (process.platform === 'win32') return terminateChildProcessTree(child, 'SIGKILL');
  return Promise.resolve(child.kill('SIGKILL'));
}

/** The one invocation that opened this run, once its ledger says it opened. */
async function readInvocation(
  runtimeEventStore: ReturnType<typeof createSqliteRuntimeStore>,
  sessionId: string,
  runId: string,
): Promise<RuntimeInvocationRecord> {
  const found = (await runtimeEventStore.listSessionInvocations(sessionId)).find(
    (invocation) => invocation.runId === runId,
  );
  if (!found) throw new Error(`Runtime invocation not found: ${runId}`);
  return found;
}

/**
 * What a crash at each boundary left durable.
 *
 * A continuation's opening fact rides its continuation-start event, so a crash
 * before that commit leaves the target invocation unopened. There is no separate
 * run record left over to disagree with the ledger.
 */
function assertPrefix(
  failpoint: RuntimeContinuationFailpoint,
  invocation: RuntimeInvocationRecord | undefined,
  events: readonly RuntimeEvent[],
): void {
  if (failpoint === 'after_continuation_claim_committed') {
    assert.equal(invocation, undefined);
    assert.deepEqual(events, []);
    return;
  }
  assert.ok(invocation);
  assert.equal(events[0]?.actions?.continuationStart?.protocol, 'continuation_start_v2');
  if (failpoint === 'after_continuation_start_committed') {
    assert.equal(runtimeInvocationOutcome(invocation), undefined);
    assert.equal(
      events.some((event) => event.actions?.endInvocation === true),
      false,
    );
    return;
  }
  assert.equal(events.filter((event) => event.actions?.endInvocation === true).length, 1);
  assert.ok(runtimeInvocationOutcome(invocation));
}

function sourceEvents(sessionId: string, cwd: string): RuntimeEvent[] {
  const identity = {
    sessionId,
    invocationId: 'source-invocation',
    runId: 'source-run',
    turnId: 'source-turn',
  };
  return [
    buildInvocationOpenedEvent({
      id: 'source-open',
      run: identity,
      openedAt: 1,
      opening: testInvocationOpening({
        route: {
          provenance: 'runtime',
          backendKind: 'fake',
          llmConnectionId: 'fake-connection',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
        },
        configuration: {
          cwd,
          workspaceIdentity: 'workspace-1',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          toolMode: 'direct',
        },
      }),
    }),
    {
      ...identity,
      id: 'source-user',
      ts: 1,
      partial: false,
      author: 'user',
      role: 'user',
      content: { kind: 'text', text: 'continue after crash' },
    },
    {
      ...identity,
      id: 'source-terminal',
      ts: 2,
      partial: false,
      author: 'system',
      role: 'system',
      status: 'failed',
      actions: { endInvocation: true, stateDelta: { failureClass: 'app_restarted' } },
    },
  ];
}

function stableSafetyObservation() {
  return {
    workspaceIdentity: 'workspace-1',
    backgroundOperationsSettled: true,
    availableToolNames: [] as string[],
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
