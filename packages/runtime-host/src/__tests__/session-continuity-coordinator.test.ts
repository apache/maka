import assert from 'node:assert/strict';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { SessionEvent, ShellRunUpdate } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  decodeHostFrame,
  encodeProtocolMessage,
  type SessionTranscriptCursor,
  type SubscriptionFrame,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  type CanonicalSessionProjection,
  SessionContinuityCoordinator,
} from '../server/session-continuity-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { SessionContinuityFrameSink } from '../server/session-continuity-service.js';
import { ClientSessionSubscription } from '../client/session-subscription.js';

const HOST_EPOCH = 'host-epoch';
const SESSION_ID = 'session-1';

test('open is an inactive publication barrier and live sequence starts at nextSequence', async () => {
  const read = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    () => read.promise,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);

  const opening = coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  const publishing = coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  read.resolve(canonical());

  const outcome = await opening;
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  await publishing;
  assert.equal(outcome.result.nextSequence, 1);
  assert.equal(Object.isFrozen(outcome.result.snapshot), true);
  assert.equal(sink.frames.length, 0);

  connection.activate(outcome.result.subscriptionId);
  await delayImmediate();
  assert.deepEqual(
    sink.frames.map((frame) => frame.sequence),
    [1],
  );
  assert.equal(sink.frames[0]?.kind, 'subscription.session_delta');

  connection.abort(outcome.result.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  assert.equal(sink.frames.length, 1);
  coordinator.close();
});

test('open snapshot includes pending Interactions from the canonical projection', async () => {
  const pending = pendingInteraction();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical({ interactions: { pending: [pending] } }),
    new SessionAdmissionGate(),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());

  const opened = await open(coordinator, 'connection-1');
  assert.deepEqual(opened.snapshot.interactions, { pending: [pending] });

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('open identifies every assistant stream that is still active and round-trips its result', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  coordinator.attachConnection('connection-1', new RecordingSink());
  await open(coordinator, 'connection-1');
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(2),
    messageId: 'message-3',
  });

  coordinator.attachConnection('connection-2', new RecordingSink());
  const active = await open(coordinator, 'connection-2');
  assert.deepEqual(active.activeAssistantStreams, [
    { kind: 'text', turnId: 'turn-1', messageId: 'message-1' },
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  const decoded = decodeHostFrame(
    JSON.parse(
      encodeProtocolMessage({
        requestId: 'open-round-trip',
        operation: 'subscription.open',
        ok: true,
        result: active,
      }).toString('utf8'),
    ),
  );
  assert.ok('ok' in decoded && decoded.ok);
  if (!('ok' in decoded) || !decoded.ok || decoded.operation !== 'subscription.open') return;
  assert.deepEqual(decoded.result.activeAssistantStreams, active.activeAssistantStreams);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'chunk-1'),
  );
  coordinator.attachConnection('connection-3', new RecordingSink());
  const remaining = await open(coordinator, 'connection-3');
  assert.deepEqual(remaining.activeAssistantStreams, [
    { kind: 'thinking', turnId: 'turn-1', messageId: 'message-2' },
    { kind: 'text', turnId: 'turn-1', messageId: 'message-3' },
  ]);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'message-2', 'reasoning'),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('message-2', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-3', 'chunk-2'),
  );
  coordinator.attachConnection('connection-4', new RecordingSink());
  const completed = await open(coordinator, 'connection-4');
  assert.deepEqual(completed.activeAssistantStreams, []);
  coordinator.close();
});

test('publishes a non-prefix final value as an authoritative replacement', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: 'draft',
  });
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    textCompleteEvent('message-1', 'final'),
  );
  await waitFor(() => sink.frames.length === 3);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            startOffset: frame.delta.startOffset,
            text: frame.delta.text,
            reset: frame.delta.reset === true,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { startOffset: 0, text: 'draft', reset: false, complete: false },
      { startOffset: 0, text: 'final', reset: true, complete: false },
      { startOffset: 5, text: '', reset: false, complete: true },
    ],
  );
  coordinator.close();
});

