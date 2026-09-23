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
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type ToolRecoveryMode,
} from '@maka/core/runtime-event';
import {
  testInvocationRecord,
  testInvocationOpenedEvent,
} from '@maka/runtime/test-only/invocation-fixture';
import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { buildRecoveredTerminalRuntimeEvent } from '@maka/runtime/terminal-run-commit';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import {
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import {
  connectClient,
  ExecutionFixture,
  operationError,
  requireStartedTurn,
  SubscriptionProbe,
  withExecutionRoot,
} from './fixtures/execution-host-suite.js';

// Normal CI uses a small history; the correctness runner also executes this
// same set of assertions against 100,000 unrelated immutable history events.
const historyEvents = Number(process.env.MAKA_STARTUP_MATRIX_HISTORY_EVENTS ?? 1_000);
assert.ok(Number.isSafeInteger(historyEvents) && historyEvents >= 10 && historyEvents <= 100_000);
const historySessions = Math.min(300, Math.ceil(historyEvents / 100));

const cases: ReadonlyArray<{ name: string; mode: ToolRecoveryMode; outcome?: boolean }> = [
  { name: 'prepared-read', mode: 'replay_safe' },
  { name: 'prepared-write', mode: 'reconcile' },
  { name: 'non-repeatable-effect', mode: 'never_auto_retry' },
  { name: 'dispatched-client-capability', mode: 'outcome_unknown' },
  { name: 'committed-success', mode: 'replay_safe', outcome: false },
  { name: 'committed-error', mode: 'reconcile', outcome: true },
];

test('mixed tool states recover once beside unrelated history before Host ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const background = await seedBackground(fixture);
    const unchangedBackground = await readHistory(fixture, background);
    const targets = [];
    for (const scenario of cases) {
      const sessionId = await fixture.seedSession();
      const session = new ExecutionFixture(
        fixture.base,
        fixture.root,
        fixture.capability,
        sessionId,
      );
      const turnId = randomUUID();
      const { runId } = await session.seedRunWithUserMessage(turnId, { text: scenario.name });
      const operationId = randomUUID();
      await seedTool(fixture, { sessionId, runId, turnId, operationId }, scenario);
      targets.push({ scenario, session, turnId, operationId });
    }
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root);
    for (const { session, turnId } of targets) {
      const recovered = await first.request('turn.query', { sessionId: session.sessionId, turnId });
      assert.equal(recovered.status, 'failed');
      if (recovered.status === 'failed') assert.equal(recovered.failureClass, 'app_restarted');
    }
    await first.close();
    await fixture.stopHost(firstHost);
    const settled = [];
    for (const { scenario, session, turnId, operationId } of targets) {
      const ledger = await session.readTurn(turnId);
      assert.equal(ledger.terminalEvents.length, 1, scenario.name);
      assert.equal(ledger.userMessages.length, 1, scenario.name);
      const outcomes = ledger.runtimeEvents.filter(
        (event) => event.content?.kind === 'function_response',
      );
      if (scenario.mode === 'outcome_unknown') {
        assert.equal(outcomes.length, 1);
        const outcome = outcomes[0]!;
        assert.equal(outcome.refs?.operationId, operationId);
        assert.equal(
          outcome.content?.kind === 'function_response' && outcome.content.isError,
          true,
        );
        assert.match(JSON.stringify(outcome.content), /outcome_unknown/);
        assert.match(JSON.stringify(outcome.content), /"retrySafe":false/);
      } else if (scenario.outcome !== undefined) {
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0]!.id, `${operationId}-outcome`);
        const content = outcomes[0]!.content;
        assert.ok(content?.kind === 'function_response');
        assert.equal(content.isError, scenario.outcome);
        assert.deepEqual(content.result, { kind: 'text', text: scenario.name });
      } else {
        assert.equal(
          outcomes.length,
          0,
          'recovery must not invent success for an unobserved effect',
        );
      }
      settled.push(ledger.runtimeEvents);
    }
    assert.deepEqual(await readHistory(fixture, background), unchangedBackground);

    const secondHost = await fixture.startHost();
    await fixture.stopHost(secondHost);
    for (const [index, { session, turnId }] of targets.entries()) {
      assert.deepEqual((await session.readTurn(turnId)).runtimeEvents, settled[index]);
    }
    assert.deepEqual(await readHistory(fixture, background), unchangedBackground);
  });
});

