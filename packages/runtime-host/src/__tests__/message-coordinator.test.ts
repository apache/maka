import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageContent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  MessageOperationReceipt,
  MessageReceiptStore,
  RootTurnSourceMessageReceipt,
} from '@maka/storage/execution-stores';
import {
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  type SessionMessageQueueProjection,
  type TurnSnapshot,
} from '../protocol/index.js';
import {
  HostMessageCoordinator,
  type HostMessageCoordinatorOptions,
  type HostMessageRootPort,
  type HostMessageRootState,
} from '../server/message-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const ROOT = { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' } as const;

test('idle submit starts exactly one root Turn and retry identity is connection-independent', async () => {
  const fixture = createFixture();
  fixture.setRootState({ kind: 'idle' });
  const input = {
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    messageId: 'idle-message',
    content: { text: 'start from idle' },
    placement: 'next_turn',
  } as const;

  const first = await fixture.coordinator.handlers['turn.message.submit'](
    input,
    operationContext('connection-before-disconnect'),
  );
  const retry = await fixture.coordinator.handlers['turn.message.submit'](
    input,
    operationContext('connection-after-disconnect'),
  );

  assert.deepEqual(first, {
    ok: true,
    result: { disposition: 'turn_started', turnId: 'idle-turn' },
  });
  assert.deepEqual(retry, first);
  assert.equal(fixture.startCalls(), 1);
  assert.equal(fixture.liveResidencies(), 0);
});

test('invalidates the canonical projection after each observable queue mutation', async () => {
  const changedSessions: string[] = [];
  const fixture = createFixture((sessionId) => changedSessions.push(sessionId));
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  assert.equal((await submit(fixture, 'steering-1', 'first', 'current_turn')).ok, true);
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.ack([lease.id]);
  owner.release();
  fixture.coordinator.completeIdle(fixture.coordinator.beginTerminalTransition(ROOT));

  assert.deepEqual(
    changedSessions,
    Array.from({ length: 4 }, () => ROOT.sessionId),
  );
  await fixture.coordinator.close();
});

test('binds the exact reserved Run after a pre-bind stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  assert.equal((await submit(fixture, 'queued-before-bind', 'discard me', 'next_turn')).ok, true);

  const fence = fixture.coordinator.commitStopFence(ROOT);
  assert.equal(fence.retracted.length, 1);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  assert.equal(fixture.liveResidencies(), 0);

  const owner = fixture.coordinator.bindRun(ROOT);
  assert.deepEqual(owner.pull(), []);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('queue projection capacity is rejected before mutation or residency acquisition', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  const outcome = await submit(fixture, 'oversized', 'x'.repeat(52 * 1024), 'current_turn');

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'session_busy');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('full snapshot preflight rejection leaves queue, receipt, residency, and publication unchanged', async () => {
  let fits = false;
  let observedQueue: SessionMessageQueueProjection | undefined;
  const changedSessions: string[] = [];
  const fixture = createFixture(
    (sessionId) => changedSessions.push(sessionId),
    async (_sessionId, candidate) => {
      observedQueue = candidate.queue;
      return fits;
    },
  );
  fixture.coordinator.reserveRootTurn(ROOT);

  const rejected = await submit(fixture, 'capacity-candidate', 'small message', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');
  assert.equal(observedQueue?.queueRevision, 1);
  assert.equal(observedQueue?.steering[0]?.state, 'queued');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  assert.deepEqual(changedSessions, []);

  fits = true;
  const accepted = await submit(fixture, 'capacity-candidate', 'small message', 'current_turn');
  assert.equal(accepted.ok && accepted.result.disposition, 'steering');
  assert.equal(fixture.liveResidencies(), 1);
  assert.deepEqual(changedSessions, [ROOT.sessionId]);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-capacity' },
    operationContext(),
  );
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('queue admission rejects content that cannot form a durable follow-up Turn', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  const first = await submit(fixture, 'large-followup', 'x'.repeat(40 * 1024), 'next_turn');
  assert.equal(first.ok && first.result.disposition, 'followup');
  const projectionBefore = structuredClone(fixture.coordinator.projection(ROOT.sessionId));

  const rejected = await submitContent(
    fixture,
    'display-followup',
    { text: 'model', displayText: 'human' },
    'next_turn',
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'session_busy');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), projectionBefore);
  assert.equal(fixture.liveResidencies(), 1);

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-large' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  fixture.coordinator.abandonRootReservation(ROOT);
  await fixture.coordinator.close();
});