test('coalesces reasoning parts and completes the step before later steps continue', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-1', 'second'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'first'),
  );
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_complete', 'step-1', 'second'),
  );
  assert.equal(sink.frames.length, 2);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textCompleteEvent('step-1', ''));
  await coordinator.acceptRuntimeEvent(
    SESSION_ID,
    'run-1',
    thinkingEvent('thinking_delta', 'step-2', 'second'),
  );
  await waitFor(() => sink.frames.length === 4);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_delta'
        ? {
            messageId: frame.delta.messageId,
            text: frame.delta.text,
            complete: frame.delta.complete === true,
          }
        : frame.kind,
    ),
    [
      { messageId: 'step-1', text: 'first', complete: false },
      { messageId: 'step-1', text: 'second', complete: false },
      { messageId: 'step-1', text: '', complete: true },
      { messageId: 'step-2', text: 'second', complete: false },
    ],
  );
  coordinator.close();
});

test('terminal fence suppresses ordinary refresh until the exact terminal cut publishes', async () => {
  let projection = canonical({
    rootTurn: { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' },
  });
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => projection,
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.holdTerminalPublication(SESSION_ID, 'turn-1', 'run-1');
  projection = canonical({
    rootTurn: {
      sessionId: SESSION_ID,
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'event-terminal',
    },
  });
  await coordinator.refreshCanonical(SESSION_ID);
  assert.equal(sink.frames.length, 0);

  await coordinator.publishTerminalProjection(SESSION_ID, 'turn-1', 'run-1');
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_projection');
  if (frame?.kind === 'subscription.session_projection') {
    assert.equal(frame.sequence, 1);
    assert.equal(frame.snapshot.projectionRevision, 2);
    assert.equal(frame.snapshot.rootTurn?.status, 'completed');
  }
  coordinator.close();
});

test('detached canonical refreshes coalesce before Store I/O', async () => {
  let projection = canonical();
  let reads = 0;
  const refreshRead = deferred<void>();
  const refreshEntered = deferred<void>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) {
        refreshEntered.resolve();
        await refreshRead.promise;
      }
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  projection = canonical({ lastUsedAt: 2 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await refreshEntered.promise;
  assert.equal(reads, 2);
  refreshRead.resolve();
  await waitFor(() => sink.frames.length === 1);
  assert.equal(reads, 2);
  coordinator.close();
});

test('in-flight canonical refresh observes an invalidation after its first read', async () => {
  let projection = canonical();
  let reads = 0;
  const firstRefreshRead = deferred<CanonicalSessionProjection | null>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 2) return firstRefreshRead.promise;
      return projection;
    },
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  const stale = canonical({ lastUsedAt: 2 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  await waitFor(() => reads === 2);
  firstRefreshRead.resolve(stale);
  projection = canonical({ lastUsedAt: 3 });
  coordinator.enqueueCanonicalRefresh(SESSION_ID);

  await waitFor(() => reads === 3 && sink.frames.length === 2);
  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_projection'
        ? frame.snapshot.session.lastUsedAt
        : undefined,
    ),
    [2, 3],
  );
  coordinator.close();
});

test('reports a detached canonical publication failure to the Host lifecycle', async () => {
  let reads = 0;
  const observed = deferred<unknown>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => {
      reads += 1;
      if (reads === 1) return canonical();
      throw new Error('canonical Store read failed');
    },
    new SessionAdmissionGate(),
    (error) => observed.resolve(error),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueCanonicalRefresh(SESSION_ID);
  const failure = await observed.promise;
  assert.match(String(failure), /canonical Store read failed/);
  coordinator.close();
});

test('rejects a live event that is not owned by the canonical root', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await assert.rejects(
    coordinator.acceptRuntimeEvent(SESSION_ID, 'different-run', textEvent(1)),
    /canonical active root Turn/,
  );
  coordinator.close();
});