test('consumed steering survives a live Host crash without replay or duplicate echo', async () => {
  await withExecutionRoot(async (fixture) => {
    const background = await seedBackground(fixture);
    const unchangedBackground = await readHistory(fixture, background);
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const subscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    await subscription.ready();
    const probe = new SubscriptionProbe(subscription);
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await first.request('turn.start', {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_HOLD_OPEN_PROMPT },
      }),
    );
    const steering = {
      originHostEpoch: firstHost.hostEpoch,
      sessionId: fixture.sessionId,
      messageId: randomUUID(),
      content: {
        text: 'Keep this correction exactly once',
        quotes: [{ text: 'quoted correction' }],
      },
      placement: 'current_turn' as const,
    };
    assert.equal((await first.request('turn.message.submit', steering)).disposition, 'steering');
    await probe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_event' &&
        frame.event.type === 'steering_message' &&
        frame.event.messageId === steering.messageId,
      'steering was not durably echoed before the crash',
    );
    await fixture.killHost(firstHost);
    await first.closed;
    await probe.waitForFailure('connection_closed');

    const secondHost = await fixture.startHost();
    const second = await connectClient(fixture.root);
    const recovered = await second.request('turn.query', { sessionId: fixture.sessionId, turnId });
    assert.equal(recovered.runId, started.runId);
    assert.equal(recovered.status, 'failed');
    const restored = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    await restored.ready();
    assert.deepEqual(restored.snapshot.queue.steering, []);
    assert.deepEqual(restored.snapshot.queue.followup, []);
    await assert.rejects(
      second.request('turn.message.submit', steering),
      operationError('outcome_unknown'),
    );
    await restored.close();
    await second.close();
    await fixture.stopHost(secondHost);
    const ledger = await fixture.readTurn(turnId);
    const echoes = ledger.runtimeEvents.filter(
      (event) => event.refs?.providerEventId === steering.messageId,
    );
    assert.equal(echoes.length, 1);
    assert.deepEqual(echoes[0]!.content, { kind: 'text', ...steering.content, steering: true });
    assert.equal(ledger.runtimeEvents.filter(isTerminalRuntimeEvent).length, 1);
    const thirdHost = await fixture.startHost();
    await fixture.stopHost(thirdHost);
    assert.deepEqual((await fixture.readTurn(turnId)).runtimeEvents, ledger.runtimeEvents);
    assert.deepEqual(await readHistory(fixture, background), unchangedBackground);
  });
});

async function seedBackground(fixture: ExecutionFixture) {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const runs = [];
  try {
    for (let index = 0; index < historySessions; index++) {
      const header = await stores.sessionStore.create({
        cwd: fixture.root,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const run = testInvocationRecord({
        sessionId: header.id,
        runId: randomUUID(),
        turnId: randomUUID(),
        openedAt: 1,
      });
      const events: RuntimeEvent[] = [testInvocationOpenedEvent({ ...run, openedAt: 1 })];
      for (let event = index; event < historyEvents; event += historySessions) {
        events.push({
          id: randomUUID(),
          sessionId: header.id,
          invocationId: run.invocationId,
          runId: run.runId,
          turnId: run.turnId,
          ts: event + 2,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: `Settled history ${event}` },
        });
      }
      events.push(
        buildRecoveredTerminalRuntimeEvent({
          id: randomUUID(),
          run,
          status: 'completed',
          ts: historyEvents + 2,
          recoveryReason: 'startup_matrix_history',
        }),
      );
      await stores.runtimeEventStore.importConversationCopyRuntimeEvents(header.id, [
        { runId: run.runId, events },
      ]);
      runs.push({ sessionId: header.id, runId: run.runId });
    }
    return runs;
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }
}

async function readHistory(
  fixture: ExecutionFixture,
  runs: Array<{ sessionId: string; runId: string }>,
) {
  const reader = await tryAcquireInteractiveRootReader(fixture.capability);
  assert.ok(reader);
  const stores = await openInteractiveExecutionStoresForRead(reader.lease);
  try {
    const digest = createHash('sha256');
    let count = 0;
    for (const run of runs) {
      const events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        run.sessionId,
        run.runId,
      );
      count += events.length;
      digest.update(JSON.stringify(events));
    }
    assert.equal(runs.length, historySessions);
    assert.equal(count, historyEvents + historySessions * 2);
    return { count, sha256: digest.digest('hex') };
  } finally {
    await stores.sessionStore.close?.();
    await reader.close();
  }
}

async function seedTool(
  fixture: ExecutionFixture,
  ids: { sessionId: string; runId: string; turnId: string; operationId: string },
  scenario: (typeof cases)[number],
) {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const { operationId, ...identity } = ids;
    const callId = `${operationId}-call`;
    const args = { value: scenario.name };
    const canonicalArgsHash = canonicalToolArgsHash('matrix-tool', args);
    const base: RuntimeEvent = {
      ...identity,
      invocationId: ids.runId,
      id: '',
      ts: Date.now(),
      partial: false,
      role: 'system',
      author: 'system',
    };
    await stores.runtimeEventStore.commitToolPrepared({
      operationId,
      journalEventId: `${operationId}_prepared`,
      providerToolCallId: callId,
      toolName: 'matrix-tool',
      canonicalArgsHash,
      recoveryMode: scenario.mode,
      committedAt: base.ts,
      runtimeEvent: {
        ...base,
        id: callId,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: callId, name: 'matrix-tool', args },
      },
      dispatchRuntimeEvent: {
        ...base,
        id: `${operationId}-dispatch`,
        refs: { operationId, toolCallId: callId },
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId,
            providerToolCallId: callId,
            toolName: 'matrix-tool',
            canonicalArgsHash,
            recoveryMode: scenario.mode,
          },
        },
      },
    });
    if (scenario.outcome !== undefined) {
      await stores.runtimeEventStore.commitToolOutcome({
        operationId,
        journalEventId: `${operationId}_outcome`,
        committedAt: base.ts + 1,
        runtimeEvent: {
          ...base,
          id: `${operationId}-outcome`,
          ts: base.ts + 1,
          role: 'tool',
          author: 'tool',
          refs: { operationId, toolCallId: callId },
          content: {
            kind: 'function_response',
            id: callId,
            name: 'matrix-tool',
            result: { kind: 'text', text: scenario.name },
            isError: scenario.outcome,
          },
        },
      });
    }
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
  }
}
