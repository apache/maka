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
import { mcpProxyToolName } from '@maka/runtime/mcp-tools';
import { type ClientCapabilityProvider, RuntimeHostOperationError } from '../client/index.js';
import {
  connectClient,
  requireStartedTurn,
  waitForTerminalTurn,
  withExecutionRoot,
} from './fixtures/execution-host-suite.js';

test('two Clients idempotently start one Host-owned safe-boundary continuation', async () => {
  await withExecutionRoot(async (fixture) => {
    const source = await fixture.seedSafeBoundaryContinuationSource();
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const second = await connectClient(fixture.root);
    const turnId = 'turn-safe-boundary-continuation';
    let clientsClosed = false;
    let hostStopped = false;
    try {
      const plan = await first.queryTurnResume({ sessionId: fixture.sessionId });
      assert.deepEqual(plan, {
        sessionId: fixture.sessionId,
        disposition: 'ready',
        sourceRunId: source.sourceRunId,
        sourceTurnId: source.sourceTurnId,
        sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
      });

      const input = {
        sessionId: fixture.sessionId,
        turnId,
        sourceRunId: source.sourceRunId,
        sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
      };
      const [firstStart, secondStart] = await Promise.all([
        first.startTurnResume(input),
        second.startTurnResume(input),
      ]);
      assert.equal(firstStart.kind, 'started');
      assert.equal(secondStart.kind, 'started');
      if (firstStart.kind !== 'started' || secondStart.kind !== 'started') return;
      assert.equal(firstStart.turn.runId, secondStart.turn.runId);

      const terminal = await waitForTerminalTurn(first, fixture.sessionId, turnId);
      assert.equal(terminal.status, 'completed');
      const retry = await second.startTurnResume(input);
      assert.deepEqual(retry, { kind: 'started', turn: terminal });

      const settledPlan = await first.queryTurnResume({ sessionId: fixture.sessionId });
      assert.deepEqual(settledPlan, {
        sessionId: fixture.sessionId,
        disposition: 'parked',
        reason: 'continuation_already_exists',
      });

      await first.close();
      await second.close();
      clientsClosed = true;
      await fixture.stopHost(host);
      hostStopped = true;

      const footprint = await fixture.readTurnFootprint(turnId);
      assert.deepEqual(footprint, {
        admitted: true,
        runCount: 1,
        userMessageCount: 0,
      });
      const admission = (await fixture.readAdmissionChain()).find(
        (candidate) => candidate.turnId === turnId,
      );
      assert.equal(admission?.userMessageId, null);
      assert.equal(admission?.execution.kind, 'safe_boundary_continuation');
      if (admission?.execution.kind !== 'safe_boundary_continuation') return;
      assert.equal(admission.execution.sourceRunId, source.sourceRunId);
      assert.equal(admission.execution.sourceInvocationId, source.sourceInvocationId);
      assert.equal(admission.execution.sourceRuntimeEventHighWater, 2);

      const ledger = await fixture.readTurn(turnId);
      assert.equal(ledger.runs.length, 1);
      const run = ledger.runs[0];
      assert.equal(run?.parentRunId, source.sourceRunId);
      assert.equal(run?.parentTurnId, source.sourceTurnId);
      assert.equal(run?.invocationId, admission.execution.targetInvocationId);
      assert.equal(run?.continuationSource?.sourceRunId, source.sourceRunId);
      assert.equal(
        run?.continuationSource && 'protocol' in run.continuationSource
          ? run.continuationSource.claimId
          : undefined,
        admission.execution.claimId,
      );
    } finally {
      if (!clientsClosed) {
        await first.close();
        await second.close();
      }
      if (!hostStopped) await fixture.stopHost(host);
    }
  });
});