test('coalesces Agent graph invalidations onto the Session subscription sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'observation',
  });
  coordinator.enqueueAgentGraphChanged({
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  await waitFor(() => sink.frames.length === 1);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.agent_graph_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    rootSessionId: SESSION_ID,
    graphId: 'agent_graph_1',
    reason: 'stopped',
  });
  assert.equal(sink.frames[1]?.kind, 'subscription.session_delta');
  assert.equal(sink.frames[1]?.sequence, 2);
  coordinator.close();
});

test('coalesces typed domain invalidations without publishing continuity projections', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'task');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'task');
  coordinator.enqueueSessionDomainChanged(SESSION_ID, 'plan');
  await waitFor(() => sink.frames.length === 2);

  assert.deepEqual(
    sink.frames.map((frame) =>
      frame.kind === 'subscription.session_domain_changed'
        ? { kind: frame.kind, sequence: frame.sequence, domain: frame.domain }
        : frame.kind,
    ),
    [
      { kind: 'subscription.session_domain_changed', sequence: 1, domain: 'task' },
      { kind: 'subscription.session_domain_changed', sequence: 2, domain: 'plan' },
    ],
  );
  coordinator.close();
});

test('fans one bounded Runtime Resource burst out to an inherited Session view', async () => {
  const childSessionId = 'child-session';
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async (sessionId) => canonicalFor(sessionId),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: childSessionId },
    connectionContext('connection-1'),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  connection.activate(outcome.result.subscriptionId);
  const updates = Array.from({ length: 64 }, (_, index) => {
    const update = shellRunUpdate({
      sessionId: 'parent-session',
      sourceToolCallId: `tool-${index}`,
    });
    update.result.ref = `shell:run-${index}`;
    return update;
  });

  for (const update of updates) coordinator.enqueueRuntimeResourceChanged(update);
  await waitFor(() => sink.frames.length === 1);

  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.session_domain_changed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: outcome.result.subscriptionId,
    sequence: 1,
    sessionId: childSessionId,
    domain: 'runtime_resource',
    resources: updates.map((update) => ({
      sourceSessionId: update.sessionId,
      ref: update.result.ref,
    })),
  });
  coordinator.close();
});

test('publishes live PTY bytes on the source Session continuity sequence', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  await coordinator.enqueueRuntimeResourcePtyData({
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    sequence: 5,
    data: 'ready',
  });
  assert.deepEqual(sink.frames[0], {
    kind: 'subscription.runtime_resource_pty_data',
    hostEpoch: HOST_EPOCH,
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId: SESSION_ID,
    ref: 'maka://runtime/background-tasks/shell-1',
    ptySequence: 5,
    data: 'ready',
  });
  coordinator.close();
});

test('slow subscriber receives a terminal eviction without delaying another subscriber', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const slowSink = new RecordingSink();
  const fastSink = new RecordingSink();
  const slowConnection = coordinator.attachConnection('connection-slow', slowSink);
  const fastConnection = coordinator.attachConnection('connection-fast', fastSink);
  const slow = await open(coordinator, 'connection-slow');
  const fast = await open(coordinator, 'connection-fast');
  fastConnection.activate(fast.subscriptionId);

  for (let index = 1; index <= 32; index += 1) {
    await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(index));
  }
  slowConnection.activate(slow.subscriptionId);
  await waitFor(() => slowSink.frames.length === 1 && fastSink.frames.length === 32);

  assert.deepEqual(slowSink.frames[0], {
    kind: 'subscription.closed',
    hostEpoch: HOST_EPOCH,
    subscriptionId: slow.subscriptionId,
    sequence: 1,
    reason: 'slow_consumer',
  });
  assert.deepEqual(
    fastSink.frames.map((frame) => frame.sequence),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  coordinator.close();
});

