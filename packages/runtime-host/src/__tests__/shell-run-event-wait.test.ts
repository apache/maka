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
import type { EventWaitRecord } from '@maka/core/event-wait';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { SHELL_RUN_STATUSES, type ShellRunRecord } from '@maka/core/shell-run';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { testInvocationRecord } from '@maka/runtime/test-only/invocation-fixture';
import {
  ShellRunEventWaitAccess,
  validateShellRunWait,
} from '../server/shell-run-event-wait-access.js';
import { eventWaitContinuationPrompt } from '../server/goal-event-waits.js';
import { ShellRunEventWaitAdapter } from '../server/shell-run-event-wait-adapter.js';

function fixture() {
  const ref = 'maka://runtime/background-tasks/task';
  const task: ShellRunRecord = {
    sessionId: 'session',
    shellRunId: 'task',
    sourceRunId: 'source-run',
    sourceTurnId: 'earlier-turn',
    sourceToolCallId: 'bash-call',
    cwd: '/tmp',
    command: 'secret-command',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 0,
    output: {
      mode: 'pipes',
      stdout: 'secret-output',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
  const wait: EventWaitRecord = {
    schemaVersion: 1,
    sessionId: 'session',
    waitId: 'wait',
    goalControlLease: { goalId: 'goal', generation: 1 },
    sourceTurnId: 'later-turn',
    sourceToolCallId: 'wait-call',
    resource: {
      providerId: 'shell_run',
      resourceType: 'background_task',
      connectionId: null,
      resourceId: ref,
    },
    condition: { typeId: 'terminal', version: 1, parameters: {} },
    deliveryKey: 'wait-delivery',
    createdAt: 2,
    updatedAt: 2,
    deadlineAt: 10000,
    status: 'waiting',
  };
  const invocation = testInvocationRecord({
    sessionId: 'session',
    runId: 'source-run',
    turnId: 'earlier-turn',
    opening: {
      route: {
        provenance: 'runtime',
        backendKind: 'ai-sdk',
        llmConnectionId: 'conn',
        llmConnectionSlug: 'test',
        modelId: 'test',
      },
    },
  });
  const identity = {
    sessionId: 'session',
    runId: 'source-run',
    invocationId: 'source-run',
    turnId: 'earlier-turn',
    ts: 1,
    partial: false,
  };
  const args = { command: 'secret-command', run_in_background: true };
  const events: RuntimeEvent[] = [
    {
      ...identity,
      id: 'call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'bash-call', name: 'Bash', args },
    },
    {
      ...identity,
      id: 't1',
      role: 'system',
      author: 'system',
      refs: { operationId: 'op', toolCallId: 'bash-call' },
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1',
          operationId: 'op',
          providerToolCallId: 'bash-call',
          toolName: 'Bash',
          canonicalArgsHash: canonicalToolArgsHash('Bash', args),
          recoveryMode: 'never_auto_retry',
        },
      },
    },
    {
      ...identity,
      id: 't2',
      role: 'tool',
      author: 'tool',
      refs: { operationId: 'op', toolCallId: 'bash-call' },
      content: {
        kind: 'function_response',
        id: 'bash-call',
        name: 'Bash',
        result: { kind: 'shell_run', ref },
        isError: true,
      },
    },
  ];
  const shellStore = { readShellRun: async () => task };
  const eventStore = {
    readRunInvocation: async () => invocation,
    readToolProvenanceEvents: async () => ({
      status: 'complete' as const,
      records: events,
      storedBytes: 1000,
      sourceRecordCount: events.length,
    }),
  };
  const access = new ShellRunEventWaitAccess(shellStore, eventStore);
  const adapter = new ShellRunEventWaitAdapter(access, {
    subscribeChanges: () => ({ close() {} }),
  });
  const read = () =>
    adapter.read({ wait, cursor: null, access: null, signal: new AbortController().signal });
  return { task, wait, invocation, events, shellStore, eventStore, access, adapter, read };
}

test('same-Session earlier-Turn background Bash, including error T2 and Code Mode creation, is eligible', async () => {
  const f = fixture();
  assert.equal((await f.access.authorize(f.wait, new AbortController().signal)).kind, 'allowed');
  f.invocation.opening.configuration.toolMode = 'code_mode';
  assert.equal((await f.access.authorize(f.wait, new AbortController().signal)).kind, 'allowed');
});

for (const status of SHELL_RUN_STATUSES)
  test(`ShellRun persisted status ${status}`, async () => {
    const f = fixture();
    f.task.status = status;
    assert.equal(
      (await f.read()).kind,
      status === 'starting' || status === 'running'
        ? 'pending'
        : status === 'orphaned'
          ? 'source_unavailable'
          : 'satisfied',
    );
  });