test('pull crosses the retract commit cut and only queued entries are retracted', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  await submit(fixture, 'steer-1', 'steer me', 'current_turn');
  await submit(fixture, 'follow-1', 'later', 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const outcome = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'retract-1',
    },
    operationContext(),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.result.retracted.map((entry) => entry.messageId),
    ['follow-1'],
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 4,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'steer-1',
        content: { text: 'steer me' },
        placement: 'current_turn',
        state: 'in_flight',
      },
    ],
    followup: [],
  });

  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
});

test('submit mutation is visible before its receipt and concurrent retries share the cut', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const receipt = fixture.delayReceipt('submit', 'delayed-submit');

  const submitted = submit(fixture, 'delayed-submit', 'steer now', 'current_turn');
  const retry = submit(fixture, 'delayed-submit', 'steer now', 'current_turn');
  assert.equal(retry, submitted);
  const conflict = await submit(fixture, 'delayed-submit', 'different', 'current_turn');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');

  await receipt.started.promise;
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['delayed-submit'],
  );
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.nack([lease.id]);

  receipt.release.resolve(undefined);
  const outcome = await submitted;
  assert.deepEqual(outcome, {
    ok: true,
    result: { disposition: 'steering', queueRevision: 1 },
  });
  assert.deepEqual(await submit(fixture, 'delayed-submit', 'steer now', 'current_turn'), outcome);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 3,
    steering: [
      {
        entryId: 'id-1',
        messageId: 'delayed-submit',
        content: { text: 'steer now' },
        placement: 'current_turn',
        state: 'queued',
      },
    ],
    followup: [],
  });

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-submit-cut' },
    operationContext(),
  );
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('retract mutation is visible while its receipt waits and preserves its exact cut', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'first', 'current_turn');
  await submit(fixture, 'steer-2', 'second', 'current_turn');
  await submit(fixture, 'follow-1', 'later', 'next_turn');
  const leases = owner.pull();
  assert.equal(leases.length, 2);
  const receipt = fixture.delayReceipt('retract', 'delayed-retract');

  const retracted = fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'delayed-retract',
    },
    operationContext(),
  );
  const retry = fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'delayed-retract',
    },
    operationContext(),
  );
  assert.equal(retry, retracted);

  await receipt.started.promise;
  assert.deepEqual(owner.pull(), []);
  owner.ack([leases[0]!.id]);
  owner.nack([leases[1]!.id]);
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['steer-2'],
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);

  receipt.release.resolve(undefined);
  const outcome = await retracted;
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      queueRevision: 5,
      retracted: [
        {
          entryId: 'id-3',
          messageId: 'follow-1',
          content: { text: 'later' },
          placement: 'next_turn',
          state: 'retracted',
        },
      ],
    },
  });
  assert.deepEqual(await retry, outcome);

  await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-retract-cut' },
    operationContext(),
  );
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('post-effect receipt failure fail-stops the Host Epoch and drains retained residency', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const receipt = fixture.delayReceipt('submit', 'receipt-failure', new Error('disk failed'));

  const submitted = submit(fixture, 'receipt-failure', 'accepted effect', 'current_turn');
  await receipt.started.promise;
  assert.equal(fixture.liveResidencies(), 1);
  receipt.release.resolve(undefined);
  await assert.rejects(submitted, /disk failed/);

  assert.equal(fixture.drainRequests(), 1);
  const rejected = await submit(fixture, 'after-failure', 'must not serve', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'host_draining');
  const rejectedRetract = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'after-failure' },
    operationContext(),
  );
  assert.equal(rejectedRetract.ok, false);
  if (!rejectedRetract.ok) assert.equal(rejectedRetract.error.code, 'host_draining');
  const rejectedInterrupt = await fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'after-failure',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  assert.equal(rejectedInterrupt.ok, false);
  if (!rejectedInterrupt.ok) assert.equal(rejectedInterrupt.error.code, 'host_draining');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('operations queued behind a receipt failure recheck fail-stop before reads or mutation', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const receipt = fixture.delayReceipt('submit', 'poison-authority', new Error('disk failed'));

  const poisoning = submit(fixture, 'poison-authority', 'accepted effect', 'current_turn');
  await receipt.started.promise;
  const queuedSubmit = submit(fixture, 'queued-submit', 'must not land', 'current_turn');
  const queuedRetract = fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'queued-retract' },
    operationContext(),
  );
  const queuedInterrupt = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'queued-interrupt',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await Promise.resolve();
  const readsBeforeFailure = fixture.receiptReads();
  const rootReadsBeforeFailure = fixture.rootReads();
  const projectionBeforeFailure = structuredClone(fixture.coordinator.projection(ROOT.sessionId));

  receipt.release.resolve(undefined);
  await assert.rejects(poisoning, /disk failed/);
  const outcomes = await Promise.all([queuedSubmit, queuedRetract, queuedInterrupt]);

  for (const outcome of outcomes) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'host_draining');
  }
  assert.equal(fixture.receiptReads(), readsBeforeFailure);
  assert.equal(fixture.rootReads(), rootReadsBeforeFailure);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), projectionBeforeFailure);
  assert.equal(fixture.drainRequests(), 1);

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('stop delivery failure after the queue fence fail-stops and retry is prompt', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'queued-before-stop-failure', 'retract at fence', 'next_turn');
  fixture.failStopDelivery(new Error('stop delivery failed'));
  const input = {
    originHostEpoch: 'epoch-1',
    sessionId: ROOT.sessionId,
    interruptId: 'interrupt-delivery-failure',
    turnId: ROOT.turnId,
    runId: ROOT.runId,
  } as const;

  await assert.rejects(
    fixture.coordinator.handlers['turn.interrupt'](input, operationContext()),
    /stop delivery failed/,
  );
  assert.equal(fixture.drainRequests(), 1);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);

  const retry = await fixture.coordinator.handlers['turn.interrupt'](
    input,
    operationContext('retry-after-delivery-failure'),
  );
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, 'host_draining');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  await fixture.coordinator.close();
});