test('removal closes every Session subscriber at the admitted sequence boundary', async () => {
  const admission = new SessionAdmissionGate();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    admission,
  );
  const desktopSink = new RecordingSink();
  const tuiSink = new RecordingSink();
  const desktop = coordinator.attachConnection('connection-desktop', desktopSink);
  const tui = coordinator.attachConnection('connection-tui', tuiSink);
  const desktopSubscription = await open(coordinator, 'connection-desktop');
  const tuiSubscription = await open(coordinator, 'connection-tui');
  desktop.activate(desktopSubscription.subscriptionId);
  tui.activate(tuiSubscription.subscriptionId);

  await admission.run(SESSION_ID, (lease) => coordinator.retireSessions([SESSION_ID], lease));
  await waitFor(() => desktopSink.frames.length === 1 && tuiSink.frames.length === 1);

  assert.deepEqual(desktopSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: desktopSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  assert.deepEqual(tuiSink.frames, [
    {
      kind: 'subscription.closed',
      hostEpoch: HOST_EPOCH,
      subscriptionId: tuiSubscription.subscriptionId,
      sequence: 1,
      reason: 'session_removed',
    },
  ]);
  coordinator.close();
});

test('a joining Client receives an immutable transcript and absolute overlapping live offsets', async () => {
  const transcript: StoredMessage[] = [assistantMessage('chunk-1')];
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    async () => transcript,
  );

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-1', sink);
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  const snapshot = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-1'),
  );
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) assert.fail('expected the transcript snapshot');
  assert.equal(snapshot.result.kind, 'chunk');
  if (snapshot.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
  assert.deepEqual(
    JSON.parse(Buffer.from(snapshot.result.data, 'base64').toString('utf8')),
    transcript[0],
  );

  transcript[0] = assistantMessage('mutated after snapshot');
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  await waitFor(() => sink.frames.length === 1);
  const live = sink.frames[0];
  assert.equal(live?.kind, 'subscription.session_delta');
  if (live?.kind === 'subscription.session_delta') {
    assert.equal(live.delta.startOffset, 'chunk-1'.length);
    assert.equal(live.delta.text, 'chunk-2');
  }
  coordinator.close();
});

test('a joining Client receives live assistant text that has not reached durable storage', async () => {
  const durable = assistantMessage('chunk-1');
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    async () => [durable],
  );

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  const snapshot = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-1'),
  );
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) assert.fail('expected the transcript snapshot');
  assert.equal(snapshot.result.kind, 'chunk');
  if (snapshot.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
  assert.deepEqual(
    JSON.parse(Buffer.from(snapshot.result.data, 'base64').toString('utf8')),
    assistantMessage('chunk-1chunk-2'),
  );
  coordinator.close();
});

test('a durable final replaces a non-prefix live draft during transcript catch-up', async () => {
  const transcript = deferred<readonly StoredMessage[]>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    () => transcript.promise,
  );

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    ...textEvent(1),
    text: 'draft',
  });
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  connection.activate(opened.subscriptionId);

  const catchUp = coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-1'),
  );
  transcript.resolve([assistantMessage('authoritative final')]);

  const snapshot = await catchUp;
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) assert.fail('expected the transcript snapshot');
  assert.equal(snapshot.result.kind, 'chunk');
  if (snapshot.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
  assert.deepEqual(
    JSON.parse(Buffer.from(snapshot.result.data, 'base64').toString('utf8')),
    assistantMessage('authoritative final'),
  );
  coordinator.close();
});