test('terminal receipts ignore observations, output, revision and read time', async () => {
  const f = fixture();
  Object.assign(f.task, { status: 'failed', completedAt: 9, exitCode: 7 });
  const first = await f.read();
  Object.assign(f.task, { revision: 100, observedAt: 500, updatedAt: 500 });
  f.task.output = { ...f.task.output, stdout: 'different output' } as ShellRunRecord['output'];
  assert.deepEqual(await f.read(), first);
  assert.ok(!JSON.stringify(first).includes('secret'));
  f.task.exitCode = 8;
  assert.notDeepEqual(await f.read(), first);
});

for (const mutation of [
  'user',
  'cross-session',
  'no-run',
  'wrong-turn',
  'plugin-route',
  'missing-call',
  'missing-t1',
  'missing-result',
  'foreground',
  'wrong-result',
  'wrong-hash',
  'wrong-operation',
  'provider-executed',
] as const)
  test(`untrusted ShellRun denied: ${mutation}`, async () => {
    const f = fixture();
    if (mutation === 'user') f.task.visibility = 'user';
    if (mutation === 'cross-session') f.task.sessionId = 'another';
    if (mutation === 'no-run') delete f.task.sourceRunId;
    if (mutation === 'wrong-turn') f.task.sourceTurnId = 'other';
    if (mutation === 'plugin-route')
      f.invocation.opening.route = {
        ...f.invocation.opening.route,
        backendKind: 'plugin-executor',
      } as typeof f.invocation.opening.route;
    if (mutation === 'missing-call') f.events.splice(0, 1);
    if (mutation === 'missing-t1') f.events.splice(1, 1);
    if (mutation === 'missing-result') f.events.splice(2, 1);
    const call = f.events[0]?.content;
    if (mutation === 'foreground' && call?.kind === 'function_call')
      call.args = { command: 'secret-command' };
    if (mutation === 'provider-executed' && call?.kind === 'function_call')
      call.providerExecuted = true;
    const result = f.events[2]?.content;
    if (mutation === 'wrong-result' && result?.kind === 'function_response')
      result.result = { kind: 'shell_run', ref: 'maka://runtime/background-tasks/other' };
    if (mutation === 'wrong-hash')
      f.events[1]!.actions!.toolDispatch!.canonicalArgsHash = `sha256:${'0'.repeat(64)}`;
    if (mutation === 'wrong-operation') f.events[2]!.refs!.operationId = 'other';
    const denied = await f.access.authorize(f.wait, new AbortController().signal);
    assert.equal(denied.kind, 'revoked');
    assert.ok(!JSON.stringify(denied).includes('secret'));
  });

for (const ref of [
  'task',
  'maka://runtime/background-tasks/task?x=1',
  'maka://runtime/background-tasks/task#x',
  'maka://runtime/background-tasks/%74ask',
  'maka://runtime/terminals/task',
])
  test(`reject noncanonical ref ${ref}`, () => {
    const f = fixture();
    Object.assign(f.wait.resource, { resourceId: ref });
    assert.throws(() => validateShellRunWait(f.wait));
  });

test('rejects connection, condition version and parameters', () => {
  for (const change of [
    { connectionId: 'remote' },
    { version: 2 },
    { parameters: { script: 'true' } },
  ]) {
    const f = fixture();
    Object.assign('connectionId' in change ? f.wait.resource : f.wait.condition, change);
    assert.throws(() => f.adapter.validate(f.wait));
  }
});

test('missing is revoked, transient reads throw for manager unknown handling, and proof await rechecks visibility', async () => {
  const f = fixture();
  f.shellStore.readShellRun = async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.deepEqual(await f.access.authorize(f.wait, new AbortController().signal), {
    kind: 'revoked',
    reason: 'shell_run_missing',
  });
  f.shellStore.readShellRun = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(() => f.read(), /storage unavailable/);
  let reads = 0;
  f.shellStore.readShellRun = async () => ({
    ...f.task,
    visibility: ++reads === 1 ? 'model' : 'user',
  });
  assert.deepEqual(await f.access.authorize(f.wait, new AbortController().signal), {
    kind: 'revoked',
    reason: 'shell_run_access_revoked',
  });
});

test('continuation context stays bounded after JSON escaping without losing normal references', () => {
  const f = fixture();
  const normal = eventWaitContinuationPrompt(
    { ...f.wait, status: 'expired', expiredAt: 10000 },
    'Inspect task output',
  );
  assert.ok(normal.includes(f.wait.resource.resourceId));
  const large = eventWaitContinuationPrompt(
    {
      ...f.wait,
      resource: { ...f.wait.resource, resourceId: '\u0000'.repeat(2048) },
      status: 'expired',
      expiredAt: 10000,
    },
    '\u0000'.repeat(500),
  );
  assert.ok(large.length <= 4000);
  assert.ok(Buffer.byteLength(large) <= 12000);
  assert.ok(large.includes('"contextTruncated":true'));
});