test('startup repairs a continuation Run created before its durable start', async () => {
  await withExecutionRoot(async (fixture) => {
    const crash = await fixture.seedSafeBoundaryContinuationCrash('after_run_created');
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    try {
      const repaired = await client.queryTurn({
        sessionId: fixture.sessionId,
        turnId: crash.targetTurnId,
      });
      assert.equal(repaired.runId, crash.targetRunId);
      assert.equal(repaired.status, 'failed');
      assert.equal(repaired.failureClass, 'continuation_abandoned_before_provider_dispatch');
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: crash.sourceRunId,
          expectedRuntimeEventHighWater: crash.sourceRuntimeEventHighWater,
        }),
        {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'continuation_already_exists',
        },
      );
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

test('startup repairs a continuation claim committed before its target Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const crash = await fixture.seedSafeBoundaryContinuationCrash(
      'after_continuation_claim_committed',
    );
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    let clientClosed = false;
    let hostStopped = false;
    try {
      const repaired = await client.queryTurn({
        sessionId: fixture.sessionId,
        turnId: crash.targetTurnId,
      });
      assert.equal(repaired.runId, crash.targetRunId);
      assert.equal(repaired.status, 'failed');
      assert.equal(repaired.failureClass, 'continuation_abandoned_before_provider_dispatch');

      await client.close();
      clientClosed = true;
      await fixture.stopHost(host);
      hostStopped = true;
      const ledger = await fixture.readTurn(crash.targetTurnId);
      assert.equal(ledger.runs.length, 1);
      assert.equal(ledger.userMessages.length, 0);
    } finally {
      if (!clientClosed) await client.close();
      if (!hostStopped) await fixture.stopHost(host);
    }
  });
});

test('startup parks a provider-indeterminate continuation without blocking the Host', async () => {
  await withExecutionRoot(async (fixture) => {
    const siblingSessionId = await fixture.seedSession();
    const crash = await fixture.seedSafeBoundaryContinuationCrash(
      'after_continuation_start_committed',
    );
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    try {
      const indeterminate = await client.queryTurn({
        sessionId: fixture.sessionId,
        turnId: crash.targetTurnId,
      });
      assert.equal(indeterminate.runId, crash.targetRunId);
      assert.equal(indeterminate.status === 'created' || indeterminate.status === 'running', true);
      const plan = {
        sessionId: fixture.sessionId,
        disposition: 'parked' as const,
        reason: 'continuation_started_indeterminate' as const,
      };
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: crash.sourceRunId,
          expectedRuntimeEventHighWater: crash.sourceRuntimeEventHighWater,
        }),
        plan,
      );
      assert.deepEqual(
        await client.startTurnResume({
          sessionId: fixture.sessionId,
          turnId: crash.targetTurnId,
          sourceRunId: crash.sourceRunId,
          sourceRuntimeEventHighWater: crash.sourceRuntimeEventHighWater,
        }),
        { kind: 'parked', plan },
      );
      await assert.rejects(
        () =>
          client.stopTurn({
            sessionId: fixture.sessionId,
            turnId: crash.targetTurnId,
            runId: crash.targetRunId,
          }),
        (error) =>
          error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
      );
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: 'different-continuation-source',
          expectedRuntimeEventHighWater: crash.sourceRuntimeEventHighWater,
        }),
        {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'session_busy',
        },
      );
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId: 'turn-after-indeterminate-continuation',
            content: { text: 'Do not overtake the parked continuation.' },
          }),
        (error) => error instanceof RuntimeHostOperationError && error.code === 'session_busy',
      );

      const sibling = requireStartedTurn(
        await client.startTurn({
          sessionId: siblingSessionId,
          turnId: 'turn-unrelated-to-indeterminate-continuation',
          content: { text: 'Continue normally.' },
        }),
      );
      assert.equal(sibling.sessionId, siblingSessionId);
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