test('transcript snapshots chunk one large message and remain subscription-owned', async () => {
  const message = assistantMessage('界'.repeat(20_000));
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    async () => [message],
  );
  const owner = coordinator.attachConnection('connection-owner', new RecordingSink());
  const sibling = coordinator.attachConnection('connection-sibling', new RecordingSink());
  const opened = await open(coordinator, 'connection-owner');

  const first = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-owner'),
  );
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('expected the first transcript chunk');
  assert.equal(first.result.kind, 'chunk');
  if (first.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
  assert.ok(first.result.next, 'expected the large message to require continuation');
  if (!first.result.next) assert.fail('expected a continuation cursor');
  const chunks = [Buffer.from(first.result.data, 'base64')];
  let cursor: SessionTranscriptCursor | null = first.result.next;
  while (cursor) {
    const next = await coordinator.handlers['session.transcript.query'](
      {
        kind: 'continue',
        subscriptionId: opened.subscriptionId,
        snapshotId: first.result.snapshotId,
        ...cursor,
      },
      connectionContext('connection-owner'),
    );
    assert.equal(next.ok, true);
    if (!next.ok) assert.fail('expected a continuation transcript chunk');
    assert.equal(next.result.kind, 'chunk');
    if (next.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
    chunks.push(Buffer.from(next.result.data, 'base64'));
    cursor = next.result.next;
  }
  assert.ok(chunks.length > 1);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), message);

  const foreign = await coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-sibling'),
  );
  assert.deepEqual(foreign, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  owner.close();
  sibling.close();
  coordinator.close();
});

test('absolute live offsets survive a gap with no connected subscribers', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  const firstConnection = coordinator.attachConnection('connection-first', new RecordingSink());
  const first = await open(coordinator, 'connection-first');
  firstConnection.activate(first.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(1));
  firstConnection.close();
  await delayImmediate();

  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(2));
  const sink = new RecordingSink();
  const secondConnection = coordinator.attachConnection('connection-second', sink);
  const second = await open(coordinator, 'connection-second');
  secondConnection.activate(second.subscriptionId);
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', textEvent(3));
  await waitFor(() => sink.frames.length === 1);

  const frame = sink.frames[0];
  assert.equal(frame?.kind, 'subscription.session_delta');
  if (frame?.kind === 'subscription.session_delta') {
    assert.equal(frame.delta.startOffset, 'chunk-1'.length + 'chunk-2'.length);
  }
  coordinator.close();
});

test('an in-flight transcript read cannot outlive its owning connection', async () => {
  const transcript = deferred<readonly StoredMessage[]>();
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
    undefined,
    () => transcript.promise,
  );
  const connection = coordinator.attachConnection('connection-1', new RecordingSink());
  const opened = await open(coordinator, 'connection-1');
  const reading = coordinator.handlers['session.transcript.query'](
    { kind: 'start', subscriptionId: opened.subscriptionId },
    connectionContext('connection-1'),
  );
  await delayImmediate();
  connection.close();
  transcript.resolve([assistantMessage('late snapshot')]);

  assert.deepEqual(await reading, {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  });
  coordinator.close();
});

test('rejoin seeds tool_result_preview at the open nextSequence without sequence_gap', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());

  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-rejoin', sink);
  const opened = await open(coordinator, 'connection-rejoin');
  assert.equal(opened.nextSequence, 1);

  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(sink.frames.length, 1);
  assert.equal(sink.frames[0]?.sequence, 1);
  assert.equal(sink.frames[0]?.kind, 'subscription.session_event');
  if (sink.frames[0]?.kind !== 'subscription.session_event') return;
  assert.equal(sink.frames[0].event.type, 'tool_result_preview');

  const client = new ClientSessionSubscription(
    opened,
    async () => {},
    async () => {
      throw new Error('transcript unused');
    },
  );
  assert.doesNotThrow(() => client.accept(sink.frames[0]!));

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

test('tool_result clears retained tool_result_preview so a later open does not seed it', async () => {
  const coordinator = new SessionContinuityCoordinator(
    HOST_EPOCH,
    async () => canonical(),
    new SessionAdmissionGate(),
  );
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', previewEvent());
  await coordinator.acceptRuntimeEvent(SESSION_ID, 'run-1', {
    type: 'tool_result',
    id: 'result-1',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-1',
    isError: false,
    content: { kind: 'text', text: '' },
  });

  const sink = new RecordingSink();
  const connection = coordinator.attachConnection('connection-after-settle', sink);
  const opened = await open(coordinator, 'connection-after-settle');
  assert.equal(opened.nextSequence, 1);
  connection.activate(opened.subscriptionId);
  await delayImmediate();
  assert.equal(
    sink.frames.some(
      (frame) =>
        frame.kind === 'subscription.session_event' && frame.event.type === 'tool_result_preview',
    ),
    false,
  );

  connection.abort(opened.subscriptionId);
  coordinator.close();
});

