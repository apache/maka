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
import {
  buildImmutableRuntimePrefix,
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
} from '@maka/core/runtime-boundary';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RunnableAgentFlow } from '../agent-flow.js';
import { buildContinuationReplayPlan } from '../continuation-replay.js';
import { createRuntimeContinuationStartAdmissionProof } from '../runtime-continuation-admission.js';
import {
  issueRuntimeContinuationAdmissionReceipt,
  runAdmittedRuntimeContinuation,
  RuntimeRunner,
  type RuntimeContinuationAdmissionReceipt,
} from '../runtime-runner.js';
import type { RuntimeContinuation } from '../runtime-resume.js';

const sourceEvent: RuntimeEvent = {
  id: 'source-user',
  sessionId: 'session-1',
  invocationId: 'source-invocation',
  runId: 'source-run',
  turnId: 'source-turn',
  ts: 1,
  partial: false,
  role: 'user',
  author: 'user',
  content: { kind: 'text', text: 'continue this task' },
};

function continuation(): RuntimeContinuation {
  const prefix = buildImmutableRuntimePrefix(
    {
      sessionId: sourceEvent.sessionId,
      invocationId: sourceEvent.invocationId,
      runId: sourceEvent.runId,
      turnId: sourceEvent.turnId,
    },
    [{ eventSeq: 1, event: sourceEvent }],
  );
  const replay = buildContinuationReplayPlan({
    prefixes: [prefix],
    providerProjectionVersion: 1,
  });
  if (replay.kind !== 'replayable') throw new Error('test continuation must be replayable');
  return {
    sessionId: 'session-1',
    invocationId: 'target-invocation',
    runId: 'target-run',
    turnId: 'target-turn',
    sourceInvocationId: 'source-invocation',
    sourceRunId: 'source-run',
    sourceTurnId: 'source-turn',
    sourceRuntimeEventHighWater: 1,
    claimId: 'claim-1',
    runtimeContext: [sourceEvent],
    boundary: createRuntimeBoundaryCursor([runtimePrefixSegment(prefix)]),
    providerProjectionVersion: 1,
    providerReplayDigest: replay.plan.providerReplayDigest,
    safetySnapshot: {
      workspaceIdentity: 'workspace-1',
      backgroundOperationsSettled: true,
      availableToolNames: [],
    },
  };
}

test('public run rejects continuation metadata before flow dispatch', async () => {
  let flowDispatched = false;
  const flow: RunnableAgentFlow = {
    async *run() {
      flowDispatched = true;
    },
  };
  const runner = new RuntimeRunner({ flow });

  await assert.rejects(
    runner.run({
      sessionId: 'session-1',
      invocationId: 'target-invocation',
      runId: 'target-run',
      turnId: 'target-turn',
      text: '',
      runtimeContext: [sourceEvent],
      continuation: {
        sourceInvocationId: 'source-invocation',
        sourceRunId: 'source-run',
        sourceTurnId: 'source-turn',
        sourceRuntimeEventHighWater: 1,
      },
      source: 'test',
    }),
    /package-internal durable admission/,
  );
  assert.equal(flowDispatched, false);
});

test('public resume rejects continuation dispatch before calling the flow', async () => {
  let flowDispatched = false;
  const flow: RunnableAgentFlow = {
    async *run() {
      flowDispatched = true;
    },
  };
  const runner = new RuntimeRunner({ flow });

  await assert.rejects(
    runner.resume(continuation(), { source: 'test' }),
    /package-internal durable admission/,
  );
  assert.equal(flowDispatched, false);
});

test('package-internal admission dispatches a continuation without inventing a user event', async () => {
  const flow: RunnableAgentFlow = {
    async *run(context) {
      yield {
        id: 'continued-text',
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        runId: context.runId,
        turnId: context.turnId,
        ts: 2,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'continued' },
      };
      yield {
        id: 'continued-terminal',
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        runId: context.runId,
        turnId: context.turnId,
        ts: 3,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      };
    },
  };
  const runner = new RuntimeRunner({ flow });

  const receipt = issueRuntimeContinuationAdmissionReceipt(
    runner,
    continuation(),
    startAdmissionFor(continuation(), 'happy-start'),
  );
  const result = await runAdmittedRuntimeContinuation(runner, receipt, { source: 'test' });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalOutput, 'continued');
  assert.deepEqual(
    result.events.map((event) => event.id),
    ['continued-text', 'continued-terminal'],
  );
});