test('an interrupt generation fence makes a late nack discard its in-flight entry', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-1', 'leased', 'current_turn');
  const interruptedContent = {
    text: '<model>queued</model>',
    displayText: 'queued',
    attachments: [attachment('interrupt', 'queued.png')],
  };
  await submitContent(fixture, 'follow-1', interruptedContent, 'next_turn');
  const [lease] = owner.pull();
  assert.ok(lease);

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  const retry = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await fixture.stopClaimed.promise;

  owner.nack([lease.id]);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.equal(fixture.liveResidencies(), 0);
  fixture.resolveTerminal({
    ...ROOT,
    status: 'cancelled',
    terminalEventId: 'terminal-1',
    abortSource: 'user_interrupt',
  });
  const [outcome, retryOutcome] = await Promise.all([interrupted, retry]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(retryOutcome, outcome);
  if (outcome.ok) {
    assert.deepEqual(outcome.result.retracted, [
      {
        entryId: 'id-2',
        messageId: 'follow-1',
        content: interruptedContent,
        placement: 'next_turn',
        state: 'retracted',
      },
    ]);
  }
  assert.deepEqual(
    await fixture.coordinator.handlers['turn.interrupt'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: ROOT.sessionId,
        interruptId: 'interrupt-1',
        turnId: ROOT.turnId,
        runId: ROOT.runId,
      },
      operationContext('connection-after-terminal'),
    ),
    outcome,
  );
  const identityConflict = await fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-1',
      turnId: ROOT.turnId,
      runId: 'different-run',
    },
    operationContext(),
  );
  assert.equal(identityConflict.ok, false);
  if (!identityConflict.ok) assert.equal(identityConflict.error.code, 'operation_conflict');

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('interrupt receipt deletion reclaims state after terminal completion wins the race', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'queued-before-interrupt', 'later', 'next_turn');
  const receipt = fixture.delayReceipt('interrupt', 'interrupt-terminal-first');

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-terminal-first',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await fixture.stopClaimed.promise;
  fixture.resolveTerminal({
    ...ROOT,
    status: 'cancelled',
    terminalEventId: 'terminal-first',
    abortSource: 'user_interrupt',
  });
  await receipt.started.promise;

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.notEqual(fixture.coordinator.projection(ROOT.sessionId).queueRevision, 0);

  receipt.release.resolve(undefined);
  assert.equal((await interrupted).ok, true);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
});

test('stale interrupt deletion reclaims state after terminal transition completes first', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'consumed-before-stale', 'consume', 'current_turn');
  const [lease] = owner.pull();
  assert.ok(lease);
  owner.ack([lease.id]);
  const rootRead = fixture.delayRootState();

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-stale',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await rootRead.started.promise;
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  fixture.setRootState({ kind: 'idle' });
  rootRead.release.resolve(undefined);

  const outcome = await interrupted;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
});