test('startup parks a provider-indeterminate continuation when resume is disabled', async () => {
  await withExecutionRoot(async (fixture) => {
    const siblingSessionId = await fixture.seedSession();
    const crash = await fixture.seedSafeBoundaryContinuationCrash(
      'after_continuation_start_committed',
    );
    const host = await fixture.startHost(undefined, false);
    const client = await connectClient(fixture.root);
    try {
      const indeterminate = await client.queryTurn({
        sessionId: fixture.sessionId,
        turnId: crash.targetTurnId,
      });
      assert.equal(indeterminate.runId, crash.targetRunId);
      assert.equal(indeterminate.status === 'created' || indeterminate.status === 'running', true);
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: crash.sourceRunId,
          expectedRuntimeEventHighWater: crash.sourceRuntimeEventHighWater,
        }),
        {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'continuation_unavailable',
        },
      );
      const sibling = requireStartedTurn(
        await client.startTurn({
          sessionId: siblingSessionId,
          turnId: 'turn-unrelated-to-disabled-indeterminate-continuation',
          content: { text: 'Continue normally.' },
        }),
      );
      assert.equal(sibling.sessionId, siblingSessionId);
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

test('startup parks a pre-claim continuation whose Client Capability is absent', async () => {
  await withExecutionRoot(async (fixture) => {
    const requiredToolName = mcpProxyToolName('resume_fixture', 'inspect');
    const pending = await fixture.seedPendingSafeBoundaryContinuation(requiredToolName);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    try {
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: pending.sourceRunId,
          expectedRuntimeEventHighWater: pending.sourceRuntimeEventHighWater,
        }),
        {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'safety_check_failed',
        },
      );
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId: 'turn-overtaking-client-capability-continuation',
            content: { text: 'Do not overtake the pending continuation.' },
          }),
        (error) => error instanceof RuntimeHostOperationError && error.code === 'session_busy',
      );
      assert.deepEqual(
        await client.queryTurn({
          sessionId: fixture.sessionId,
          turnId: pending.targetTurnId,
        }),
        {
          sessionId: fixture.sessionId,
          turnId: pending.targetTurnId,
          runId: pending.targetRunId,
          status: 'admitted',
        },
      );
      await assert.rejects(
        () =>
          client.stopTurn({
            sessionId: fixture.sessionId,
            turnId: pending.targetTurnId,
            runId: pending.targetRunId,
          }),
        (error) =>
          error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
      );
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: pending.sourceRunId,
          expectedRuntimeEventHighWater: pending.sourceRuntimeEventHighWater,
        }),
        {
          sessionId: fixture.sessionId,
          disposition: 'parked',
          reason: 'safety_check_failed',
        },
      );
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

test('Runtime Host keeps safe-boundary continuation opt-in', async () => {
  await withExecutionRoot(async (fixture) => {
    const source = await fixture.seedSafeBoundaryContinuationSource();
    const targetTurnId = 'turn-disabled-safe-boundary-continuation';
    const host = await fixture.startHost(undefined, false);
    const client = await connectClient(fixture.root);
    let clientClosed = false;
    let hostStopped = false;
    try {
      const plan = {
        sessionId: fixture.sessionId,
        disposition: 'parked' as const,
        reason: 'continuation_unavailable' as const,
      };
      assert.deepEqual(
        await client.queryTurnResume({
          sessionId: fixture.sessionId,
          sourceRunId: source.sourceRunId,
          expectedRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        }),
        plan,
      );
      assert.deepEqual(
        await client.startTurnResume({
          sessionId: fixture.sessionId,
          turnId: targetTurnId,
          sourceRunId: source.sourceRunId,
          sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
        }),
        { kind: 'parked', plan },
      );

      await client.close();
      clientClosed = true;
      await fixture.stopHost(host);
      hostStopped = true;
      assert.deepEqual(await fixture.readTurnFootprint(targetTurnId), {
        admitted: false,
        runCount: 0,
        userMessageCount: 0,
      });
    } finally {
      if (!clientClosed) await client.close();
      if (!hostStopped) await fixture.stopHost(host);
    }
  });
});

test('resume query previews the initiating Client Capability without binding it', async () => {
  await withExecutionRoot(async (fixture) => {
    const serverId = 'resume_fixture';
    const toolName = 'inspect';
    const requiredToolName = mcpProxyToolName(serverId, toolName);
    const source = await fixture.seedSafeBoundaryContinuationSource(requiredToolName);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    const provider = resumeFixtureProvider(serverId, [toolName]);
    try {
      assert.deepEqual(await client.queryTurnResume({ sessionId: fixture.sessionId }), {
        sessionId: fixture.sessionId,
        disposition: 'parked',
        reason: 'safety_check_failed',
      });
      await client.replaceClientCapabilities(provider);
      assert.deepEqual(await client.queryTurnResume({ sessionId: fixture.sessionId }), {
        sessionId: fixture.sessionId,
        disposition: 'ready',
        sourceRunId: source.sourceRunId,
        sourceTurnId: source.sourceTurnId,
        sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
      });
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }
  });
});

function resumeFixtureProvider(
  serverId: string,
  toolNames: readonly string[],
): ClientCapabilityProvider {
  return {
    offers: () => [
      {
        offerId: 'resume_fixture',
        version: '0',
        affinity: 'session',
        hostPathAccess: 'cwd',
        label: 'Resume fixture',
        tools: toolNames.map((name) => ({
          serverId,
          name,
          inputSchema: { type: 'object', additionalProperties: false },
        })),
      },
    ],
    call: async (_frame, { accept }) => {
      await accept();
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}