test('continuation admission receipt is one-shot and runner-bound', async () => {
  let dispatches = 0;
  const flow: RunnableAgentFlow = {
    async *run(context) {
      dispatches += 1;
      yield {
        id: `terminal-${dispatches}`,
        sessionId: context.sessionId,
        invocationId: context.invocationId,
        runId: context.runId,
        turnId: context.turnId,
        ts: 2,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      };
    },
  };
  const runner = new RuntimeRunner({ flow });
  const otherRunner = new RuntimeRunner({ flow });
  const startAdmission = startAdmissionFor(continuation(), 'one-shot-start');
  const receipt = issueRuntimeContinuationAdmissionReceipt(runner, continuation(), startAdmission);

  assert.throws(
    () => issueRuntimeContinuationAdmissionReceipt(runner, continuation(), startAdmission),
    /proof is invalid or already consumed/,
  );
  assert.throws(
    () =>
      runAdmittedRuntimeContinuation(
        runner,
        Object.freeze({}) as RuntimeContinuationAdmissionReceipt,
        { source: 'test' },
      ),
    /invalid or already consumed/,
  );
  assert.throws(
    () => runAdmittedRuntimeContinuation(otherRunner, receipt, { source: 'test' }),
    /invalid or already consumed/,
  );
  await runAdmittedRuntimeContinuation(runner, receipt, { source: 'test' });
  assert.throws(
    () => runAdmittedRuntimeContinuation(runner, receipt, { source: 'test' }),
    /invalid or already consumed/,
  );
  assert.equal(dispatches, 1);
});

test('continuation admission binds the live start tool-boundary protocol to the runner', () => {
  const flow: RunnableAgentFlow = {
    async *run() {
      throw new Error('flow must not start');
    },
  };
  const durableRunner = new RuntimeRunner({
    flow,
    toolBoundaryProtocol: 't1_after_preflight_v1',
  });
  const legacyRunner = new RuntimeRunner({ flow });
  const admitted = continuation();

  assert.throws(
    () =>
      issueRuntimeContinuationAdmissionReceipt(
        durableRunner,
        admitted,
        startAdmissionFor(admitted, 'missing-protocol-start'),
      ),
    /durable admission identity is incomplete/,
  );
  assert.throws(
    () =>
      issueRuntimeContinuationAdmissionReceipt(
        legacyRunner,
        admitted,
        startAdmissionFor(admitted, 'unexpected-protocol-start', 't1_after_preflight_v1'),
      ),
    /durable admission identity is incomplete/,
  );
});

test('public run snapshots the request once and cannot morph into a continuation', async () => {
  let continuationReads = 0;
  let flowDispatched = false;
  const runner = new RuntimeRunner({
    flow: {
      async *run() {
        flowDispatched = true;
      },
    },
  });
  const request = {
    sessionId: 'session-1',
    turnId: 'normal-turn',
    text: 'normal input',
    source: 'test' as const,
    get continuation() {
      continuationReads += 1;
      return continuationReads === 1
        ? undefined
        : {
            sourceInvocationId: 'source-invocation',
            sourceRunId: 'source-run',
            sourceTurnId: 'source-turn',
            sourceRuntimeEventHighWater: 1,
          };
    },
  };

  await runner.run(request);

  assert.equal(continuationReads, 1);
  assert.equal(flowDispatched, true);
});

test('continuation admission binds replay and orchestration before caller mutation', async () => {
  let capturedText: string | undefined;
  let capturedMode: string | undefined;
  const runner = new RuntimeRunner({
    flow: {
      async *run(context, input) {
        capturedText =
          input.runtimeContext?.[0]?.content?.kind === 'text'
            ? input.runtimeContext[0].content.text
            : undefined;
        capturedMode = context.request.orchestration?.mode;
        yield {
          id: 'bound-terminal',
          sessionId: context.sessionId,
          invocationId: context.invocationId,
          runId: context.runId,
          turnId: context.turnId,
          ts: 2,
          partial: false,
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        };
      },
    },
  });
  const admitted = structuredClone(continuation());
  const orchestration = {
    mode: 'default' as const,
    source: 'session' as const,
    agentSwarmAuthorization: 'none' as const,
  };
  const receipt = issueRuntimeContinuationAdmissionReceipt(
    runner,
    admitted,
    startAdmissionFor(admitted, 'mutation-proof'),
    { orchestration },
  );

  if (admitted.runtimeContext[0]?.content?.kind !== 'text') {
    throw new Error('test continuation must carry text');
  }
  admitted.runtimeContext[0].content.text = 'tampered after admission';
  (orchestration as { mode: 'default' | 'swarm' }).mode = 'swarm';

  await runAdmittedRuntimeContinuation(runner, receipt, { source: 'test' });
  assert.equal(capturedText, 'continue this task');
  assert.equal(capturedMode, 'default');
});

function startAdmissionFor(
  admitted: RuntimeContinuation,
  startEventId: string,
  toolBoundaryProtocol?: 't1_after_preflight_v1',
) {
  if (
    !admitted.claimId ||
    !admitted.boundary ||
    !admitted.providerReplayDigest ||
    admitted.providerProjectionVersion !== 1
  ) {
    throw new Error('test continuation is missing durable admission identity');
  }
  return createRuntimeContinuationStartAdmissionProof({
    startEventId,
    claimId: admitted.claimId,
    boundaryDigest: admitted.boundary.manifestDigest,
    providerProjectionVersion: admitted.providerProjectionVersion,
    providerReplayDigest: admitted.providerReplayDigest,
    ...(toolBoundaryProtocol ? { toolBoundaryProtocol } : {}),
    target: {
      sessionId: admitted.sessionId,
      invocationId: admitted.invocationId,
      runId: admitted.runId,
      turnId: admitted.turnId,
    },
  });
}