test('every admitted queue state retains an encodable interrupt result', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  for (let index = 0; index < 64; index += 1) {
    const admitted = await submit(fixture, `message-${index}`, 'x'.repeat(723), 'next_turn');
    assert.equal(admitted.ok && admitted.result.disposition, 'followup');
  }
  const projectionBytes = Buffer.byteLength(
    JSON.stringify(fixture.coordinator.projection(ROOT.sessionId)),
    'utf8',
  );
  assert.ok(projectionBytes > MESSAGE_QUEUE_PROJECTION_MAX_BYTES - 32);
  assert.ok(projectionBytes <= MESSAGE_QUEUE_PROJECTION_MAX_BYTES);

  const interrupted = fixture.coordinator.handlers['turn.interrupt'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      interruptId: 'interrupt-capacity',
      turnId: ROOT.turnId,
      runId: ROOT.runId,
    },
    operationContext(),
  );
  await fixture.stopClaimed.promise;
  fixture.resolveTerminal({
    ...ROOT,
    status: 'failed',
    terminalEventId: 'x'.repeat(128),
    failureClass: '\0'.repeat(128),
  });
  const outcome = await interrupted;
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.result.retracted.length, 64);
    assert.ok(
      Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <=
        MESSAGE_OPERATION_RESULT_MAX_BYTES,
    );
  }

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('release folds unpulled steering ahead of follow-up without changing source semantics', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first-source', 'same-name.png');
  const secondAttachment = attachment('second-source', 'same-name.png');
  const thirdAttachment = attachment('third-source', 'same-name.png');
  const firstQuotes = [
    { text: 'first excerpt', label: 'assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
  ];
  const secondQuotes = [{ text: 'third excerpt', label: 'tool output' }];
  const thirdQuotes = [{ text: 'fourth excerpt', sourceTurnId: 'turn-source-3' }];
  const first = await submitContent(
    fixture,
    'steer-1',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment],
      quotes: firstQuotes,
    },
    'current_turn',
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  const third = await submitContent(
    fixture,
    'follow-1',
    {
      text: '<model>third</model>',
      displayText: 'third',
      attachments: [thirdAttachment],
      quotes: thirdQuotes,
    },
    'next_turn',
  );
  assert.equal(third.ok, true, JSON.stringify(third));
  const second = await submitContent(
    fixture,
    'steer-2',
    { text: 'second', attachments: [secondAttachment], quotes: secondQuotes },
    'current_turn',
  );
  assert.equal(second.ok, true, JSON.stringify(second));

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.content, {
    text: '<model>first</model>\n\nsecond\n\n<model>third</model>',
    displayText: 'first\n\nsecond\n\nthird',
    attachments: [firstAttachment, secondAttachment, thirdAttachment],
    quotes: [...firstQuotes, ...secondQuotes, ...thirdQuotes],
  });
  assert.deepEqual(batch.sources, [
    {
      messageId: 'steer-1',
      content: {
        text: '<model>first</model>',
        displayText: 'first',
        attachments: [firstAttachment],
        quotes: firstQuotes,
      },
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'steer-2',
      content: { text: 'second', attachments: [secondAttachment], quotes: secondQuotes },
      placement: 'current_turn',
      disposition: 'steering',
    },
    {
      messageId: 'follow-1',
      content: {
        text: '<model>third</model>',
        displayText: 'third',
        attachments: [thirdAttachment],
        quotes: thirdQuotes,
      },
      placement: 'next_turn',
      disposition: 'followup',
    },
  ]);
  assert.equal(fixture.liveResidencies(), 3);

  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  assert.equal(fixture.liveResidencies(), 0);
  const next = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  next.release();
  const empty = fixture.coordinator.beginTerminalTransition({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  fixture.coordinator.completeIdle(empty);
});