class RecordingSink implements SessionContinuityFrameSink {
  readonly frames: SubscriptionFrame[] = [];

  async send(frame: SubscriptionFrame): Promise<void> {
    this.frames.push(frame);
  }
}

function textCompleteEvent(messageId: string, text: string) {
  return {
    type: 'text_complete' as const,
    id: `text_complete-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

async function open(coordinator: SessionContinuityCoordinator, connectionId: string) {
  const outcome = await coordinator.handlers['subscription.open'](
    { sessionId: SESSION_ID },
    connectionContext(connectionId),
  );
  if (!outcome.ok) throw new Error(outcome.error.message);
  assert.equal(outcome.ok, true);
  return outcome.result;
}

function connectionContext(connectionId: string): ConnectionContext {
  return {
    hostEpoch: HOST_EPOCH,
    connectionId,
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
}

function canonical(
  overrides: {
    lastUsedAt?: number;
    rootTurn?: CanonicalSessionProjection['rootTurn'];
    interactions?: CanonicalSessionProjection['interactions'];
  } = {},
): CanonicalSessionProjection {
  return {
    session: {
      sessionId: SESSION_ID,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      lastUsedAt: overrides.lastUsedAt ?? 1,
      isArchived: false,
    },
    rootTurn:
      overrides.rootTurn === undefined
        ? { sessionId: SESSION_ID, turnId: 'turn-1', runId: 'run-1', status: 'running' }
        : overrides.rootTurn,
    goal: null,
    queue: {
      hostEpoch: HOST_EPOCH,
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: overrides.interactions ?? { pending: [] },
  };
}

function canonicalFor(sessionId: string): CanonicalSessionProjection {
  const projection = canonical();
  return {
    ...projection,
    session: { ...projection.session, sessionId },
    rootTurn: projection.rootTurn ? { ...projection.rootTurn, sessionId } : null,
  };
}

function shellRunUpdate(overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: SESSION_ID,
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    result: {
      kind: 'shell_run',
      ref: 'shell:run-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout: 'ready',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
    ...overrides,
  };
}

function pendingInteraction() {
  return {
    schemaVersion: 1 as const,
    interactionId: 'interaction-1',
    sessionId: SESSION_ID,
    turnId: 'turn-1',
    runId: 'run-1',
    revision: 1 as const,
    request: {
      kind: 'question' as const,
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Continue execution' },
            { label: 'No', description: 'Stop execution' },
          ],
        },
      ],
    },
    status: 'pending' as const,
    outcome: null,
  };
}

function textEvent(index: number) {
  return {
    type: 'text_delta' as const,
    id: `event-${index}`,
    turnId: 'turn-1',
    ts: index,
    messageId: 'message-1',
    text: `chunk-${index}`,
  };
}

function thinkingEvent(
  type: 'thinking_delta' | 'thinking_complete',
  messageId: string,
  text: string,
) {
  return {
    type,
    id: `${type}-${messageId}`,
    turnId: 'turn-1',
    ts: 1,
    messageId,
    text,
  };
}

function previewEvent() {
  return {
    type: 'tool_result_preview' as const,
    id: 'preview-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent' as const,
      childSessionId: 'child-1',
      agentName: 'Local Read',
      turnId: 'child-turn',
      status: 'running' as const,
      permissionMode: 'explore' as const,
    },
  };
}

function assistantMessage(text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'test-model',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delayImmediate();
  }
  throw new Error('Timed out waiting for continuity state');
}