test('terminal transition atomically folds messages submitted after run release', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  owner.release();
  const submitted = await submit(fixture, 'late-steer', 'next intent', 'current_turn');
  assert.equal(submitted.ok && submitted.result.disposition, 'steering');

  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, [
    {
      messageId: 'late-steer',
      content: { text: 'next intent' },
      placement: 'current_turn',
      disposition: 'steering',
    },
  ]);
  fixture.coordinator.commitNextRoot(batch, {
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  const next = fixture.coordinator.bindRun({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  next.release();
  const empty = fixture.coordinator.beginTerminalTransition({
    sessionId: ROOT.sessionId,
    turnId: 'turn-2',
    runId: 'run-2',
  });
  fixture.coordinator.completeIdle(empty);
});

test('administrative drain preserves accepted entries until the terminal stop fence', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  await submit(fixture, 'steer-drain', 'current intent', 'current_turn');
  await submit(fixture, 'follow-drain', 'next intent', 'next_turn');

  fixture.coordinator.beginDrain();
  const rejected = await submit(fixture, 'late-drain', 'too late', 'current_turn');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'host_draining');
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).steering.map((entry) => entry.messageId),
    ['steer-drain'],
  );
  assert.deepEqual(
    fixture.coordinator.projection(ROOT.sessionId).followup.map((entry) => entry.messageId),
    ['follow-drain'],
  );

  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  assert.deepEqual(batch.sources, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering, []);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).followup, []);
  fixture.coordinator.completeIdle(batch);
  assert.equal(fixture.liveResidencies(), 0);
  await fixture.coordinator.close();
});

test('semantic retry history does not become a permanent Session admission cap', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);

  for (let index = 0; index < 65; index += 1) {
    const outcome = await fixture.coordinator.handlers['queue.retract'](
      {
        originHostEpoch: 'epoch-1',
        sessionId: ROOT.sessionId,
        retractId: `retract-${index}`,
      },
      operationContext(),
    );
    assert.equal(outcome.ok, true);
  }
});

test('submit retries use keyed receipts and durable proof while old-Epoch rich conflicts fail', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submit(fixture, 'same-1', 'same text', 'current_turn');
  const retry = await submit(fixture, 'same-1', 'same text', 'current_turn');
  assert.deepEqual(retry, first);
  const conflict = await submit(fixture, 'same-1', 'changed', 'current_turn');
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
  assert.equal(fixture.coordinator.projection(ROOT.sessionId).steering.length, 1);

  fixture.receipts.set(
    'current-follow',
    sourceReceipt('current-follow', 'durable current follow-up', 'next_turn', 'followup'),
  );
  fixture.receipts.set(
    'old-follow',
    sourceReceipt(
      'old-follow',
      {
        text: '<model>durable follow-up</model>',
        displayText: 'durable follow-up',
        attachments: [attachment('proof-follow', 'proof.png')],
      },
      'next_turn',
      'followup',
    ),
  );
  const oldFollow = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'durable follow-up',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.equal(oldFollow.ok, false);
  if (!oldFollow.ok) assert.equal(oldFollow.error.code, 'outcome_unknown');

  fixture.events.push(
    steeringEvent('old-steer', {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    }),
  );
  const oldSteer = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(oldSteer.ok, false);
  if (!oldSteer.ok) assert.equal(oldSteer.error.code, 'outcome_unknown');

  const durableBeforeRetries = {
    receipts: structuredClone([...fixture.receipts]),
    events: structuredClone(fixture.events),
  };
  const queueBeforeRetries = structuredClone(fixture.coordinator.projection(ROOT.sessionId));
  const currentFollow = await submit(
    fixture,
    'current-follow',
    'durable current follow-up',
    'next_turn',
  );
  assert.equal(currentFollow.ok, false);
  if (!currentFollow.ok) assert.equal(currentFollow.error.code, 'outcome_unknown');
  const displayConflict = await submitContent(
    fixture,
    'old-follow',
    {
      text: '<model>durable follow-up</model>',
      displayText: 'changed display',
      attachments: [attachment('proof-follow', 'proof.png')],
    },
    'next_turn',
    'old-epoch',
  );
  assert.equal(displayConflict.ok, false);
  if (!displayConflict.ok) assert.equal(displayConflict.error.code, 'operation_conflict');
  const attachmentRefConflict = await submitContent(
    fixture,
    'old-steer',
    {
      text: '<model>durable steering</model>',
      displayText: 'durable steering',
      attachments: [attachment('changed-proof-steer', 'proof.png')],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(attachmentRefConflict.ok, false);
  if (!attachmentRefConflict.ok) {
    assert.equal(attachmentRefConflict.error.code, 'operation_conflict');
  }
  assert.deepEqual(
    {
      receipts: [...fixture.receipts],
      events: fixture.events,
    },
    durableBeforeRetries,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), queueBeforeRetries);

  const unknown = await submit(fixture, 'old-unknown', 'not durable', 'current_turn', 'old-epoch');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    {
      originHostEpoch: 'epoch-1',
      sessionId: ROOT.sessionId,
      retractId: 'cleanup',
    },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId), {
    hostEpoch: 'epoch-1',
    queueRevision: 0,
    steering: [],
    followup: [],
  });
  assert.deepEqual(await submit(fixture, 'same-1', 'same text', 'current_turn'), first);
  const reclaimedConflict = await submit(fixture, 'same-1', 'changed after idle', 'current_turn');
  assert.equal(reclaimedConflict.ok, false);
  if (!reclaimedConflict.ok) assert.equal(reclaimedConflict.error.code, 'operation_conflict');
});

test('old-Epoch steering proof compares ordered quote provenance before reporting ambiguity', async () => {
  const fixture = createFixture();
  const messageId = 'old-steer';
  const content = {
    text: 'durable steering',
    quotes: [
      { text: 'first durable excerpt', label: 'assistant', sourceTurnId: 'turn-source-1' },
      { text: 'second durable excerpt', sourceTurnId: 'turn-source-2' },
    ],
  };
  fixture.events.push({ ...steeringEvent(messageId, content), partial: true });

  const unknown = await submitContent(fixture, messageId, content, 'current_turn', 'old-epoch');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'outcome_unknown');

  fixture.events.push(steeringEvent(messageId, content));
  const proven = await submitContent(fixture, messageId, content, 'current_turn', 'old-epoch');
  assert.equal(proven.ok, false);
  if (!proven.ok) assert.equal(proven.error.code, 'outcome_unknown');

  const provenanceConflict = await submitContent(
    fixture,
    messageId,
    {
      ...content,
      quotes: [content.quotes[0]!, { ...content.quotes[1]!, sourceTurnId: 'turn-source-changed' }],
    },
    'current_turn',
    'old-epoch',
  );
  assert.equal(provenanceConflict.ok, false);
  if (!provenanceConflict.ok) {
    assert.equal(provenanceConflict.error.code, 'operation_conflict');
  }
});

test('canonical content preserves ordered attachment and quote identity across queue projections', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);
  const firstAttachment = attachment('first', 'same-name.png');
  const secondAttachment = attachment('second', 'same-name.png');
  const steeringQuotes = [
    { text: 'first quote', label: 'assistant', sourceTurnId: 'turn-source-1' },
    { text: 'second quote', sourceTurnId: 'turn-source-2' },
  ];
  const followupQuotes = [{ text: 'follow-up quote', label: 'user selection' }];

  const submitted = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment, secondAttachment],
      quotes: steeringQuotes,
    },
    'current_turn',
  );
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const reordered = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [secondAttachment, firstAttachment],
      quotes: steeringQuotes,
    },
    'current_turn',
  );
  assert.equal(reordered.ok, false);
  if (!reordered.ok) assert.equal(reordered.error.code, 'operation_conflict');
  const quoteOrderConflict = await submitContent(
    fixture,
    'rich-steer',
    {
      text: '<model>first</model>',
      displayText: 'first',
      attachments: [firstAttachment, secondAttachment],
      quotes: [...steeringQuotes].reverse(),
    },
    'current_turn',
  );
  assert.equal(quoteOrderConflict.ok, false);
  if (!quoteOrderConflict.ok) assert.equal(quoteOrderConflict.error.code, 'operation_conflict');
  const followup = await submitContent(
    fixture,
    'rich-followup',
    {
      text: '<model>later</model>',
      displayText: 'later',
      quotes: followupQuotes,
    },
    'next_turn',
  );
  assert.equal(followup.ok, true);

  const projection = fixture.coordinator.projection(ROOT.sessionId);
  assert.deepEqual(projection.steering[0]?.content, {
    text: '<model>first</model>',
    displayText: 'first',
    attachments: [firstAttachment, secondAttachment],
    quotes: steeringQuotes,
  });
  assert.deepEqual(projection.followup[0]?.content, {
    text: '<model>later</model>',
    displayText: 'later',
    quotes: followupQuotes,
  });

  const [lease] = owner.pull();
  assert.ok(lease);
  assert.deepEqual(lease.content, {
    text: '<model>first</model>',
    displayText: 'first',
    attachments: [firstAttachment, secondAttachment],
    quotes: steeringQuotes,
  });
  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup-rich-followup' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (retracted.ok) {
    assert.deepEqual(retracted.result.retracted[0]?.content, projection.followup[0]?.content);
  }
  owner.ack([lease.id]);
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

test('canonical retry omits redundant display text and empty ordered refs', async () => {
  const fixture = createFixture();
  fixture.coordinator.reserveRootTurn(ROOT);
  const owner = fixture.coordinator.bindRun(ROOT);

  const first = await submitContent(
    fixture,
    'canonical',
    { text: 'same', displayText: 'same', attachments: [], quotes: [] },
    'current_turn',
  );
  assert.deepEqual(
    await submitContent(fixture, 'canonical', { text: 'same' }, 'current_turn'),
    first,
  );
  assert.deepEqual(fixture.coordinator.projection(ROOT.sessionId).steering[0]?.content, {
    text: 'same',
  });

  const retracted = await fixture.coordinator.handlers['queue.retract'](
    { originHostEpoch: 'epoch-1', sessionId: ROOT.sessionId, retractId: 'cleanup' },
    operationContext(),
  );
  assert.equal(retracted.ok, true);
  if (retracted.ok) {
    assert.deepEqual(retracted.result.retracted[0]?.content, { text: 'same' });
  }
  owner.release();
  const batch = fixture.coordinator.beginTerminalTransition(ROOT);
  fixture.coordinator.completeIdle(batch);
});

function createFixture(
  onProjectionChanged?: (sessionId: string) => void,
  preflightSessionSnapshot: HostMessageCoordinatorOptions['preflightSessionSnapshot'] = () => true,
) {
  let nextId = 1;
  let liveResidencies = 0;
  let startCalls = 0;
  let drainRequests = 0;
  let receiptReads = 0;
  let rootReads = 0;
  let stopDeliveryError: Error | undefined;
  let rootState: HostMessageRootState = { kind: 'active', ...ROOT };
  let rootStateDelay:
    | {
        readonly started: ReturnType<typeof deferred<void>>;
        readonly release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  const receipts = new Map<string, RootTurnSourceMessageReceipt>();
  const events: RuntimeEvent[] = [];
  const operationReceipts = new Map<string, MessageOperationReceipt>();
  const receiptDelays = new Map<
    string,
    {
      readonly started: ReturnType<typeof deferred<void>>;
      readonly release: ReturnType<typeof deferred<void>>;
      readonly error?: Error;
    }
  >();
  const stopClaimed = deferred<void>();
  const terminal = deferred<TurnSnapshot>();
  let coordinator: HostMessageCoordinator;
  const root: HostMessageRootPort = {
    readSessionHeader: async () => {
      rootReads += 1;
      return { isArchived: false };
    },
    readRootState: async () => {
      rootReads += 1;
      const delay = rootStateDelay;
      if (delay) {
        rootStateDelay = undefined;
        delay.started.resolve(undefined);
        await delay.release.promise;
      }
      return rootState;
    },
    claimStopFence: async (_input, commitQueueFence) => {
      commitQueueFence();
      return {
        ready: Promise.resolve(),
        deliverStop: async () => {
          stopClaimed.resolve(undefined);
          if (stopDeliveryError) throw stopDeliveryError;
        },
      };
    },
    startFromMessage: async (input) => {
      startCalls += 1;
      const turnId = 'idle-turn';
      receipts.set(
        input.sourceMessage.messageId,
        sourceReceipt(
          input.sourceMessage.messageId,
          input.sourceMessage.content,
          input.sourceMessage.placement,
          'turn_started',
          turnId,
        ),
      );
      rootState = { kind: 'active', sessionId: input.sessionId, turnId, runId: 'idle-run' };
      coordinator.reserveRootTurn(rootState);
      return { turnId };
    },
    claimStop: async (_input, commitQueueFence) => {
      commitQueueFence();
      return {
        deliverStop: () => Promise.resolve(),
        terminal: terminal.promise,
      };
    },
  };
  const options: HostMessageCoordinatorOptions = {
    hostEpoch: 'epoch-1',
    root,
    durableProof: {
      readRootTurnSourceMessageReceipt: async (_sessionId, messageId) => receipts.get(messageId),
      readImmutableSteeringMessageProof: async (_sessionId, messageId) => {
        const event = events.find(
          (candidate) =>
            candidate.partial === false &&
            candidate.refs?.providerEventId === messageId &&
            candidate.content?.kind === 'text' &&
            candidate.content.steering === true,
        );
        return event ? { event } : undefined;
      },
    },
    receipts: memoryReceiptStore(
      operationReceipts,
      async (operation, operationId) => {
        const delay = receiptDelays.get(`${operation}:${operationId}`);
        if (!delay) return;
        receiptDelays.delete(`${operation}:${operationId}`);
        delay.started.resolve(undefined);
        await delay.release.promise;
        if (delay.error) throw delay.error;
      },
      () => {
        receiptReads += 1;
      },
    ),
    sessionAdmission: new SessionAdmissionGate(),
    acquireResidency: () => {
      liveResidencies += 1;
      let released = false;
      return {
        release: () => {
          assert.equal(released, false);
          released = true;
          liveResidencies -= 1;
        },
      };
    },
    requestDrain: () => {
      drainRequests += 1;
    },
    ...(onProjectionChanged ? { onProjectionChanged } : {}),
    preflightSessionSnapshot,
    createId: () => `id-${nextId++}`,
  };
  coordinator = new HostMessageCoordinator(options);
  return {
    coordinator,
    setRootState: (state: HostMessageRootState) => {
      rootState = state;
    },
    startCalls: () => startCalls,
    events,
    receipts,
    stopClaimed,
    resolveTerminal: terminal.resolve,
    liveResidencies: () => liveResidencies,
    drainRequests: () => drainRequests,
    receiptReads: () => receiptReads,
    rootReads: () => rootReads,
    failStopDelivery: (error: Error) => {
      stopDeliveryError = error;
    },
    delayReceipt: (
      operation: 'submit' | 'retract' | 'interrupt',
      operationId: string,
      error?: Error,
    ) => {
      const delay = { started: deferred<void>(), release: deferred<void>(), error };
      receiptDelays.set(`${operation}:${operationId}`, delay);
      return delay;
    },
    delayRootState: () => {
      const delay = { started: deferred<void>(), release: deferred<void>() };
      rootStateDelay = delay;
      return delay;
    },
  };
}

function memoryReceiptStore(
  receipts: Map<string, MessageOperationReceipt>,
  beforeCommit?: (operation: string, operationId: string) => Promise<void>,
  onRead?: () => void,
): MessageReceiptStore {
  const key = (hostEpoch: string, operation: string, sessionId: string, operationId: string) =>
    `${hostEpoch}:${operation}:${sessionId}:${operationId}`;
  return {
    beginHostEpoch: async () => undefined,
    read: async (hostEpoch, operation, sessionId, operationId) => {
      onRead?.();
      return receipts.get(key(hostEpoch, operation, sessionId, operationId));
    },
    commit: async (hostEpoch, operation, sessionId, operationId, receipt) => {
      await beforeCommit?.(operation, operationId);
      const receiptKey = key(hostEpoch, operation, sessionId, operationId);
      const existing = receipts.get(receiptKey);
      if (existing) return existing;
      const snapshot = structuredClone(receipt);
      receipts.set(receiptKey, snapshot);
      return snapshot;
    },
  };
}

function submit(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  text: string,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return submitContent(fixture, messageId, { text }, placement, originHostEpoch);
}

function submitContent(
  fixture: ReturnType<typeof createFixture>,
  messageId: string,
  content: MessageContent,
  placement: 'current_turn' | 'next_turn',
  originHostEpoch = 'epoch-1',
) {
  return fixture.coordinator.handlers['turn.message.submit'](
    {
      originHostEpoch,
      sessionId: ROOT.sessionId,
      messageId,
      content,
      placement,
    },
    operationContext(),
  );
}

function sourceReceipt(
  messageId: string,
  content: MessageContent | string,
  placement: 'current_turn' | 'next_turn',
  disposition: 'steering' | 'followup' | 'turn_started',
  turnId = 'durable-turn',
): RootTurnSourceMessageReceipt {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
  const sourceMessage = { messageId, content: normalizedContent, placement, disposition };
  return {
    admission: {
      schemaVersion: 1,
      sessionId: ROOT.sessionId,
      turnId,
      runId: 'durable-run',
      userMessageId: 'durable-user-message',
      execution: { kind: 'external_message' },
      previousRootTurnId: ROOT.turnId,
      normalizedInput: normalizedContent,
      sourceMessages: [sourceMessage],
      admittedAt: 1,
    },
    sourceMessage,
  };
}

function steeringEvent(messageId: string, content: MessageContent | string): RuntimeEvent {
  const normalizedContent = typeof content === 'string' ? { text: content } : content;
  return {
    id: `event-${messageId}`,
    invocationId: 'invocation-1',
    runId: ROOT.runId,
    sessionId: ROOT.sessionId,
    turnId: ROOT.turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', ...normalizedContent, steering: true },
    refs: { providerEventId: messageId },
  };
}

function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
  };
}

function operationContext(connectionId = 'connection-1') {
  return {
    hostEpoch: 'epoch-1',
    connectionId,
    surface: 'tui' as const,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
